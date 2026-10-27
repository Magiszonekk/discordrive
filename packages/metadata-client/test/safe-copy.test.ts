// Copies of the Safe on the account's channels: the instance's database lost (or restored from an old
// backup) does not lose the Safe; the account's rescue kit reaches the copies, only the Safe's password opens them.
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  ChannelPacer,
  DiscordWebhookTransport,
  EncryptedArbiter,
  HttpApi,
  MetadataClient,
  OpCodec,
  SafeBadPasswordError,
  SafeCopier,
  SafeStore,
  SafeTree,
  SAFE_COPY_CHECK_MS,
  SAFE_COPY_QUIET_MS,
  clientBlobIO,
  createPointerMessage,
  makeRescueKit,
  memorySource,
  putBackSafe,
  readPointer,
  rescueRegisterDevice,
  rescueKey,
  generateDeviceKey,
  safeChildren,
  safeFromRescueKit,
  copiesSlotApi,
  syncSafeCopies,
  instanceSlotSource,
  writeSnapshot,
  rehomeChain,
  readSafeCopies,
  accountKeyFromB64,
  type ByteSink,
  type SafeTreeState,
} from "../src/index.js";
import { FakeDiscord } from "../src/node/index.js";
import { closeServers, newAccount, startServer } from "./http-helpers.js";

afterEach(closeServers);
const FAST = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const PW = "correct horse battery staple";
function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (d) => void parts.push(new Uint8Array(d)), data: () => new Uint8Array(Buffer.concat(parts)) };
}

async function world() {
  const fake = new FakeDiscord();
  const origin = await fake.listen();
  const transport = new DiscordWebhookTransport({ apiOrigin: origin });
  const hook = fake.addWebhook("1550000000000000951");
  const mkClient = (key: ReturnType<typeof accountKeyFromB64>, accountId: string, api: HttpApi, dev: string) =>
    new MetadataClient({ device: { id: dev, name: dev }, arbiter: new EncryptedArbiter(new OpCodec(key, accountId), api), transport, webhooks: [{ id: hook.id, url: hook.url }], chunkSize: 64 * 1024, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }) });
  return { fake, origin, transport, hook, mkClient };
}

