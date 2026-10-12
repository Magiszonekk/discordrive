// `discordrive setup --mode e2ee`: the instance pool from a webhooks file (checked with Discord,
// sealed with instance.key, never in config.json), the e2ee server bundle, health/doctor, a
// real upload/download through the instance, and the mode lock (setup, database, bundle).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DriveClient, EncryptedArbiter, HttpApi, OpCodec, createAccountHttp, generateDeviceKey, memorySource, newAccountKey, sha256Hex } from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { loadConfig } from "../src/config.js";
import { doctor } from "../src/doctor.js";
import { ttyPrompter } from "../src/prompt.js";
import { serve } from "../src/serve.js";
import { setup } from "../src/setup.js";

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-e2ee-setup-"));
const quiet = () => {
  const out: string[] = [];
  const o = new PassThrough();
  o.on("data", (d) => out.push(...String(d).replace(/\n$/, "").split("\n")));
  return { out, p: ttyPrompter(new PassThrough(), o) };
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
process.env.XDG_DATA_HOME = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-xdg-"));
process.env.DISCORDRIVE_NO_AUTOSTART = "1";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("setup --mode e2ee", () => {
  it("pool from a file, e2ee bundle, health + doctor, upload/download through the instance; the mode cannot change", async () => {
    const fake = new FakeDiscord();
    const origin = await fake.listen();
    cleanups.push(() => fake.close());
    const dir = tmp();
    const port = await freePort();
    const hooks = [fake.addWebhook("1550000000000000301"), fake.addWebhook("1550000000000000302")];
    const file = join(dir, "..", `hooks-${port}.txt`);
    writeFileSync(file, `# instance pool\n${hooks.map((h) => h.url).join("\n")}\n`);
    const { p, out } = quiet();
    const r = await setup({ yes: true, acceptRisk: true, dataDir: dir, port, autostart: false, mode: "e2ee", webhooksFile: file, discordApiOrigin: origin, selfTest: false }, p);
    expect(r.config.mode).toBe("e2ee");
    expect(out.join("\n")).toContain("Instance channels: 2 channel(s), 2 webhook(s).");
    // No webhook token in the config file.
    const cfgText = readFileSync(join(dir, "config.json"), "utf8");
    for (const h of hooks) expect(cfgText).not.toContain(h.url.split("/").pop()!);

    const srv = await serve(loadConfig(dir), () => {});
    cleanups.push(() => srv.close());
    const url = `http://127.0.0.1:${port}`;
    const h = (await (await fetch(`${url}/v1/health`)).json()) as Record<string, unknown>;
    expect(h).toMatchObject({ mode: "e2ee", serverBlobs: true, pool: { channels: 2, alive: 2 }, snapshots: { by: "server" } });
    // The vault endpoint (metadata only) is not part of this instance.
    const cfg = await (await fetch(`${url}/config.js`)).text();
    expect(cfg).toContain(`"mode":"e2ee"`);

    const lines: string[] = [];
    const d = await doctor(dir, (s) => lines.push(s));
    expect(lines.join("\n")).toMatch(/Mode: built for e2ee/);
    expect(lines.join("\n")).toMatch(/Instance channels: 2 channel\(s\), 2 webhook\(s\) alive/);
    expect(d.ok).toBe(true);

    // A client through the real instance process.
    const key = newAccountKey();
    const dk = await generateDeviceKey();
    const a = await createAccountHttp(url, dk, key);
    const api = new HttpApi({ baseUrl: url, accountId: a.accountId, deviceId: a.deviceId, key: dk });
    expect((await api.request("GET", "/v1/vault")).status).toBe(404);
    const client = new DriveClient({ device: { id: a.deviceId, name: "t" }, arbiter: new EncryptedArbiter(new OpCodec(key, a.accountId), api), blobs: new ServerBlobStore(api), chunkSize: 4096 });
    const data = new Uint8Array(4096 * 3 + 7).map((_, i) => (i * 31) & 255);
    const up = await client.upload(memorySource(data), "x.bin");
    const parts: Uint8Array[] = [];
    await client.download(up.nodeId, { write: async (b) => void parts.push(new Uint8Array(b)) });
    expect(await sha256Hex(Buffer.concat(parts))).toBe(await sha256Hex(data));
    expect(fake.posts).toBe(5);
    await srv.close();
    cleanups.pop();

    // The mode is locked: setup refuses another one; a server of another mode refuses the database.
    await expect(setup({ yes: true, acceptRisk: true, dataDir: dir, port, autostart: false, mode: "metadata-only", selfTest: false }, quiet().p)).rejects.toThrow(/cannot be changed/);
    expect(() => new DdnServer({ dbPath: join(dir, "ddn.db"), mode: "metadata-only" })).toThrow(/one instance = one mode/);
    // Re-running setup without --mode keeps e2ee and the pool.
    const again = await setup({ yes: true, acceptRisk: true, dataDir: dir, port, autostart: false, selfTest: false }, quiet().p);
    expect(again.config.mode).toBe("e2ee");
  });

  it("a config edited to another mode does not start on the old database", async () => {
    const dir = tmp();
    const port = await freePort();
    await setup({ yes: true, acceptRisk: true, dataDir: dir, port, autostart: false, selfTest: false }, quiet().p);
    const srv = await serve(loadConfig(dir), () => {});
    await srv.close();
    const c = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    c.mode = "e2ee";
    writeFileSync(join(dir, "config.json"), JSON.stringify(c), { mode: 0o600 });
    await expect(serve(loadConfig(dir), () => {})).rejects.toThrow(/belongs to a "metadata-only" instance/);
  });
});
