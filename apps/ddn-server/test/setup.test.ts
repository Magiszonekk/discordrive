// discordrive setup / doctor / invite: non-interactive runs, a scripted
// interactive run through the real prompter (piped stdin), and the server
// side of invites, limits and health.
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountHttp, generateDeviceKey, newAccountKey } from "@ddv4/metadata-client";
import { FakeDiscord } from "@ddv4/metadata-client/node";
import { REPO_DIR, RISK_VERSION, configPath, loadConfig } from "../src/config.js";
import { doctor, invite } from "../src/doctor.js";
import { Cancelled, ttyPrompter } from "../src/prompt.js";
import { serve } from "../src/serve.js";
import { THREAT_MODEL_DOC, setup } from "../src/setup.js";
import { main, setupFlags } from "../src/cli.js";

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-setup-"));
const quiet = () => {
  const out: string[] = [];
  const o = new PassThrough();
  o.on("data", (d) => out.push(...String(d).replace(/\n$/, "").split("\n")));
  const p = ttyPrompter(new PassThrough(), o);
  return { out, p };
};
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}

// Tests must never touch the real instance's data directory (default when unset).
process.env.XDG_DATA_HOME = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-xdg-"));
process.env.DISCORDRIVE_NO_AUTOSTART = "1"; // never touch the background start of a running instance

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("discordrive setup (non-interactive)", () => {
  it("default = this computer only: localhost, bind 127.0.0.1, open sign-up, 0600 config in a 0700 dir, health self-test", async () => {
    const dir = tmp();
    const port = await freePort();
    const { p, out } = quiet();
    const r = await setup({ yes: true, acceptRisk: true, dataDir: dir, port, autostart: false }, p);
    expect(r.selfTest).toMatchObject({ ok: true });
    expect(r.invite).toBeNull();
    if (process.platform !== "win32") {
      // POSIX modes; on Windows NTFS permissions are inherited from the profile (doctor reports them).
      expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    const c = loadConfig(dir);
    expect(c).toMatchObject({ mode: "metadata-only", signup: "open", publicUrl: `http://localhost:${port}`, bind: { host: "127.0.0.1", port }, botToken: null });
    const text = out.join("\n");
    expect(text).toContain(`Start the drive (npm start) and open:  http://localhost:${port}`);
    expect(c.language).toBe("en");
    expect(text).toContain("npm run doctor");
  });

  it("public instance (https URL): sign-up by invite by default, invite printed", async () => {
    const dir = tmp();
    const port = await freePort();
    const { p, out } = quiet();
    const r = await setup({ yes: true, acceptRisk: true, dataDir: dir, port, publicUrl: "https://dysk.example.com", autostart: false }, p);
    expect(r.invite?.code).toMatch(/^ddn-inv-[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(loadConfig(dir)).toMatchObject({ signup: "invite", publicUrl: "https://dysk.example.com" });
    expect(out.join("\n")).toContain("invite code: ddn-inv-");
    expect(out.join("\n")).toContain("proxy_pass http://127.0.0.1:");
  });

  it("platform data directories (no POSIX paths baked in)", async () => {
    const { defaultDataDir } = await import("../src/config.js");
    const { join } = await import("node:path");
    expect(defaultDataDir("linux", {}, "/h")).toBe(join("/h", ".local", "share", "discordrive-next"));
    expect(defaultDataDir("linux", { XDG_DATA_HOME: "/x" }, "/h")).toBe(join("/x", "discordrive-next"));
    expect(defaultDataDir("darwin", {}, "/Users/a")).toBe(join("/Users/a", "Library", "Application Support", "discordrive-next"));
    expect(defaultDataDir("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "C:\\Users\\a")).toBe(join("C:\\Users\\a\\AppData\\Local", "discordrive-next"));
    expect(defaultDataDir("win32", {}, "C:\\Users\\a")).toBe(join("C:\\Users\\a", "AppData", "Local", "discordrive-next"));
    expect(defaultDataDir("linux", { DISCORDRIVE_DATA_DIR: "/d" }, "/h")).toBe("/d");
  });

  // chmod does not make a directory read-only on Windows (NTFS ACLs); root ignores modes.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses a data dir it cannot write, with a human message", async () => {
    const { chmodSync, mkdirSync } = await import("node:fs");
    const ro = join(tmp(), "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    cleanups.push(() => chmodSync(ro, 0o700));
    await expect(setup({ yes: true, acceptRisk: true, dataDir: join(ro, "data"), port: await freePort(), autostart: false }, quiet().p)).rejects.toThrow(/no permission to write/);
  });

  it("validates the bot token against Discord (GET /users/@me), stores it 0600 and never prints it", async () => {
    const fake = new FakeDiscord();
    await fake.listen();
    cleanups.push(() => fake.close());
    fake.botToken = "fake-bot-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ.1234567890";
    const dir = tmp();
    const tf = join(dir, "..", `tok-${Date.now()}`);
    writeFileSync(tf, fake.botToken + "\n", { mode: 0o600 });
    const port = await freePort();
    const { p, out } = quiet();
    const r = await setup({ yes: true, acceptRisk: true, dataDir: dir, port, publicUrl: `http://127.0.0.1:${port}`, botTokenFile: tf, autostart: false, discordApiOrigin: fake.origin }, p);
    expect(r.config.bot).toEqual({ id: "1550000000000000001", username: "fake-bot" });
    expect(readFileSync(configPath(dir), "utf8")).toContain(fake.botToken);
    expect(out.join("\n")).not.toContain(fake.botToken);
    // A bad token is refused, the config is not written.
    writeFileSync(tf, "nope");
    const dir2 = tmp();
    await expect(setup({ yes: true, acceptRisk: true, dataDir: dir2, port, publicUrl: `http://127.0.0.1:${port}`, botTokenFile: tf, autostart: false, discordApiOrigin: fake.origin }, quiet().p)).rejects.toThrow(/token/);
    expect(() => loadConfig(dir2)).toThrow(/No configuration/);
  });

  it("re-run keeps current values and the saved bot token unless told to replace it", async () => {
    const fake = new FakeDiscord();
    await fake.listen();
    cleanups.push(() => fake.close());
    fake.botToken = "fake-bot-token-0000000000000000000000000000.keep";
    const dir = tmp();
    const tf = join(dir, "..", `tok2-${Date.now()}`);
    writeFileSync(tf, fake.botToken);
    const port = await freePort();
    await setup({ yes: true, acceptRisk: true, dataDir: dir, port, publicUrl: "https://dysk.example.com", host: "127.0.0.1", trustProxy: ["127.0.0.1"], botTokenFile: tf, autostart: false, selfTest: false, discordApiOrigin: fake.origin }, quiet().p);
    await setup({ yes: true, acceptRisk: true, dataDir: dir, signup: "closed", autostart: false, selfTest: false, discordApiOrigin: fake.origin }, quiet().p);
    const c = loadConfig(dir);
    expect(c).toMatchObject({ publicUrl: "https://dysk.example.com", trustProxy: ["127.0.0.1"], signup: "closed", botToken: fake.botToken, bind: { port } });
  });

  it("refuses a busy port in --yes mode and a bind address that is not on this machine", async () => {
    const net = await import("node:net");
    const s0 = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => s0.once("listening", r));
    cleanups.push(() => void s0.close());
    const busy = (s0.address() as { port: number }).port;
    // `discordrive start` on a busy port: a human message, not an unhandled 'error' event.
    const { main } = await import("../src/cli.js");
    const dir0 = tmp();
    await setup({ yes: true, acceptRisk: true, dataDir: dir0, port: await freePort(), autostart: false, selfTest: false }, quiet().p);
    const cfg = JSON.parse(readFileSync(configPath(dir0), "utf8"));
    cfg.bind.port = busy;
    writeFileSync(configPath(dir0), JSON.stringify(cfg));
    const errs: string[] = [];
    const orig = console.error;
    console.error = (m: string) => void errs.push(m);
    try {
      expect(await main(["start", "--data-dir", dir0])).toBe(1);
    } finally {
      console.error = orig;
    }
    expect(errs.join("\n")).toMatch(new RegExp(`port ${busy} is used by another program`));
    const { createServer } = await import("node:net");
    const s = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    cleanups.push(() => void s.close());
    const port = (s.address() as { port: number }).port;
    await expect(setup({ yes: true, acceptRisk: true, dataDir: tmp(), port, autostart: false }, quiet().p)).rejects.toThrow(/in use/);
    await expect(setup({ yes: true, acceptRisk: true, dataDir: tmp(), host: "203.0.113.7", autostart: false }, quiet().p)).rejects.toThrow(/is not an address/);
  });

  it("flags and answers file; --bot-token on the command line is refused", () => {
    const dir = tmp();
    const af = join(dir, "answers.json");
    writeFileSync(af, JSON.stringify({ publicUrl: "https://x.example", port: 4000, trustProxy: ["192.0.2.1"], signup: "open", autostart: false }));
    expect(setupFlags({ yes: true, answers: af, port: "4001" })).toMatchObject({ yes: true, publicUrl: "https://x.example", port: 4001, trustProxy: ["192.0.2.1"], signup: "open", autostart: false });
    expect(() => setupFlags({ "bot-token": "x" })).toThrow(/not allowed/);
    expect(setupFlags({ lang: "pl" }).lang).toBe("pl");
    expect(() => setupFlags({ lang: "de" })).toThrow(/en or pl/);
    // The risk notice: only an explicit flag / answers entry accepts it, --yes alone does not.
    expect(setupFlags({ yes: true }).acceptRisk).toBe(false);
    expect(setupFlags({ yes: true, "accept-risk": true }).acceptRisk).toBe(true);
    const af2 = join(dir, "answers2.json");
    writeFileSync(af2, JSON.stringify({ acceptRisk: true }));
    expect(setupFlags({ yes: true, answers: af2 }).acceptRisk).toBe(true);
  });
});

describe("risk notice (Discord's Terms of Service, no warranty)", () => {
  it("--yes without --accept-risk: refused before anything is written", async () => {
    const dir = tmp();
    await expect(setup({ yes: true, dataDir: dir, port: await freePort(), autostart: false, selfTest: false }, quiet().p)).rejects.toThrow(/--accept-risk/);
    expect(existsSync(configPath(dir))).toBe(false);
  });

  it("interactive: Enter alone = Cancel (nothing saved); 1 = accepted, saved with version and time; not asked again", async () => {
    const dir = tmp();
    const port = await freePort();
    process.env.DISCORDRIVE_DATA_DIR = dir;
    cleanups.push(() => void delete process.env.DISCORDRIVE_DATA_DIR);
    const run = async (answers: string[]) => {
      const input = new PassThrough();
      const output = new PassThrough();
      let text = "";
      output.on("data", (d) => (text += String(d)));
      input.write(answers.join("\n"));
      const p = ttyPrompter(input, output);
      try {
        return { r: await setup({ selfTest: false, autostart: false, start: false }, p).catch((e: Error) => e), text };
      } finally {
        p.close();
      }
    };
    const a = await run(["", "", ""]);
    expect(a.r).toBeInstanceOf(Cancelled);
    expect(a.text).toContain("Storing files on Discord is against Discord's Terms of Service");
    expect(a.text).toContain("without warranty of any kind");
    expect(a.text).toContain("2) Cancel  (default)");
    expect(existsSync(configPath(dir))).toBe(false);
    const b = await run(["", "1", "", String(port), "", "", dir, "y", "", "", ""]);
    expect(b.r).not.toBeInstanceOf(Error);
    const c = loadConfig(dir);
    expect(c.acceptedRisk).toMatchObject({ version: RISK_VERSION });
    expect(Date.now() - Date.parse(c.acceptedRisk!.at)).toBeLessThan(60_000);
    // Second run: no risk question (answers shift by one).
    const d = await run(["", "", String(port), "", "", dir, "y", "", ""]);
    expect(d.r).not.toBeInstanceOf(Error);
    expect(d.text).not.toContain("Terms of Service");
    expect(loadConfig(dir).acceptedRisk).toEqual(c.acceptedRisk);
  });

  it("start and doctor refuse a config without the current acceptance (old file or older text version)", async () => {
    const dir = tmp();
    const port = await freePort();
    await setup({ yes: true, acceptRisk: true, dataDir: dir, port, autostart: false, selfTest: false }, quiet().p);
    const raw = JSON.parse(readFileSync(configPath(dir), "utf8"));
    for (const acceptedRisk of [undefined, { version: RISK_VERSION - 1, at: "2026-01-01T00:00:00.000Z" }]) {
      writeFileSync(configPath(dir), JSON.stringify({ ...raw, acceptedRisk }));
      const lines: string[] = [];
      const d = await doctor(dir, (s) => lines.push(s));
      expect(d.ok).toBe(false);
      expect(lines.join("\n")).toMatch(/risk accepted: .*npm run setup/s);
      const errs: string[] = [];
      const orig = console.error;
      console.error = (s: string) => void errs.push(s);
      try {
        expect(await main(["start", "--data-dir", dir])).toBe(1);
      } finally {
        console.error = orig;
      }
      expect(errs.join("\n")).toContain("npm run setup");
    }
  });
});

describe("discordrive setup (interactive, scripted stdin)", () => {
  it("Enter everywhere = English, local instance; the bot step explains what skipping loses and how to add it later", async () => {
    const dir = tmp();
    const port = await freePort();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (d) => (text += String(d)));
    // language (Enter = English), scenario (Enter = local), port, mode (Enter), bot (Enter = skip), data dir, save (y), [systemd: Enter = no], start now (n)
    const { detectBackend } = await import("../src/autostart.js");
    const systemdAvailable = () => detectBackend() !== "none";
    // …save (y), first account = admin (Enter = yes), …
    input.write(["", "1", "", String(port), "", "", dir, "y", "", ...(systemdAvailable() ? [""] : []), "n", ""].join("\n"));
    const p = ttyPrompter(input, output);
    // The default data dir comes from DISCORDRIVE_DATA_DIR (never the real user's one in tests).
    process.env.DISCORDRIVE_DATA_DIR = join(tmp(), "default");
    cleanups.push(() => void delete process.env.DISCORDRIVE_DATA_DIR);
    const r = await setup({}, p);
    p.close();
    expect(text).toContain("Language / Język");
    expect(text).toContain("1) English  (default)");
    expect(text).toContain("Checking requirements");
    expect(text).toContain("Only on this computer");
    // Mode step (stage 3): e2ee selectable, metadata only stays the default (Enter).
    expect(text).toContain("e2ee: files and names encrypted in the browser");
    // One "what the server sees" line under every mode + the threat model chapter of the chosen one.
    expect(text).toContain("The server sees: accounts, device public keys");
    expect(text).toContain("The server sees: the same plus the webhooks");
    expect(text).toContain("The server sees: everything (files, names, folders, file keys).");
    expect(text).toMatch(/What the server and others can do in this mode: .*threat-model\.md, section 3/);
    expect(existsSync(join(REPO_DIR, THREAT_MODEL_DOC))).toBe(true);
    expect(r.config.mode).toBe("metadata-only");
    expect(text).toContain("Skip for now");
    expect(text).toContain("Without a bot: no link sharing");
    expect(text).toContain("To turn it on later: npm run setup");
    expect(text).toContain("Accounts: sign-up is open");
    expect(text).toContain("Connect a Discord channel");
    expect(text).toContain("Save? [Y/n]");
    expect(text).toContain("Start the drive now, in this window? [Y/n]");
    // Only the bilingual language question may contain Polish letters.
    expect(text.replace("Language / Język", "")).not.toMatch(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/);
    expect(text).not.toMatch(/\[T\/n\]|\[t\/N\]/);
    expect(r.selfTest?.ok).toBe(true);
    expect(r.invite).toBeNull();
    expect(loadConfig(dir)).toMatchObject({ publicUrl: `http://localhost:${port}`, signup: "open", bind: { port }, language: "en" });
  });

  it("Polish (second option of the first question): Polish texts, still [Y/n], accepts t/tak; saved language is the next default", async () => {
    const dir = tmp();
    const port = await freePort();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (d) => (text += String(d)));
    const { detectBackend } = await import("../src/autostart.js");
    const systemdAvailable = () => detectBackend() !== "none";
    // language 2 = Polski, scenario, port, mode, bot, data dir, save: "x" (invalid) then "tak", [systemd: nie], start now: n
    input.write(["2", "1", "", String(port), "", "", dir, "x", "tak", "", ...(systemdAvailable() ? ["nie"] : []), "n", ""].join("\n"));
    const p = ttyPrompter(input, output);
    process.env.DISCORDRIVE_DATA_DIR = join(tmp(), "default");
    cleanups.push(() => void delete process.env.DISCORDRIVE_DATA_DIR);
    await setup({}, p);
    p.close();
    expect(text).toContain("Sprawdzam wymagania");
    expect(text).toContain("Tylko na tym komputerze");
    expect(text).toContain("Zapisać? [Y/n]");
    expect(text).toContain("Odpowiedz y (tak) albo n (nie).");
    expect(text).toContain("Podłącz kanał Discorda");
    expect(text).not.toMatch(/\[T\/n\]|\[t\/N\]/);
    expect(loadConfig(dir).language).toBe("pl");
    // Re-run: Enter on the language question keeps Polish.
    const in2 = new PassThrough();
    const out2 = new PassThrough();
    let text2 = "";
    out2.on("data", (d) => (text2 += String(d)));
    in2.write(["", "", String(port), "", "", dir, "", ...(systemdAvailable() ? [""] : []), "n", ""].join("\n"));
    const p2 = ttyPrompter(in2, out2);
    await setup({ dataDir: dir }, p2);
    p2.close();
    expect(text2).toContain("2) Polski  (domyślnie)");
    expect(text2).toContain("Podsumowanie");
  });

  it("--lang skips the question; English mode does not accept t/tak", async () => {
    const dir = tmp();
    const port = await freePort();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (d) => (text += String(d)));
    const { detectBackend } = await import("../src/autostart.js");
    const systemdAvailable = () => detectBackend() !== "none";
    // scenario, port, mode, bot, data dir, save: "t" (not accepted in English) then "yes", [systemd], start: no
    input.write(["1", "", String(port), "", "", dir, "t", "yes", "", ...(systemdAvailable() ? ["no"] : []), "no", ""].join("\n"));
    const p = ttyPrompter(input, output);
    process.env.DISCORDRIVE_DATA_DIR = join(tmp(), "default");
    cleanups.push(() => void delete process.env.DISCORDRIVE_DATA_DIR);
    await setup({ lang: "en" }, p);
    p.close();
    expect(text).not.toContain("Language / Język");
    expect(text).toContain("Answer y (yes) or n (no).");
    expect(loadConfig(dir).language).toBe("en");
  });

  it("bot step 'configure now' shows the developer-portal guide and validates the pasted token", async () => {
    const fake = new FakeDiscord();
    await fake.listen();
    cleanups.push(() => fake.close());
    fake.botToken = "fake-bot-token-interactive-000000000000000000.x";
    const dir = tmp();
    const port = await freePort();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (d) => (text += String(d)));
    const { detectBackend } = await import("../src/autostart.js");
    const systemdAvailable = () => detectBackend() !== "none";
    // language, scenario, port, mode, bot: 2 = now, wrong token, right token, data dir, save, [systemd], start now: n
    input.write(["", "1", "", String(port), "", "2", "wrong", fake.botToken, dir, "", "", ...(systemdAvailable() ? [""] : []), "n", ""].join("\n"));
    const p = ttyPrompter(input, output);
    process.env.DISCORDRIVE_DATA_DIR = join(tmp(), "default");
    cleanups.push(() => void delete process.env.DISCORDRIVE_DATA_DIR);
    const r = await setup({ discordApiOrigin: fake.origin }, p);
    p.close();
    expect(text).toContain("discord.com/developers/applications");
    expect(text).toContain("Reset Token");
    expect(text).toContain("The token does not work");
    expect(text).not.toContain(fake.botToken);
    expect(r.config.bot?.username).toBe("fake-bot");
  });
});

