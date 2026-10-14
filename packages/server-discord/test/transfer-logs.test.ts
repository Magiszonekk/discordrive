// Server part of the transfer logs (e2ee/plain): turned on per account through the API, the server's
// lines (body, limiter, the Discord post) land in <data dir>/logs/transfers-*.jsonl with the account,
// a user downloads only their own lines, "clear" hides older ones, nothing secret is written.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelPacer, DiscordWebhookTransport, DriveClient, EncryptedArbiter, HttpApi, MemoryLogSink, OpCodec, TransferLog, createAccountHttp, generateDeviceKey, memorySource, newAccountKey, type ByteSink } from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { BlobsExtension, DiscordSender, InstanceHooks, POOL, ServerTransferLogs, loadInstanceKey } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

describe("server transfer logs (e2ee)", () => {
  it("per account on/off, own lines only, clear, no secrets", async () => {
    const fake = new FakeDiscord();
    const origin = await fake.listen();
    cleanups.push(() => fake.close());
    const dir = mkdtempSync(join(tmpdir(), "ddn-tlog-srv-"));
    const transport = new DiscordWebhookTransport({ apiOrigin: origin });
    const key = loadInstanceKey(join(dir, "instance.key"));
    let hooks!: InstanceHooks;
    const tl = new ServerTransferLogs({ dataDir: dir });
    const ext = new BlobsExtension({
      get hooks() {
        return hooks;
      },
      sender: new DiscordSender({ transport, pacer: new ChannelPacer({ perMin: 6000, maxPerMin: 6000, burst: 20 }) }),
      tickMs: 0,
      cdnOrigins: [origin],
      transferLogs: tl,
    } as never);
    const srv = new DdnServer({ dbPath: join(dir, "ddn.db"), mode: "e2ee", rateLimits: false, extensions: [{ name: "hooks", init: (s) => void (hooks = new InstanceHooks(s.db, key, s.clock)) }, ext] });
    const { url } = await srv.listen(0);
    cleanups.push(() => srv.close());
    const pool = [fake.addWebhook("1550000000000000401"), fake.addWebhook("1550000000000000402")];
    for (const h of pool) await hooks.add(POOL, h.url, transport);

    const acct = async () => {
      const k = newAccountKey();
      const dk = await generateDeviceKey();
      const r = await createAccountHttp(url, dk, k);
      const api = new HttpApi({ baseUrl: url, accountId: r.accountId, deviceId: r.deviceId, key: dk, instanceId: r.instanceId });
      const client = new DriveClient({ device: { id: r.deviceId, name: "t" }, arbiter: new EncryptedArbiter(new OpCodec(k, r.accountId), api), blobs: new ServerBlobStore(api), chunkSize: 64 * 1024 });
      return { api, client, id: r.accountId };
    };
    const A = await acct();
    const B = await acct();
    expect((await A.api.json("GET", "/v1/diagnostics/transfer-log")).body).toMatchObject({ on: false, all: false });
    // Off: nothing is written for B (and for A before it turns it on).
    await B.client.upload(memorySource(new Uint8Array(100_000)), "b.bin");
    expect((await A.api.json("POST", "/v1/diagnostics/transfer-log", { on: true })).body).toMatchObject({ on: true });
    const mem = new MemoryLogSink();
    A.client.setTransferLog(new TransferLog(mem.write, { src: "web", mode: "e2ee" }));
    const up = await A.client.upload(memorySource(new Uint8Array(200_000)), "geheim.bin");
    const s: ByteSink = { write: async () => {} };
    await A.client.download(up.nodeId, s);
    tl.flush();
    const files = readdirSync(join(dir, "logs"));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^transfers-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const raw = readFileSync(join(dir, "logs", files[0]!), "utf8");
    for (const h of pool) expect(raw).not.toContain(h.url.split("/").at(-1)!);
    expect(raw).not.toContain("geheim");
    expect(raw).not.toMatch(/[?&](ex|is|hm)=|\/webhooks\/\d+\/\w{20,}/);
    expect(raw).not.toContain(B.id);
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.every((l) => l.acct === A.id && l.src === "server")).toBe(true);
    // One server "frag" per blob (4 fragments + manifest) with budget/body/hash/post, one Discord post each with limiter state.
    const frags = lines.filter((l) => l.ev === "frag");
    expect(frags.length).toBe(up.chunks + 1);
    for (const f of frags) for (const k of ["budget", "body", "hash", "post", "hook", "ch"]) expect(f[k], k).toBeDefined();
    const posts = lines.filter((l) => l.ev === "req" && l.k === "discord");
    expect(posts.length).toBe(up.chunks + 1);
    expect(posts[0]!.lst).toMatchObject({ pm: expect.any(Number) });
    expect(posts.every((p) => p.x === up.uploadId)).toBe(true);
    expect(lines.some((l) => l.ev === "links")).toBe(true);
    // The client side has the same transfer ID: the report joins them.
    expect(mem.text()).toContain(up.uploadId);
    // Download through the API: A gets its lines, B none; clear hides the old ones.
    const dl = await A.api.request("GET", "/v1/diagnostics/transfer-log?download=1");
    expect(dl.headers.get("content-type")).toMatch(/ndjson/);
    expect((await dl.text()).trim().split("\n").length).toBe(lines.length);
    expect(await (await B.api.request("GET", "/v1/diagnostics/transfer-log?download=1")).text()).toBe("");
    await A.api.json("DELETE", "/v1/diagnostics/transfer-log");
    expect(await (await A.api.request("GET", "/v1/diagnostics/transfer-log?download=1")).text()).toBe("");
    // Off again: no more lines.
    await A.api.json("POST", "/v1/diagnostics/transfer-log", { on: false });
    const before = readFileSync(join(dir, "logs", files[0]!), "utf8").length;
    await A.client.upload(memorySource(new Uint8Array(1000)), "c.bin");
    tl.flush();
    expect(readFileSync(join(dir, "logs", files[0]!), "utf8").length).toBe(before);
  });
});
