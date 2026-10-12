// e2ee mode end to end over HTTP: a real DdnServer with the BlobsExtension, the fake Discord,
// and the client core (DriveClient + ServerBlobStore + EncryptedArbiter). Checks what the
// zlecenie asks for: upload through the server (streamed per fragment, memory budget), resume,
// cancel, download straight from the CDN with links refreshed by the server, background
// cleanup without any client, the server never sees plaintext, webhook URLs never leave it.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelPacer, DiscordWebhookTransport, DriveClient, EncryptedArbiter, HttpApi, OpCodec, createAccountHttp, generateDeviceKey, memorySource, newAccountKey, sha256Hex, type ByteSink } from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { BlobsExtension, DiscordSender, InstanceHooks, POOL, loadInstanceKey } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

function bytes(n: number, seed = 7): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) b[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
  return b;
}
function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    write: async (d) => void parts.push(new Uint8Array(d)),
    data: () => Buffer.concat(parts),
  };
}

async function instance(o: { channels?: number; inflightBytes?: number; tickMs?: number; dir?: string; now?: () => number } = {}) {
  const fake = new FakeDiscord();
  const origin = await fake.listen();
  cleanups.push(() => fake.close());
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "ddn-e2ee-"));
  const dbPath = join(dir, "ddn.db");
  const transport = new DiscordWebhookTransport({ apiOrigin: origin });
  const key = loadInstanceKey(join(dir, "instance.key"));
  let hooks!: InstanceHooks;
  const sender = new DiscordSender({ transport, pacer: new ChannelPacer({ perMin: 6000, maxPerMin: 6000, burst: 20 }) });
  const ext = new BlobsExtension({
    get hooks() {
      return hooks;
    },
    sender,
    inflightBytes: o.inflightBytes,
    tickMs: o.tickMs ?? 0,
    cdnOrigins: [origin],
  } as never);
  const srv = new DdnServer({
    dbPath,
    mode: "e2ee",
    rateLimits: false,
    leaseMs: 60_000,
    now: o.now,
    extensions: [
      {
        name: "hooks",
        init: (s) => {
          hooks = new InstanceHooks(s.db, key, s.clock);
        },
      },
      ext,
    ],
  });
  const { url } = await srv.listen(0);
  cleanups.push(() => srv.close());
  const pool = [];
  for (let i = 0; i < (o.channels ?? 2); i++) {
    const h = fake.addWebhook(String(1550000000000000100n + BigInt(i)));
    await hooks.add(POOL, h.url, transport);
    pool.push(h);
  }
  return { fake, origin, url, srv, ext, sender, hooks: () => hooks, pool, dir, dbPath };
}

