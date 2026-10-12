// The arrow-key wizard in a real pseudo-terminal (`script` from util-linux):
// key sequences in, screen text out. Skipped where `script` is missing.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeDiscord } from "@ddv4/metadata-client/node";

const BIN = join(__dirname, "..", "bin", "discordrive.mjs");
const hasScript = spawnSync("script", ["--version"]).status === 0 && process.platform === "linux";
const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", ctrlC: "\x03", backspace: "\x7f" };
// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}

interface Term {
  /** Everything printed so far, without ANSI codes. */
  text(): string;
  raw(): string;
  /** Wait until the screen text (after `from`) matches. */
  until(re: RegExp, ms?: number): Promise<void>;
  send(...keys: string[]): Promise<void>;
  exit: Promise<number>;
  proc: ChildProcess;
}

const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
});

function term(args: string[], env: Record<string, string>): Term {
  const cmd = [process.execPath, BIN, "setup", ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  // A fixed terminal size: script's pty would otherwise be 0x0 (one char per line).
  const proc = spawn("script", ["-qfec", `stty cols 120 rows 50; exec ${cmd}`, "/dev/null"], {
    env: { ...process.env, TERM: "xterm-256color", DISCORDRIVE_NO_AUTOSTART: "1", CI: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  procs.push(proc);
  let out = "";
  proc.stdout!.on("data", (d) => (out += String(d)));
  proc.stderr!.on("data", (d) => (out += String(d)));
  const exit = new Promise<number>((r) => proc.on("exit", (c) => r(c ?? -1)));
  let mark = 0;
  return {
    text: () => strip(out),
    raw: () => out,
    proc,
    exit,
    async until(re, ms = 20_000) {
      const t0 = Date.now();
      for (;;) {
        const s = strip(out);
        const m = re.exec(s.slice(mark));
        if (m) {
          mark += m.index + m[0].length;
          return;
        }
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}\n--- screen ---\n${s.slice(-1500)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async send(...keys) {
      for (const k of keys) {
        proc.stdin!.write(k);
        await new Promise((r) => setTimeout(r, 120));
      }
    },
  };
}

describe.skipIf(!hasScript)("discordrive setup: arrow-key wizard in a pty", () => {
  it("Enter everywhere: English, local, saved, started; the drive answers; Ctrl+C stops it", async () => {
    const xdg = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-tui-"));
    const port = await freePort();
    const t = term([], { XDG_DATA_HOME: xdg });
    await t.until(/Language \/ Język\s+│\s+◉ English\s+│\s+○ Polski/);
    await t.send(KEY.enter);
    // Risk notice: Cancel preselected; arrow up + Enter accepts.
    await t.until(/Before you start: read and accept/);
    await t.until(/Do you understand and accept this\?\s+│\s+○ I understand and accept\s+│\s+◉ Cancel/);
    await t.send(KEY.up);
    await t.until(/◉ I understand and accept\s+│\s+○ Cancel/);
    await t.send(KEY.enter);
    await t.until(/risk accepted/);
    await t.until(/Step 1\/5 · Where should the drive run\?/);
    await t.until(/◉ Only on this computer/);
    await t.send(KEY.enter);
    await t.until(/Port\s+│\s+3020/); // default as placeholder
    await t.send(String(port), KEY.enter);
    await t.until(new RegExp(`port ${port} is free`));
    await t.until(/Step 2\/5/);
    await t.send(KEY.enter); // mode
    await t.until(/◉ Skip for now/);
    await t.send(KEY.enter); // bot: skip
    await t.until(/Step 5\/5/);
    await t.until(/Directory/);
    await t.send(KEY.enter); // data dir
    await t.until(/Summary/);
    await t.until(/Save\?\s+│\s+◉ Yes \/ ○ No/);
    await t.send(KEY.enter);
    await t.until(/browser app ready/, 60_000);
    await t.until(/Start the drive now, in this window\?/);
    await t.send(KEY.enter);
    await t.until(/Done\. Open in the browser:\s+http:\/\/localhost:\d+/, 30_000);
    const h = (await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json()) as { ok: boolean; language: string };
    expect(h).toMatchObject({ ok: true, language: "en" });
    const c = JSON.parse(readFileSync(join(xdg, "discordrive-next", "config.json"), "utf8"));
    expect(c).toMatchObject({ language: "en", signup: "open", publicUrl: `http://localhost:${port}`, bind: { host: "127.0.0.1", port }, acceptedRisk: { version: 1 } });
    await t.send(KEY.ctrlC);
    expect(await t.exit).toBe(0);
    expect(t.text()).not.toMatch(/Choose a number|\[Y\/n\]/); // the plain interface did not leak in
  }, 120_000);

  it("arrows change what is saved (Polish, public server, sign-up 'open'); live validation of the address, the port and the bot token", async () => {
    const fake = new FakeDiscord();
    await fake.listen();
    fake.botToken = "fake-bot-token-pty-000000000000000000000000.ok";
    const xdg = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-tui-"));
    const port = await freePort();
    const { createServer } = await import("node:net");
    const busy = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => busy.once("listening", r));
    const busyPort = (busy.address() as { port: number }).port;
    try {
      const t = term(["--discord-api-origin", fake.origin, "--no-self-test"], { XDG_DATA_HOME: xdg });
      await t.until(/◉ English/);
      await t.send(KEY.down);
      await t.until(/○ English\s+│\s+◉ Polski/);
      await t.send(KEY.enter);
      await t.until(/Zanim zaczniesz: przeczytaj i zaakceptuj[\s\S]*niezgodne z regulaminem[\s\S]*◉ Anuluj/);
      await t.send(KEY.up, KEY.enter);
      await t.until(/Krok 1\/5 · Gdzie ma działać dysk\?/);
      await t.send(KEY.down);
      await t.until(/◉ Na serwerze z własną domeną/);
      await t.send(KEY.enter);
      await t.until(/Adres, który wpiszą użytkownicy/);
      await t.send(..."nie-adres", KEY.enter);
      await t.until(/▲  Adres, który wpiszą użytkownicy.*\n│  nie-adres█?\n└  To nie wygląda na adres/); // error under the field, still in the wizard
      await t.send(...Array(9).fill(KEY.backspace), ..."https://dysk.example.com", KEY.enter);
      await t.until(/Adres nasłuchu/);
      await t.send(KEY.enter); // 127.0.0.1
      await t.until(/Port/);
      await t.send(String(busyPort), KEY.enter);
      await t.until(new RegExp(`Port ${busyPort} jest zajęty przez inny program.*Wolny: \\d+`));
      await t.send(...Array(String(busyPort).length).fill(KEY.backspace), String(port), KEY.enter);
      await t.until(new RegExp(`port ${port} jest wolny`));
      await t.until(/Adres proxy/);
      await t.send(KEY.enter);
      await t.until(/Krok 2\/5/);
      // Mode: metadata only preselected; e2ee is selectable now (stage 3), plain not yet.
      await t.until(/◉ metadata only/);
      await t.send(KEY.down);
      await t.until(/◉ e2ee: pliki i nazwy szyfrowane/);
      await t.send(KEY.up);
      await t.until(/◉ metadata only/);
      await t.send(KEY.enter);
      await t.until(/◉ Pomiń na razie/);
      await t.send(KEY.down, KEY.enter); // set the bot up now
      await t.until(/Token bota/);
      await t.send(..."wrong-token", KEY.enter);
      await t.until(/Token nie działa: Discord odrzucił token \(401\)/, 20_000);
      await t.send(...Array(11).fill(KEY.backspace), ...fake.botToken, KEY.enter);
      await t.until(/token działa: bot fake-bot/, 20_000);
      await t.until(/Krok 4\/5 · Kto może zakładać konta\?\s+│\s+◉ Tylko z kodem zaproszenia/);
      await t.send(KEY.down);
      await t.until(/◉ Każdy, kto zna adres/);
      await t.send(KEY.enter);
      await t.until(/Krok 5\/5/);
      await t.send(KEY.enter);
      await t.until(/Zapisać\?\s+│\s+◉ Tak \/ ○ Nie/);
      await t.send("t"); // Polish "tak"
      await t.until(/aplikacja przeglądarkowa gotowa/, 60_000);
      await t.until(/Uruchomić dysk teraz, w tym oknie\?\s+│\s+◉ Tak \/ ○ Nie/);
      await t.send(KEY.right);
      await t.until(/○ Tak \/ ◉ Nie/);
      await t.send(KEY.enter);
      await t.until(/Gotowe\. Uruchom dysk/);
      expect(await t.exit).toBe(0);
      expect(t.text()).not.toContain(fake.botToken);
      const c = JSON.parse(readFileSync(join(xdg, "discordrive-next", "config.json"), "utf8"));
      expect(c).toMatchObject({ language: "pl", signup: "open", publicUrl: "https://dysk.example.com", bind: { host: "127.0.0.1", port }, trustProxy: ["127.0.0.1"], bot: { username: "fake-bot" } });
    } finally {
      busy.close();
      await fake.close();
    }
  }, 150_000);

  it("risk notice: Enter alone = Cancel (exit 130, nothing saved); after acceptance a re-run does not ask again", async () => {
    const xdg = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-tui-"));
    const t = term([], { XDG_DATA_HOME: xdg });
    await t.until(/◉ English/);
    await t.send(KEY.enter);
    await t.until(/Storing files on Discord is against Discord's[\s\S]*without warranty of any kind[\s\S]*◉ Cancel/);
    await t.send(KEY.enter);
    await t.until(/Not accepted\. Setup stopped; nothing was saved\./);
    expect(await t.exit).toBe(130);
    expect(existsSync(join(xdg, "discordrive-next", "config.json"))).toBe(false);
    expect(t.text()).not.toMatch(/Step 1\/5/);
    // Accept once with flags, then the interactive wizard goes straight to step 1.
    const y = term(["--yes", "--accept-risk", "--port", String(await freePort()), "--no-self-test"], { XDG_DATA_HOME: xdg });
    expect(await y.exit).toBe(0);
    const t2 = term([], { XDG_DATA_HOME: xdg });
    await t2.until(/◉ English/);
    await t2.send(KEY.enter);
    await t2.until(/Step 1\/5 · Where should the drive run\?/);
    expect(t2.text()).not.toContain("Terms of Service");
    await t2.send(KEY.ctrlC);
    expect(await t2.exit).toBe(130);
  }, 90_000);

  it("Ctrl+C and Esc stop cleanly: nothing saved, exit 130, cursor shown again", async () => {
    for (const key of [KEY.ctrlC, KEY.esc]) {
      const xdg = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-tui-"));
      const t = term([], { XDG_DATA_HOME: xdg });
      await t.until(/◉ English/);
      await t.send(KEY.enter);
      await t.until(/◉ Cancel/);
      await t.send(KEY.up, KEY.enter);
      await t.until(/Step 1\/5/);
      await t.send(key);
      await t.until(/Setup cancelled\. Nothing was saved\./);
      expect(await t.exit).toBe(130);
      expect(existsSync(join(xdg, "discordrive-next", "config.json"))).toBe(false);
      expect(t.raw().lastIndexOf("\x1b[?25h")).toBeGreaterThan(t.raw().lastIndexOf("\x1b[?25l"));
    }
  }, 60_000);

  it("NO_COLOR: no color codes; --yes on a terminal: no questions, plain output", async () => {
    const xdg = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-tui-"));
    const t = term([], { XDG_DATA_HOME: xdg, NO_COLOR: "1" });
    await t.until(/◉ English/);
    expect(t.raw()).not.toMatch(/\x1b\[3\dm/);
    await t.send(KEY.ctrlC);
    expect(await t.exit).toBe(130);
    // --yes alone does not accept the risk notice: refused, nothing saved.
    const n = term(["--yes", "--port", String(await freePort()), "--no-self-test"], { XDG_DATA_HOME: xdg });
    expect(await n.exit).toBe(1);
    expect(n.text()).toContain("--yes does not accept the risk");
    expect(existsSync(join(xdg, "discordrive-next", "config.json"))).toBe(false);
    const y = term(["--yes", "--accept-risk", "--port", String(await freePort()), "--no-self-test"], { XDG_DATA_HOME: xdg });
    expect(await y.exit).toBe(0);
    expect(y.text()).toContain("Start the drive (npm start) and open:");
    expect(y.text()).not.toMatch(/[◆◇◉]/);
  }, 90_000);
});