describe("copies of the Safe on the account's channels", () => {
  it("server without its database → account from the rescue kit → the Safe opens with its password (files too); the kit alone does not open it", async () => {
    const w = await world();
    try {
      // The instance A: account, a Safe with a folder and a file, snapshots on the account's webhook.
      const A = await startServer();
      const a = await newAccount(A.url);
      const ca = w.mkClient(a.key, a.accountId, a.api, a.deviceId);
      const io = clientBlobIO(ca, w.transport);
      const loc = await createPointerMessage(io, a.key, a.accountId, { id: w.hook.id }, { list: [{ kind: "discord-webhook", id: w.hook.id, url: w.hook.url }], revision: 1 });
      await ca.commitOp({ type: "create", kind: "folder", nodeId: "fold-0000000000000001", parentId: "root", name: "Zdjęcia" }, "mkdir");
      await writeSnapshot({ io, key: a.key, accountId: a.accountId, pointer: loc, log: a.api, store: ca.store, now: () => Date.now() }, "base");

      const tree = new SafeTree(new SafeStore<SafeTreeState>(a.api, a.key, a.accountId), { id: a.deviceId, name: "laptop" }, { pieces: { kind: "webhooks", client: ca } });
      let u = await tree.create(PW, FAST);
      u = (await tree.mkdir(u, "Dokumenty")).safe;
      const folder = safeChildren(u, "root")[0]!.id;
      const data = new Uint8Array(randomBytes(64 * 1024 + 99));
      const up = await tree.upload(u, ca, memorySource(data), "paszport.jpg", folder);
      u = up.safe;
      const r1 = await syncSafeCopies(io, a.key, a.accountId, loc, instanceSlotSource(a.api), () => Date.now());
      expect(r1.copied?.revision).toBe(u.revision);
      // A second round with no change copies nothing.
      expect((await syncSafeCopies(io, a.key, a.accountId, loc, instanceSlotSource(a.api), () => Date.now())).copied).toBeNull();
      // Nothing of the Safe in clear on Discord.
      for (const m of w.fake.messages.values()) for (const att of m.attachments) expect(Buffer.from(att.data).toString("latin1")).not.toMatch(/paszport|Dokumenty/);

      // Disaster: the instance and its database are gone. Only the rescue kit is left.
      await closeServers();
      const kit = makeRescueKit(a.accountId, a.key.rawB64, loc, [{ kind: "discord-webhook", id: w.hook.id, url: w.hook.url }]);
      // With no instance at all: the copies open read-only, with the password only.
      const ro = await safeFromRescueKit<SafeTreeState>(kit, w.transport);
      await expect(ro.store.unlock("not the password 1")).rejects.toBeInstanceOf(SafeBadPasswordError);
      const opened = await ro.store.unlock(PW);
      expect(safeChildren(opened, folder).map((n) => n.name)).toEqual(["paszport.jpg"]);

      // A new instance B with an empty database: the account comes back from its kit (the operator puts the
      // account back: its ID and the rescue key from the kit; this repo has no CLI for it yet), a device
      // registers with the rescue key, and its first copy round puts the Safe back into B's slot.
      const B = await startServer();
      const key = accountKeyFromB64(a.key.rawB64);
      const db = (B.srv as unknown as { db: { prepare(q: string): { run(...x: unknown[]): unknown } } }).db;
      db.prepare("INSERT INTO accounts (id, rescue_pub, created_at) VALUES (?, ?, ?)").run(a.accountId, (await rescueKey(key)).publicKey, Date.now());
      const dk = await generateDeviceKey();
      const { deviceId } = await rescueRegisterDevice(B.url, key, a.accountId, dk);
      const api = new HttpApi({ baseUrl: B.url, accountId: a.accountId, deviceId, key: dk });
      expect(await new SafeStore(api, key, a.accountId).exists()).toBe(false);
      const cb = w.mkClient(key, a.accountId, api, deviceId);
      const copier = new SafeCopier({ io: clientBlobIO(cb, w.transport), key, accountId: a.accountId, pointer: () => loc, api, now: () => Date.now() });
      const t = await copier.tick();
      expect(t?.putBack).toBe(u.revision);
      // The account's rescue kit (the account key) alone does not open it; the Safe's password does, files included.
      await expect(new SafeStore<SafeTreeState>(api, key, a.accountId).unlock("guessing 12345")).rejects.toBeInstanceOf(SafeBadPasswordError);
      const back = await new SafeStore<SafeTreeState>(api, key, a.accountId).unlock(PW);
      expect(back.revision).toBe(u.revision);
      const tb = new SafeTree(new SafeStore<SafeTreeState>(api, key, a.accountId), { id: deviceId, name: "new" }, { pieces: { kind: "webhooks", client: cb } });
      const s1 = sink();
      await tb.download(back, cb, up.nodeId, s1);
      expect(Buffer.compare(Buffer.from(s1.data()), Buffer.from(data))).toBe(0);
      // It keeps working: a change on B is the next revision, and the next round copies it.
      const after = await new SafeStore<SafeTreeState>(api, key, a.accountId).update(back, (st) => st);
      expect(after.revision).toBe(u.revision + 1);
      expect((await copier.tick(true))?.copied?.revision).toBe(u.revision + 1);
    } finally {
      await w.fake.close();
    }
  }, 120_000);
});

