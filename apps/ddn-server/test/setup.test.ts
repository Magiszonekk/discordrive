// discordrive setup / doctor / invite: non-interactive runs, a scripted
// interactive run through the real prompter (piped stdin), and the server
// side of invites, limits and health.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountHttp, generateDeviceKey, newAccountKey } from "@ddv4/metadata-client";
import { FakeDiscord } from "@ddv4/metadata-client/node";
import { configPath, loadConfig } from "../src/config.js";
import { doctor, invite } from "../src/doctor.js";
import { ttyPrompter } from "../src/prompt.js";
import { serve } from "../src/serve.js";
import { setup } from "../src/setup.js";
import { setupFlags } from "../src/cli.js";

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-setup-"));
const quiet = () => {
  const out: string[] = [];
  const p = ttyPrompter(new PassThrough(), new PassThrough());
  return { out, p: { ...p, say: (s = "") => void out.push(s) } };
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

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("discordrive setup (non-interactive)", () => {
  it("writes one 0600 config in a 0700 dir, makes an invite, passes its own health self-test", async () => {
    const dir = tmp();
    const port = await freePort();
    const { p, out } = quiet();
    const r = await setup({ yes: true, dataDir: dir, port, publicUrl: `http://127.0.0.1:${port}`, systemd: false }, p);
    expect(r.selfTest).toMatchObject({ ok: true });
    expect(r.invite?.code).toMatch(/^ddn-inv-[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const c = loadConfig(dir);
    expect(c).toMatchObject({ mode: "metadata-only", signup: "invite", bind: { host: "127.0.0.1", port }, botToken: null });
    expect(out.join("\n")).toContain("Kod zaproszenia");
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
    const r = await setup({ yes: true, dataDir: dir, port, publicUrl: `http://127.0.0.1:${port}`, botTokenFile: tf, systemd: false, discordApiOrigin: fake.origin }, p);
    expect(r.config.bot).toEqual({ id: "1550000000000000001", username: "fake-bot" });
    expect(readFileSync(configPath(dir), "utf8")).toContain(fake.botToken);
    expect(out.join("\n")).not.toContain(fake.botToken);
    // A bad token is refused, the config is not written.
    writeFileSync(tf, "nope");
    const dir2 = tmp();
    await expect(setup({ yes: true, dataDir: dir2, port, publicUrl: `http://127.0.0.1:${port}`, botTokenFile: tf, systemd: false, discordApiOrigin: fake.origin }, quiet().p)).rejects.toThrow(/token/);
    expect(() => loadConfig(dir2)).toThrow(/Brak konfiguracji/);
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
    await setup({ yes: true, dataDir: dir, port, publicUrl: "https://dysk.example.com", host: "127.0.0.1", trustProxy: ["127.0.0.1"], botTokenFile: tf, systemd: false, selfTest: false, discordApiOrigin: fake.origin }, quiet().p);
    await setup({ yes: true, dataDir: dir, signup: "closed", systemd: false, selfTest: false, discordApiOrigin: fake.origin }, quiet().p);
    const c = loadConfig(dir);
    expect(c).toMatchObject({ publicUrl: "https://dysk.example.com", trustProxy: ["127.0.0.1"], signup: "closed", botToken: fake.botToken, bind: { port } });
  });

  it("refuses a busy port in --yes mode and a bind address that is not on this machine", async () => {
    const { createServer } = await import("node:net");
    const s = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    cleanups.push(() => void s.close());
    const port = (s.address() as { port: number }).port;
    await expect(setup({ yes: true, dataDir: tmp(), port, systemd: false }, quiet().p)).rejects.toThrow(/zajęty/);
    await expect(setup({ yes: true, dataDir: tmp(), host: "203.0.113.7", systemd: false }, quiet().p)).rejects.toThrow(/nie jest adresem/);
  });

  it("flags and answers file; --bot-token on the command line is refused", () => {
    const dir = tmp();
    const af = join(dir, "answers.json");
    writeFileSync(af, JSON.stringify({ publicUrl: "https://x.example", port: 4000, trustProxy: ["192.0.2.1"], signup: "open", systemd: false }));
    expect(setupFlags({ yes: true, answers: af, port: "4001" })).toMatchObject({ yes: true, publicUrl: "https://x.example", port: 4001, trustProxy: ["192.0.2.1"], signup: "open", systemd: false });
    expect(() => setupFlags({ "bot-token": "x" })).toThrow(/niedozwolony/);
  });
});

describe("discordrive setup (interactive, scripted stdin)", () => {
  it("walks the six steps with Enter for defaults, and the result serves", async () => {
    const dir = tmp();
    const port = await freePort();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (d) => (text += String(d)));
    // dataDir, mode (Enter), URL, host (Enter), port, bot (Enter = skip), signup (Enter = invite), save (Enter), invite (Enter), systemd (n)
    input.write([dir, "", `http://127.0.0.1:${port}`, "", String(port), "", "", "", "", "n", ""].join("\n"));
    const p = ttyPrompter(input, output);
    const r = await setup({}, p);
    p.close();
    expect(text).toContain("1/6 Tryb instancji");
    expect(text).toContain("e2ee: wkrótce");
    expect(text).toContain("5/6 Bot instancji");
    expect(text).toContain("6/6 Kto może zakładać konta");
    expect(r.selfTest?.ok).toBe(true);
    expect(r.invite).not.toBeNull();
    expect(loadConfig(dir).bind.port).toBe(port);
  });
});

describe("instance server: invites, limits, health, web app", () => {
  it("invite-only sign-up: no code / bad code 403, good code once, then used", async () => {
    const dir = tmp();
    const port = await freePort();
    await setup({ yes: true, dataDir: dir, port, publicUrl: `http://127.0.0.1:${port}`, systemd: false, selfTest: false, invite: false }, quiet().p);
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
    expect(h).toMatchObject({ ok: true, service: "discordrive-next", mode: "metadata-only", signup: "invite", shares: false });
    expect(typeof h.uptimeS).toBe("number");
    const page = await fetch(`${url}/s/AAAAAAAAAAAAAAAAAAAAAA`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
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
    await setup({ yes: true, dataDir: dir, port, publicUrl: `http://127.0.0.1:${port}`, systemd: false, selfTest: false }, quiet().p);
    const srv = await serve(loadConfig(dir), () => {});
    cleanups.push(() => srv.close());
    const lines: string[] = [];
    const d = await doctor(dir, (s) => lines.push(s));
    expect(d.ok).toBe(true);
    expect(lines.join("\n")).toContain("health lokalnie: wersja");
    const { chmodSync } = await import("node:fs");
    chmodSync(configPath(dir), 0o644);
    expect((await doctor(dir, () => {})).ok).toBe(false);
  });
});
