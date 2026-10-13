// `discordrive channels`: the operator removes/retires/moves POOL webhooks of an e2ee instance
// (zlecenie 2026-10-13-webhooki p. 1, owner decision 6). The CLI works on the database only, next
// to the running server (separate connection); the server sees retire/remove at once (PRAGMA
// data_version) and executes a queued move on its background pass.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DriveClient, EncryptedArbiter, HttpApi, OpCodec, createAccountHttp, generateDeviceKey, memorySource, newAccountKey, sha256Hex } from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { FakeDiscord } from "@ddv4/metadata-client/node";
import { channelsCli } from "../src/channels.js";
import { main } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { setCliLang } from "../src/i18n.js";
import { ttyPrompter } from "../src/prompt.js";
import { serve } from "../src/serve.js";
import { setup } from "../src/setup.js";

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-channels-cli-"));
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
  setCliLang("en");
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("discordrive channels (pool webhooks, operator)", () => {
  it("list / impact / retire / unretire / remove (--force) / move via a job the running server executes; EN + PL", async () => {
    const fake = new FakeDiscord();
    const origin = await fake.listen();
    cleanups.push(() => fake.close());
    const dir = tmp();
    const port = await freePort();
    const pool = [fake.addWebhook("1550000000000000901"), fake.addWebhook("1550000000000000902"), fake.addWebhook("1550000000000000903")];
    const file = join(dir, "..", `hooks-ch-${port}.txt`);
    writeFileSync(file, pool.map((h) => h.url).join("\n") + "\n");
    const o = new PassThrough();
    o.resume();
    await setup({ yes: true, acceptRisk: true, dataDir: dir, port, autostart: false, mode: "e2ee", webhooksFile: file, discordApiOrigin: origin, selfTest: false }, ttyPrompter(new PassThrough(), o));
    const srv = await serve(loadConfig(dir), () => {});
    cleanups.push(() => srv.close());
    const ext = <T>(name: string) => srv.extensions.find((x) => x.name === name) as unknown as T;
    const blobsExt = ext<{ moves(): Promise<number> }>("server-blobs");
    const snaps = ext<{ tick(force: boolean): Promise<number>; location(a: string): { webhookId: string; messageId: string } | null }>("server-snapshots");

    const url = `http://127.0.0.1:${port}`;
    const key = newAccountKey();
    const dk = await generateDeviceKey();
    const a = await createAccountHttp(url, dk, key);
    const api = new HttpApi({ baseUrl: url, accountId: a.accountId, deviceId: a.deviceId, key: dk });
    const client = new DriveClient({ device: { id: a.deviceId, name: "t" }, arbiter: new EncryptedArbiter(new OpCodec(key, a.accountId), api), blobs: new ServerBlobStore(api), chunkSize: 4096 });
    const data = new Uint8Array(4096 * 11 + 3).map((_, i) => (i * 29) & 255);
    const up = await client.upload(memorySource(data), "pool.bin");
    expect(await snaps.tick(true)).toBe(1);
    const ptr = snaps.location(a.accountId)!;
    const others = pool.map((h) => h.id).filter((id) => id !== ptr.webhookId);
    const sameBytes = async () => {
      const parts: Uint8Array[] = [];
      await client.download(up.nodeId, { write: async (b) => void parts.push(new Uint8Array(b)) });
      return (await sha256Hex(Buffer.concat(parts))) === (await sha256Hex(data));
    };

    const run = async (...argv: string[]) => {
      const lines: string[] = [];
      const args = argv.filter((x) => !x.startsWith("--"));
      const opts = Object.fromEntries(argv.filter((x) => x.startsWith("--")).map((x) => [x.slice(2), true]));
      const code = await channelsCli(dir, args, opts, { out: (s) => lines.push(s), pollMs: 20 });
      return { code, text: lines.join("\n") };
    };

    // list: every pool webhook with its files; the pointer's one is critical.
    const l = await run("list");
    expect(l.code).toBe(0);
    for (const h of pool) expect(l.text).toContain(h.id);
    expect(l.text).toMatch(new RegExp(`${ptr.webhookId}.*\\[critical: pointer\\+snapshots\\]`));
    expect(l.text).not.toContain("/webhooks/"); // never a URL
    // impact
    const im = await run("impact", others[0]!);
    expect(im.code).toBe(0);
    expect(im.text).toMatch(/1 file\(s\), [\d.]+ KB only on this webhook/);
    expect(im.text).toMatch(/Move: 2 other active webhook\(s\)/);
    // critical: retire and remove refused
    expect(await run("retire", ptr.webhookId)).toMatchObject({ code: 1, text: expect.stringMatching(/only `move` is allowed/) });
    expect(await run("remove", ptr.webhookId, "--force")).toMatchObject({ code: 1, text: expect.stringMatching(/only `move` is allowed/) });
    // retire: the running server stops posting there at once (it sees the CLI's commit).
    expect((await run("retire", others[0]!)).code).toBe(0);
    expect((await run("list")).text).toMatch(new RegExp(`${others[0]}.*\\[retired\\]`));
    const ch0 = pool.find((h) => h.id === others[0])!.channelId;
    const before = fake.postsByChannel.get(ch0) ?? 0;
    await client.upload(memorySource(new Uint8Array(4096 * 6).fill(3)), "after-retire.bin");
    expect(fake.postsByChannel.get(ch0) ?? 0).toBe(before);
    expect((await run("unretire", others[0]!)).code).toBe(0);
    // remove without --force: explains, does nothing
    const nf = await run("remove", others[0]!);
    expect(nf.code).toBe(1);
    expect(nf.text).toMatch(/--force/);
    // move (critical): queued by the CLI, executed by the running server; --wait prints progress.
    const waiting = run("move", ptr.webhookId, "--wait");
    let settled = false;
    void waiting.finally(() => (settled = true));
    while (!settled) {
      await blobsExt.moves();
      await new Promise((r) => setTimeout(r, 20));
    }
    const mv = await waiting;
    expect(mv.code).toBe(0);
    expect(mv.text).toMatch(/queued/);
    expect(mv.text).toMatch(/: done, (\d+)\/\1 pieces/);
    const after = await run("list");
    expect(after.text).not.toMatch(new RegExp(`^${ptr.webhookId}  channel`, "m")); // no longer a pool row
    expect(after.text).toMatch(new RegExp(`${ptr.webhookId}.*moved.*unavailable files: 0`));
    expect(snaps.location(a.accountId)!.webhookId).not.toBe(ptr.webhookId);
    expect([...fake.messages.values()].filter((m) => m.webhookId === ptr.webhookId).length).toBe(0);
    expect(await sameBytes()).toBe(true);
    // remove anyway with --force: the account sees its unavailable upload(s).
    const victim = (await snaps.location(a.accountId))!.webhookId === others[0] ? others[1]! : others[0]!;
    const rm = await run("remove", victim, "--force");
    expect(rm.code).toBe(0);
    const un = await api.json<{ uploads: { uploadId: string; webhookIds: string[] }[] }>("GET", "/v1/channels/unavailable");
    expect(un.body.uploads.map((u) => u.uploadId)).toContain(up.uploadId);
    // The last active pool webhook cannot go.
    const lastOne = others.find((x) => x !== victim)!;
    expect((await run("remove", lastOne, "--force")).code).toBe(1);
    // Polish texts, and the real entry point parses `channels <sub> <id> --force`.
    setCliLang("pl");
    expect((await run("status")).text).toMatch(/gotowe/);
    expect((await run("retire", lastOne)).text).toMatch(/dozwolone tylko `move`|najpierw dodaj/);
    setCliLang("en");
    const log = console.log;
    const printed: string[] = [];
    console.log = (s: string) => void printed.push(s);
    try {
      expect(await main(["channels", "status", "--data-dir", dir])).toBe(0);
      expect(await main(["channels", "remove", lastOne, "--data-dir", dir])).toBe(1);
      expect(await main(["channels", "bogus", "--data-dir", dir])).toBe(64);
    } finally {
      console.log = log;
    }
    expect(printed.join("\n")).toMatch(/done/);
  });
});