describe("copies follow the instance's history", () => {
  it("history copied over time; a new password drops the copies under the old one; an older backup of the database gets the newer Safe back", async () => {
    const w = await world();
    try {
      const { srv, url } = await startServer();
      const a = await newAccount(url);
      const ca = w.mkClient(a.key, a.accountId, a.api, a.deviceId);
      const io = clientBlobIO(ca, w.transport);
      const loc = await createPointerMessage(io, a.key, a.accountId, { id: w.hook.id });
      let t = Date.UTC(2026, 9, 27, 12);
      const copier = new SafeCopier({ io, key: a.key, accountId: a.accountId, pointer: () => loc, api: a.api, now: () => t });
      const st = new SafeStore<{ n: number }>(a.api, a.key, a.accountId);
      let u = await st.create("old password 123", { n: 0 }, FAST);
      expect((await copier.tick())?.copied?.revision).toBe(1); // first round: at once
      u = await st.update(u, () => ({ n: 1 }));
      t += 10_000;
      expect(await copier.tick()).toBeNull(); // asked less than a minute ago
      t += SAFE_COPY_CHECK_MS;
      expect(await copier.tick()).toBeNull(); // changed just now: waits for a quiet minute
      t += SAFE_COPY_QUIET_MS + SAFE_COPY_CHECK_MS;
      expect((await copier.tick())?.copied?.revision).toBe(2);
      let p = await readPointer(io, a.key, a.accountId, loc);
      expect(p.safe!.copies.map((c) => c.revision)).toEqual([2, 1]);

      // A backup of the database from now (revision 2) ...
      u = await st.update(u, () => ({ n: 3 }));
      u = await st.changePassword(u, "new password 456", FAST);
      const r = await syncSafeCopies(io, a.key, a.accountId, loc, instanceSlotSource(a.api), () => t);
      // The instance dropped its history with the new password: the copies under the old one go too.
      expect(r.copied?.revision).toBe(4);
      expect(r.dropped.map((c) => c.revision).sort()).toEqual([1, 2]);
      p = await readPointer(io, a.key, a.accountId, loc);
      expect(p.safe!.copies.map((c) => c.revision)).toEqual([4]);
      const msgs = [...w.fake.messages.values()].filter((m) => m.attachments.some((x) => x.filename === "ddn-safe.txt"));
      expect(msgs.length).toBe(1);

      // ... the database goes back to an old state (restored from a backup): the slot at revision 2, old password.
      const db = (srv as unknown as { db: { prepare(q: string): { run(...x: unknown[]): unknown } } }).db;
      const r2 = (await import("node:crypto")).randomBytes(8).toString("hex");
      db.prepare("UPDATE slots SET revision = 2, blob = ? WHERE account_id = ?").run(Buffer.from(r2).toString("base64"), a.accountId);
      db.prepare("DELETE FROM slot_history WHERE account_id = ?").run(a.accountId);
      expect((await syncSafeCopies(io, a.key, a.accountId, loc, instanceSlotSource(a.api), () => t)).behind?.revision).toBe(4);
      expect(await putBackSafe(io, a.key, a.accountId, loc, a.api)).toBe(4);
      expect((await new SafeStore<{ n: number }>(a.api, a.key, a.accountId).unlock("new password 456")).state.n).toBe(3);
      await expect(new SafeStore<{ n: number }>(a.api, a.key, a.accountId).unlock("old password 123")).rejects.toBeInstanceOf(SafeBadPasswordError);
      // What the instance had is kept in its history, not thrown away.
      expect((await a.api.slotHistory("safe")).map((h) => h.revision)).toEqual([2]);
    } finally {
      await w.fake.close();
    }
  }, 120_000);
});

describe("a moved snapshot channel takes the Safe's copies along", () => {
  it("rehomeChain copies them to the new channel (byte for byte) and lists the old ones for deletion", async () => {
    const w = await world();
    try {
      const { url } = await startServer();
      const a = await newAccount(url);
      const hook2 = w.fake.addWebhook("1550000000000000952");
      const ca = new MetadataClient({ device: { id: a.deviceId, name: "d" }, arbiter: new EncryptedArbiter(new OpCodec(a.key, a.accountId), a.api), transport: w.transport, webhooks: [{ id: w.hook.id, url: w.hook.url }, { id: hook2.id, url: hook2.url }], chunkSize: 64 * 1024, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }) });
      const io = clientBlobIO(ca, w.transport);
      const loc = await createPointerMessage(io, a.key, a.accountId, { id: w.hook.id });
      const st = new SafeStore<{ n: number }>(a.api, a.key, a.accountId);
      let u = await st.create(PW, { n: 1 }, FAST);
      await syncSafeCopies({ ...io, post: (d, f) => ca.postBlobTo(w.hook.id, d, f) }, a.key, a.accountId, loc, instanceSlotSource(a.api), () => Date.now());
      u = await st.update(u, () => ({ n: 2 }));
      await syncSafeCopies({ ...io, post: (d, f) => ca.postBlobTo(w.hook.id, d, f) }, a.key, a.accountId, loc, instanceSlotSource(a.api), () => Date.now());
      const before = await readPointer(io, a.key, a.accountId, loc);
      expect(before.safe!.copies.every((c) => c.webhookId === w.hook.id)).toBe(true);
      const moved = await rehomeChain(io, a.key, a.accountId, loc, { id: hook2.id }, (d, f) => ca.postBlobTo(hook2.id, d, f), () => Date.now());
      expect(moved.pointer.safe!.copies.map((c) => [c.revision, c.webhookId])).toEqual([[2, hook2.id], [1, hook2.id]]);
      for (const c of before.safe!.copies) expect(moved.old.some((o) => o.messageId === c.messageId)).toBe(true);
      const copies = await readSafeCopies(io, a.key, a.accountId, await readPointer(io, a.key, a.accountId, moved.loc));
      expect(copies.map((c) => c.revision)).toEqual([2, 1]);
      expect((await new SafeStore<{ n: number }>(copiesSlotApi(copies), a.key, a.accountId).unlock(PW)).state.n).toBe(2);
    } finally {
      await w.fake.close();
    }
  }, 60_000);
});
