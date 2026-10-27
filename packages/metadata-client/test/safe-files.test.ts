// Files in the Safe: pieces and manifest stored like any file, the reference (with the file key) only in the
// Safe's sealed state; nothing in the account's log. metadata only (the account's webhooks on a fake Discord)
// and e2ee (through the instance, which must not reap the upload as abandoned).
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { DiscordWebhookTransport, DriveClient, EncryptedArbiter, HttpApi, MetadataClient, OpCodec, SafeStore, SafeTree, ChannelPacer, decodeManifestRef, memorySource, safeChildren, safeTreeOf, type ByteSink, type SafeTreeState } from "../src/index.js";
import { ServerBlobStore } from "../src/server-blobs.js";
import { FakeDiscord } from "../src/node/index.js";
import { addDevice, closeServers, newAccount, startServer } from "./http-helpers.js";

afterEach(closeServers);
const FAST = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (d) => void parts.push(new Uint8Array(d)), data: () => new Uint8Array(Buffer.concat(parts)) };
}

describe("files in the Safe", () => {
  it("metadata only: upload into a Safe folder, another device reads it with the password; the account's log has nothing; no key outside the Safe", async () => {
    const fake = new FakeDiscord();
    const origin = await fake.listen();
    try {
      const { srv, url } = await startServer();
      const a = await newAccount(url);
      const hook = fake.addWebhook("1550000000000000901");
      const mk = (api: HttpApi, dev: string) =>
        new MetadataClient({ device: { id: dev, name: dev }, arbiter: new EncryptedArbiter(new OpCodec(a.key, a.accountId), api), transport: new DiscordWebhookTransport({ apiOrigin: origin }), webhooks: [{ id: hook.id, url: hook.url }], chunkSize: 64 * 1024, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }) });
      const ca = mk(a.api, a.deviceId);
      const tree = new SafeTree(new SafeStore<SafeTreeState>(a.api, a.key, a.accountId), { id: a.deviceId, name: "laptop" });
      let u = await tree.create("correct horse battery staple", FAST);
      u = (await tree.mkdir(u, "Skany")).safe;
      const folder = safeChildren(u, "root")[0]!.id;
      const data = new Uint8Array(randomBytes(64 * 1024 * 3 + 77));
      const up = await tree.upload(u, ca, memorySource(data), "paszport-skan.jpg", folder);
      u = up.safe;
      expect(up.result.outcome).toBe("applied");
      expect(safeChildren(u, folder).map((n) => [n.name, n.content?.sizeBytes])).toEqual([["paszport-skan.jpg", data.byteLength]]);
      expect(fake.messages.size).toBe(5); // 4 fragments + manifest on the account's webhook

      // The account's log: empty (no upload_begin / commit / create). Its index: no such file.
      const db = (srv as unknown as { db: { prepare(q: string): { get(...x: unknown[]): { n: number } } } }).db;
      expect(db.prepare("SELECT count(*) AS n FROM log WHERE account_id = ?").get(a.accountId).n).toBe(0);
      await ca.pull();
      expect([...ca.store.allNodes()].some((n) => n.name === "paszport-skan.jpg")).toBe(false);

      // Another device: with the password it reads the file (bytes and hash); its own index never had it.
      const b = await addDevice(url, a);
      const cb = mk(b.api, b.deviceId);
      const tb = new SafeTree(new SafeStore<SafeTreeState>(b.api, a.key, a.accountId), { id: b.deviceId, name: "phone" });
      const ub = await new SafeStore<SafeTreeState>(b.api, a.key, a.accountId).unlock("correct horse battery staple");
      const s = sink();
      await tb.download(ub, cb, up.nodeId, s);
      expect(sha(s.data())).toBe(sha(data));
      // The file key is in the Safe's state only: not in any Discord message in clear, not in the instance's DB.
      const ref = safeTreeOf(ub).getNode(up.nodeId)!.content!.manifestRef;
      const fileKey = decodeManifestRef(ref).k;
      expect(fileKey.length).toBeGreaterThan(20);
      // Every table of the instance (log, slots, its history, devices, …): the file key and the name nowhere.
      const sdb = (srv as unknown as { db: { prepare(q: string): { all(): { name: string }[] } } }).db;
      for (const { name } of sdb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
        const dump = JSON.stringify(sdb.prepare(`SELECT * FROM "${name}"`).all());
        expect(dump, name).not.toContain(fileKey);
        expect(dump, name).not.toContain("paszport");
      }
      for (const m of fake.messages.values()) for (const att of m.attachments) expect(Buffer.from(att.data).toString("latin1")).not.toContain("paszport");
    } finally {
      await fake.close();
    }
  }, 60_000);
});