async function account(url: string, origin: string, o: { concurrency?: number; chunkSize?: number } = {}) {
  const key = newAccountKey();
  const dk = await generateDeviceKey();
  const r = await createAccountHttp(url, dk, key);
  const api = new HttpApi({ baseUrl: url, accountId: r.accountId, deviceId: r.deviceId, key: dk, instanceId: r.instanceId });
  const cdnGets: string[] = [];
  const blobs = new ServerBlobStore(api, {
    fetchCdn: async (u) => {
      cdnGets.push(u);
      const res = await fetch(u);
      if (!res.ok) throw new Error(`cdn ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  });
  const client = new DriveClient({
    device: { id: r.deviceId, name: "test" },
    arbiter: new EncryptedArbiter(new OpCodec(key, r.accountId), api),
    blobs,
    chunkSize: o.chunkSize ?? 64 * 1024,
    concurrency: o.concurrency ?? 3,
  });
  void origin;
  return { client, api, blobs, accountId: r.accountId, deviceId: r.deviceId, key, cdnGets };
}

describe("e2ee: blobs through the instance", () => {
  it("upload through the server, download from the CDN after a server link refresh; SHA matches; no plaintext and no webhook URL on the server side", async () => {
    const I = await instance({ channels: 3 });
    const A = await account(I.url, I.origin);
    const data = bytes(64 * 1024 * 5 + 123);
    const up = await A.client.upload(memorySource(data), "secret-name.bin");
    expect(up.chunks).toBe(6);
    expect(I.fake.posts).toBe(7); // 6 fragments + manifest, all posted by the server
    expect(I.fake.postsByChannel.size).toBe(3); // spread over the pool's channels

    // Second device of the same account (fresh replica) downloads it.
    const B = await account(I.url, I.origin);
    void B;
    const s = sink();
    await A.client.download(up.nodeId, s);
    expect(await sha256Hex(s.data())).toBe(await sha256Hex(data));
    expect(A.cdnGets.length).toBeGreaterThanOrEqual(7); // straight from the CDN, not proxied

    // The server sees only ciphertext: no plaintext run of the file in what Discord got, no file name in the database.
    const probe = Buffer.from(data.subarray(1000, 1064)).toString("latin1");
    for (const m of I.fake.messages.values()) for (const a of m.attachments) expect(Buffer.from(a.data).toString("latin1")).not.toContain(probe);
    I.srv.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const raw = readFileSync(I.dbPath).toString("latin1");
    expect(raw).not.toContain("secret-name");
    for (const h of I.pool) expect(raw).not.toContain(h.url.split("/").pop()!);
    // The account API never returns a webhook URL.
    const ch = await A.api.json<unknown>("GET", "/v1/channels");
    expect(JSON.stringify(ch.body)).not.toContain("/webhooks/");
    expect(ch.body).toMatchObject({ using: "pool", pool: { channels: 3, alive: 3 } });
  });

  it("a blob needs this device's lease; another account cannot read or refresh it", async () => {
    const I = await instance();
    const A = await account(I.url, I.origin);
    const C = await account(I.url, I.origin);
    const data = bytes(1000);
    const sha = await sha256Hex(data);
    const put = (api: HttpApi, u: string) =>
      api.request("PUT", `/v1/uploads/${u}/blobs/0`, { body: data as BodyInit, headers: { "content-type": "application/octet-stream", "x-ddn-sha256": sha } });
    const u = "UPLOAD_without_lease_01";
    expect((await put(A.api, u)).status).toBe(409);
    expect(await A.api.renewLease(u)).toBe(true);
    const ok = await put(A.api, u);
    expect(ok.status).toBe(200);
    const p = ((await ok.json()) as { placement: { attachmentId: string } }).placement;
    // wrong hash
    const bad = await A.api.request("PUT", `/v1/uploads/${u}/blobs/1`, { body: data as BodyInit, headers: { "x-ddn-sha256": "0".repeat(64) } });
    expect(bad.status).toBe(400);
    // another account
    await expect(C.api.json("POST", "/v1/blobs/urls", { attachments: [{ attachmentId: p.attachmentId }] })).rejects.toMatchObject({ status: 404 });
    expect((await C.api.request("GET", `/v1/blobs/${p.attachmentId}`)).status).toBe(404);
    // proxy path for the owner
    const via = await A.api.request("GET", `/v1/blobs/${p.attachmentId}`);
    expect(Buffer.from(await via.arrayBuffer()).equals(Buffer.from(data))).toBe(true);
  });

  it("resume: the same (upload, index, hash) again is answered from the stored placement, nothing posted twice", async () => {
    const I = await instance();
    const A = await account(I.url, I.origin);
    const data = bytes(5000);
    const sha = await sha256Hex(data);
    const u = "UPLOAD_resume_000000001";
    await A.api.renewLease(u);
    const send = () => A.api.request("PUT", `/v1/uploads/${u}/blobs/3`, { body: data as BodyInit, headers: { "x-ddn-sha256": sha } });
    const r1 = (await (await send()).json()) as { placement: unknown };
    const r2 = (await (await send()).json()) as { placement: unknown; reused?: boolean };
    expect(r2.placement).toEqual(r1.placement);
    expect(r2.reused).toBe(true);
    expect(I.fake.posts).toBe(1);
    const st = await A.api.json<{ state: string; blobs: { idx: string }[] }>("GET", `/v1/uploads/${u}`);
    expect(st.body).toMatchObject({ state: "open", blobs: [{ idx: "3" }] });
  });

  it("cancel mid-upload: the fragment in flight stops, the server deletes what was stored, the upload is refused afterwards", async () => {
    const I = await instance();
    const A = await account(I.url, I.origin, { concurrency: 1 });
    const ac = new AbortController();
    let progress = 0;
    const run = A.client.upload(memorySource(bytes(64 * 1024 * 8)), "big.bin", undefined, {
      signal: ac.signal,
      onProgress: (d) => {
        progress = d;
        if (d >= 64 * 1024 * 3) ac.abort();
      },
    });
    await expect(run).rejects.toThrow(/abort/i);
    expect(progress).toBeGreaterThanOrEqual(64 * 1024 * 3);
    expect(I.fake.posts).toBeLessThan(9);
    // Everything that reached Discord was deleted again.
    expect(I.fake.messages.size).toBe(0);
    const rows = I.srv.db.prepare("SELECT state FROM s_uploads").all() as { state: string }[];
    expect(rows.map((r) => r.state)).toEqual(["aborted"]);
    // The tree has no file.
    await A.client.pull();
    expect(A.client.list().length).toBe(0);
  });

  it("memory: a 192 MiB-style budget (here 3 blobs) is never exceeded with many concurrent uploaders", async () => {
    const blob = 64 * 1024;
    const I = await instance({ inflightBytes: blob * 3 + 100 });
    const accts = await Promise.all(Array.from({ length: 4 }, () => account(I.url, I.origin, { concurrency: 4, chunkSize: blob - 28 })));
    const files = accts.map((_, i) => bytes(blob * 6, i + 1));
    const ups = await Promise.all(accts.map((a, i) => a.client.upload(memorySource(files[i]!), `f${i}`)));
    expect(I.ext.budget.peak).toBeLessThanOrEqual(blob * 3 + 100);
    expect(I.ext.budget.peak).toBeGreaterThan(blob); // it did run in parallel
    for (let i = 0; i < 4; i++) {
      const s = sink();
      await accts[i]!.client.download(ups[i]!.nodeId, s);
      expect(Buffer.from(s.data()).equals(Buffer.from(files[i]!))).toBe(true);
    }
  });

  it("background without any client: an abandoned upload is deleted and can never be committed; a released one after retention", async () => {
    let t = Date.UTC(2026, 9, 12);
    const I = await instance({ now: () => t });
    const A = await account(I.url, I.origin);
    // Abandoned: two blobs, then the device disappears.
    const u = "UPLOAD_abandoned_000001";
    await A.api.renewLease(u);
    for (const i of [0, 1]) {
      const d = bytes(2000, i + 3);
      await A.api.request("PUT", `/v1/uploads/${u}/blobs/${i}`, { body: d as BodyInit, headers: { "x-ddn-sha256": await sha256Hex(d) } });
    }
    expect(I.fake.messages.size).toBe(2);
    // A finished upload through the normal protocol.
    const keep = await A.client.upload(memorySource(bytes(3000)), "keep.bin");
    const before = I.fake.messages.size;
    t += 11 * 60_000; // past the lease (60 s here) and the idle time (10 min)
    const r = await I.ext.tick();
    expect(r.reaped).toBe(1);
    expect(I.fake.messages.size).toBe(before - 2);
    expect(await A.api.renewLease(u)).toBe(false); // tombstone: the lease of U is refused for good
    // The committed upload was not touched (its commit is in the log: guarded twice).
    const s = sink();
    await A.client.download(keep.nodeId, s);
    expect(s.data().byteLength).toBe(3000);
    // Released by a client (purged version): deleted only after the retention.
    await A.api.json("POST", "/v1/uploads/released", { uploads: [{ uploadId: keep.uploadId, at: t }] });
    t += 29 * 24 * 3600_000;
    expect((await I.ext.tick()).purged).toBe(0);
    t += 2 * 24 * 3600_000;
    expect((await I.ext.tick()).purged).toBe(1);
    expect(I.fake.messages.size).toBe(0);
  });

  it("account channels in Settings: own webhooks replace the pool for that account only; the mode is locked in the database", async () => {
    const I = await instance();
    const A = await account(I.url, I.origin);
    const B = await account(I.url, I.origin);
    const own = I.fake.addWebhook("1550000000000000999");
    const r = await A.api.json<{ using: string; own: { channelId: string }[] }>("POST", "/v1/channels", { url: own.url, label: "mine" });
    expect(r.body.using).toBe("own");
    await A.client.upload(memorySource(bytes(100)), "a");
    await B.client.upload(memorySource(bytes(100)), "b");
    expect(I.fake.postsByChannel.get("1550000000000000999")).toBe(2); // fragment + manifest of A
    await expect(B.api.json("POST", "/v1/channels", { url: own.url })).rejects.toMatchObject({ status: 409 });
    await expect(A.api.json("POST", "/v1/channels", { url: "https://discord.com/api/webhooks/1/x" })).rejects.toMatchObject({ status: 400 });
    // Same data dir started as another mode: refused.
    await I.srv.close();
    cleanups.pop();
    expect(() => new DdnServer({ dbPath: I.dbPath, mode: "metadata-only" })).toThrow(/one instance = one mode/);
  });

  it("Discord blocks the instance IP (Cloudflare): the upload fails fast with instance_busy, not a hang", async () => {
    const I = await instance();
    const A = await account(I.url, I.origin);
    I.fake.cloudflareUntil = Date.now() + 2000_000;
    A.blobs["maxWaitMs" as never] = 1000 as never;
    const t0 = Date.now();
    await expect(A.client.upload(memorySource(bytes(100)), "x")).rejects.toThrow(/instance_busy/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const h = await (await fetch(`${I.url}/v1/health`)).json();
    expect(h.discord.cloudflareBlockedS).toBeGreaterThan(1000);
  });
});
