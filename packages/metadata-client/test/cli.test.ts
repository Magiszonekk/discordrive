import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openClient, openState, runCli } from "../src/cli.js";
import { MemoryTransport, sha256Hex } from "../src/index.js";

function rand(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

describe("ddn CLI (single device, state persisted between runs)", () => {
  it("put in one process, ls/get in the next, file permissions 0600/0700", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-cli-"));
    const hookFile = join(dir, "hook.url");
    // Fake but well-formed URL; MemoryTransport never dials it.
    writeFileSync(hookFile, `https://discord.com/api/webhooks/123456789012345678/${"x".repeat(68)}\n`, { mode: 0o600 });
    const transport = new MemoryTransport();
    const lines: string[] = [];
    const env = { stateDir: join(dir, "state"), webhookFiles: [] as string[], transport, out: (l: string) => lines.push(l) };
    expect(await runCli(["init"], env)).toBe(0);
    await expect(runCli(["put", hookFile], env)).rejects.toThrow(/no webhooks/);
    expect(await runCli(["webhook", "add", hookFile], env)).toBe(0);
    expect(lines.at(-1)).toMatch(/3–4 channels/);

    const src = join(dir, "in.bin");
    const data = rand(65_000);
    writeFileSync(src, data);
    expect(await runCli(["put", src, "dane.bin"], env)).toBe(0);
    expect(lines.at(-1)).toMatch(/^put \S+ 65000 B in 1 fragment/);

    // "new process": everything rebuilt from the state dir
    expect(await runCli(["ls"], env)).toBe(0);
    expect(lines.at(-1)).toMatch(/dane\.bin$/);
    const dst = join(dir, "out.bin");
    expect(await runCli(["get", "dane.bin", dst], env)).toBe(0);
    expect(await sha256Hex(readFileSync(dst))).toBe(await sha256Hex(data));

    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    // Next start: the SQLite index already has the whole log, nothing to replay.
    const st = (await openState(join(dir, "state")));
    const c = await openClient(st, transport);
    expect(c.replica.headSeq).toBe(st.server!.log.headSeq);
    expect(c.replica.results.length).toBe(0);

    for (const f of ["account.json", "device.json", "seen.json", "server/log.jsonl", "server/vault.json", "index.db"]) {
      expect(statSync(join(dir, "state", f)).mode & 0o777).toBe(0o600);
    }
    // What the server would hold: no names, no webhook token, no file keys.
    const serverFiles = readFileSync(join(dir, "state", "server", "log.jsonl"), "utf8") + readFileSync(join(dir, "state", "server", "vault.json"), "utf8");
    for (const secret of ["x".repeat(68), "dane.bin", "123456789012345678", "manifest", "ddn1:"]) expect(serverFiles).not.toContain(secret);
  });
});

describe("ddn CLI against the HTTP server (Ed25519 sign-in)", () => {
  it("init on server, put, pair a second CLI device, it lists and gets; rescue kit device; revoke", async () => {
    const { startServer, closeServers } = await import("./http-helpers.js");
    const { srv, url } = await startServer();
    try {
      const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-cli-srv-"));
      const hookFile = join(dir, "hook.url");
      writeFileSync(hookFile, `https://discord.com/api/webhooks/123456789012345678/${"x".repeat(68)}\n`, { mode: 0o600 });
      const transport = new MemoryTransport();
      const lines: string[] = [];
      const envA = { stateDir: join(dir, "A"), webhookFiles: [] as string[], transport, out: (l: string) => lines.push(l) };
      const envB = { ...envA, stateDir: join(dir, "B") };
      const envR = { ...envA, stateDir: join(dir, "R") };

      expect(await runCli(["init", "--server", url], envA)).toBe(0);
      expect(await runCli(["webhook", "add", hookFile], envA)).toBe(0);
      const src = join(dir, "in.bin");
      const data = rand(40_000);
      writeFileSync(src, data);
      expect(await runCli(["put", src, "raport.pdf"], envA)).toBe(0);

      // B shows a code (pair-offer polls); A accepts it.
      process.env.DDN_PAIR_WAIT_MS = "20000";
      const offerP = runCli(["pair-offer", "--server", url], envB);
      let code: string | undefined;
      for (let i = 0; i < 100 && !code; i++) {
        await new Promise((r) => setTimeout(r, 50));
        code = lines.find((l) => l.startsWith("pairing code: "))?.slice("pairing code: ".length);
      }
      expect(code).toMatch(/^ddn-pair1:/);
      expect(await runCli(["pair-accept", code!], envA)).toBe(0);
      expect(await offerP).toBe(0);
      const sasA = lines.find((l) => l.startsWith("paired device"))!.split(": ").at(-1);
      const sasB = lines.find((l) => l.startsWith("paired by"))!.split(": ").at(-1);
      expect(sasA).toMatch(/^\d{6}$/);
      expect(sasB).toBe(sasA);

      expect(await runCli(["ls"], envB)).toBe(0);
      expect(lines.at(-1)).toMatch(/raport\.pdf$/);
      const dst = join(dir, "out.bin");
      expect(await runCli(["get", "raport.pdf", dst], envB)).toBe(0);
      expect(await sha256Hex(readFileSync(dst))).toBe(await sha256Hex(data));

      // Rescue kit: all devices lost, only the kit is left.
      expect(await runCli(["kit"], envA)).toBe(0);
      const kitFile = join(dir, "kit.txt");
      writeFileSync(kitFile, lines.at(-1)!, { mode: 0o600 });
      expect(await runCli(["rescue", "--server", url, kitFile], envR)).toBe(0);
      expect(await runCli(["ls"], envR)).toBe(0);
      expect(lines.at(-1)).toMatch(/raport\.pdf$/);

      // A lists 3 devices and revokes B; B can no longer sign in.
      lines.length = 0;
      expect(await runCli(["devices"], envA)).toBe(0);
      expect(lines.length).toBe(3);
      const bId = JSON.parse(readFileSync(join(envB.stateDir, "device.json"), "utf8")).id as string;
      expect(await runCli(["devices", "revoke", bId], envA)).toBe(0);
      await expect(runCli(["ls"], envB)).rejects.toMatchObject({ status: 401 });

      // Server mode keeps no server/ dir locally; the device key file is 0600 and never on the server.
      expect(existsSync(join(envA.stateDir, "server"))).toBe(false);
      expect(statSync(join(envA.stateDir, "device.json")).mode & 0o777).toBe(0o600);
      const pkcs8 = JSON.parse(readFileSync(join(envA.stateDir, "device.json"), "utf8")).pkcs8 as string;
      const dump = JSON.stringify([srv.db.prepare("SELECT * FROM devices").all(), srv.db.prepare("SELECT * FROM log").all(), srv.db.prepare("SELECT * FROM vault").all()]);
      for (const secret of [pkcs8, "raport", "x".repeat(68)]) expect(dump).not.toContain(secret);
    } finally {
      delete process.env.DDN_PAIR_WAIT_MS;
      await closeServers();
    }
  });

  it("refuses a non-loopback server URL in stage 2", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-cli-remote-"));
    await expect(runCli(["init", "--server", "https://example.com"], { stateDir: dir, webhookFiles: [] })).rejects.toThrow(/127\.0\.0\.1/);
  });
});