describe("instance server: invites, limits, health, web app", () => {
  it("invite-only sign-up: no code / bad code 403, good code once, then used", async () => {
    const dir = tmp();
    const port = await freePort();
    await setup({ yes: true, acceptRisk: true, dataDir: dir, port, publicUrl: `http://127.0.0.1:${port}`, signup: "invite", autostart: false, selfTest: false, invite: false }, quiet().p);
    const srv = await serve(loadConfig(dir), () => {});
    cleanups.push(() => srv.close());
    const url = `http://127.0.0.1:${port}`;
    const mk = async (inv?: string) => createAccountHttp(url, await generateDeviceKey(), newAccountKey(), undefined, inv);
    await expect(mk()).rejects.toThrow(/invite_required/);
    await expect(mk("ddn-inv-AAAA-BBBB-CCCC-DDDD")).rejects.toThrow(/invite_required/);
    const code = invite(dir).code;
    const a = await mk(code.toLowerCase().replace(/-/g, " ")); // forgiving input
    expect(a.accountId).toMatch(/^acct-/);
    await expect(mk(code)).rejects.toThrow(/invite_required/);

    const h = (await (await fetch(`${url}/v1/health`)).json()) as Record<string, unknown>;
    expect(h).toMatchObject({ ok: true, service: "discordrive-next", mode: "metadata-only", signup: "invite", shares: false, language: "en" });
    expect(typeof h.uptimeS).toBe("number");
    const page = await fetch(`${url}/s/AAAAAAAAAAAAAAAAAAAAAA`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // File preview: PDFs in a blob: frame only; plugins stay off.
    expect(page.headers.get("content-security-policy")).toContain("frame-src 'self' blob:;");
    expect(page.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(await page.text()).toContain("<html");
    for (const evil of ["/..%2f..%2f..%2fetc%2fpasswd", "/%2e%2e/%2e%2e/etc/passwd.txt", "/../../package.json"]) {
      const { request } = await import("node:http");
      const body = await new Promise<string>((ok) =>
        request({ host: "127.0.0.1", port, path: evil }, (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => ok(`${res.statusCode} ${b}`));
        }).end(),
      );
      expect(body).not.toMatch(/root:|"workspaces"/);
    }
    expect((await fetch(`${url}/v1/nope`)).status).toBe(401); // API paths never fall through to the web app
    const cfg = await (await fetch(`${url}/config.js`)).text();
    expect(cfg).toContain(`"serverUrl":"${url}"`);
    expect(cfg).not.toMatch(/token/i);
    expect(cfg).toContain(`"language":"en"`);
    // New account without a vault: GET /v1/vault answers 200 with an empty state (no 404 in the browser console).
    const { HttpApi } = await import("@ddv4/metadata-client");
    const dk = await generateDeviceKey();
    const acct = await createAccountHttp(url, dk, newAccountKey(), undefined, invite(dir).code);
    const api = new HttpApi({ baseUrl: url, accountId: acct.accountId, deviceId: acct.deviceId, key: dk });
    const raw = await fetch(`${url}/v1/vault`, { headers: { authorization: "Bearer " + (await api.session()) } });
    expect(raw.status).toBe(200);
    expect(await raw.json()).toEqual({ revision: 0, blob: null });
    expect(await api.get()).toBeNull();
  });

  it("per-IP limit on challenges; X-Forwarded-For is honoured only from a trusted proxy", async () => {
    const { DdnServer } = await import("@ddv4/metadata-client/node");
    const mk = async (trustProxy: string[]) => {
      const s = new DdnServer({ rateLimits: { auth: { burst: 3, perMin: 1 } }, trustProxy });
      cleanups.push(() => s.close());
      return (await s.listen(0)).url;
    };
    const hit = (u: string, xff?: string) => fetch(`${u}/v1/auth/challenge`, { method: "POST", headers: xff ? { "x-forwarded-for": xff } : {} }).then((r) => r.status);
    const untrusted = await mk([]);
    expect([await hit(untrusted, "1.1.1.1"), await hit(untrusted, "2.2.2.2"), await hit(untrusted, "3.3.3.3"), await hit(untrusted, "4.4.4.4")]).toEqual([200, 200, 200, 429]);
    const trusted = await mk(["127.0.0.1"]);
    const seq = [];
    for (let i = 0; i < 4; i++) seq.push(await hit(trusted, "5.5.5.5"));
    expect(seq).toEqual([200, 200, 200, 429]);
    expect(await hit(trusted, "6.6.6.6")).toBe(200); // a different client behind the same proxy
    const r = await fetch(`${trusted}/v1/auth/challenge`, { method: "POST", headers: { "x-forwarded-for": "5.5.5.5" } });
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("doctor: green on a running instance, red on a broken config file mode", async () => {
    const dir = tmp();
    const port = await freePort();
    await setup({ yes: true, acceptRisk: true, dataDir: dir, port, publicUrl: `http://127.0.0.1:${port}`, autostart: false, selfTest: false }, quiet().p);
    const srv = await serve(loadConfig(dir), () => {});
    cleanups.push(() => srv.close());
    const lines: string[] = [];
    const d = await doctor(dir, (s) => lines.push(s));
    expect(d.ok).toBe(true);
    expect(lines.join("\n")).toContain("local health: version");
    if (process.platform !== "win32") {
      const { chmodSync } = await import("node:fs");
      chmodSync(configPath(dir), 0o644);
      expect((await doctor(dir, () => {})).ok).toBe(false);
    } else expect(lines.join("\n")).toContain("file permissions: Windows");
  });
});
