// Removing a channel in metadata only: impact from the local
// index, critical detection (pointer + chain), move with relocate ops (resumable after an
// interruption, no file posted twice), the snapshot chain re-homed: restore from the NEW rescue kit
// works, the old pointer is not updated any more; remove anyway -> unavailable (computed), pasting
// the webhook again -> available; drain: after the retention the old messages go, the webhook leaves.
import { describe, expect, it } from "vitest";
import { ROOT_ID, canonicalState, checkInvariants } from "@ddv4/sync-core";
import {
  ChannelMover,
  ChannelPacer,
  DRAIN_AFTER_MS,
  EncryptedArbiter,
  InProcessLogServer,
  MemoryTransport,
  MemoryVaultStore,
  MetadataClient,
  OpCodec,
  WebhookVault,
  backfillPieces,
  clientBlobIO,
  createPointerMessage,
  finishDrain,
  memorySource,
  newAccountKey,
  readPointer,
  refreshUnavailable,
  rescueBlobIO,
  restoreFromDiscord,
  snapshotHooks,
  writeSnapshot,
  type ByteSink,
} from "../src/index.js";
import { SqliteIndexStore } from "../src/node/sqlite-store.js";

const ACCT = "acct-chan";
const H = ["111111111111111111", "222222222222222222", "333333333333333333"].map((id) => ({ id, url: `mem://hook/${id}`, channelId: `c${id.slice(0, 3)}`, guildId: null, label: `#${id.slice(0, 3)}`, addedAt: Number(id[0]) }));

function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (d) => void parts.push(new Uint8Array(d)), data: () => Buffer.concat(parts) };
}

async function world(hooks = H) {
  let now = Date.UTC(2026, 9, 13, 10);
  const key = newAccountKey();
  const transport = new MemoryTransport();
  const server = new InProcessLogServer({ now: () => now });
  const vstore = new MemoryVaultStore();
  const vault = new WebhookVault(vstore, key, ACCT);
  for (const h of hooks) await vault.addWebhook(h);
  const store = new SqliteIndexStore();
  const arb = new EncryptedArbiter(new OpCodec(key, ACCT), server.session("dev-A"));
  const mk = async (st = store) =>
    new MetadataClient({
      device: { id: "dev-A", name: "A" },
      arbiter: arb,
      transport,
      webhooks: (await vault.load()).webhooks.map((w) => ({ id: w.id, url: w.url, channelId: w.channelId, ...(w.retired ? { retired: true } : {}) })),
      store: st,
      chunkSize: 400,
      now: () => now,
      sleep: async () => {},
      pacer: new ChannelPacer({ perMin: 600_000, maxPerMin: 600_000, burst: 10_000 }),
    });
  const a = await mk();
  const io = clientBlobIO(a, transport, 600);
  const loc = await createPointerMessage(io, key, ACCT, a.webhook(H[0]!.id));
  await vault.update((x) => ((x.pointer = loc), x));
  const files: { id: string; data: Uint8Array }[] = [];
  for (let i = 0; i < 6; i++) {
    const data = crypto.getRandomValues(new Uint8Array(900 + i * 300));
    files.push({ id: (await a.upload(memorySource(data), `f${i}.bin`, ROOT_ID)).nodeId, data });
  }
  // Two segments + a base so the chain spans channels (round-robin posts).
  await writeSnapshot({ io, key, accountId: ACCT, pointer: loc, log: server.session("dev-A"), store: a.store, now: () => now }, "base");
  await a.commitOp({ type: "create", kind: "folder", nodeId: "fold-0001", parentId: ROOT_ID, name: "docs" }, "mkdir");
  await writeSnapshot({ io, key, accountId: ACCT, pointer: loc, log: server.session("dev-A"), store: a.store, now: () => now }, "segment");
  const mover = (c: MetadataClient) => new ChannelMover({ client: c, store, vault, key, accountId: ACCT, transport, log: arb, now: () => now });
  return { key, transport, server, vault, store, a, io, loc, files, mk, mover, arb, clock: { add: (ms: number) => void (now += ms), get: () => now } };
}

describe("remove a channel (metadata only)", () => {
  it("impact from the local index; critical = pointer or chain objects; remove anyway -> unavailable; re-paste -> back", async () => {
    const w = await world();
    const crit = await snapshotHooks(w.io, w.key, ACCT, await w.vault.load());
    expect(crit.get(H[0]!.id)).toContain("pointer");
    expect([...crit.values()].flat()).toContain("snapshots");
    const st = w.store.locationStats();
    // Round-robin: every file has pieces on every channel here.
    for (const h of H) expect(st.get(h.id)!.files).toBe(6);
    expect(w.store.filesAt(H[2]!.id).rows.map((r) => r.name).sort()).toEqual(["f0.bin", "f1.bin", "f2.bin", "f3.bin", "f4.bin", "f5.bin"]);
    // Remove H[2] anyway: every file with a piece there is unavailable (nothing is deleted).
    const posts = w.transport.messages.size;
    await w.vault.removeWebhook(H[2]!.id, "removed");
    const un = refreshUnavailable(w.store, await w.vault.load());
    expect(un.length).toBe(6);
    expect(w.transport.messages.size).toBe(posts);
    expect(w.store.storageTotals().unavailableFiles).toBe(6);
    expect(w.store.countChildren(ROOT_ID, true)).toBe(1); // only the folder is shown
    expect((await w.vault.load()).removed?.[0]).toMatchObject({ id: H[2]!.id, how: "removed" });
    // Pasting the same webhook again: available at once, the removed entry is gone.
    await w.vault.addWebhook(H[2]!);
    expect(refreshUnavailable(w.store, await w.vault.load())).toEqual([]);
    expect((await w.vault.load()).removed).toEqual([]);
  });

  it("move a critical channel: resumable, files readable, new chain + new rescue kit restore; old pointer frozen; drain after retention", async () => {
    const w = await world();
    const W = H[0]!.id; // pointer channel
    const before = canonicalState(w.store);
    // Interrupt the move after a few posts (network error), then resume.
    // From the 7th post on, Discord is unreachable (longer than the per-post retries): the move pauses.
    let n = 0;
    const realPost = w.transport.postFile.bind(w.transport);
    w.transport.postFile = async (...args) => {
      if (++n >= 7) throw new Error("network down");
      return realPost(...args);
    };
    const m = w.mover(w.a);
    const s1 = await m.run(W);
    expect(s1.state).toBe("paused");
    expect(s1.error).toMatch(/network down/);
    const moved1 = s1.done;
    w.transport.postFile = realPost;
    const postsBefore = w.transport.posts;
    const s2 = await m.run(W);
    expect(s2.state).toBe("done");
    expect(s2.critical).toBe(true);
    expect(s2.newKitNeeded).toBe(true);
    // Resume did not redo the versions finished before the interruption: at most (6 - moved1) versions re-copied.
    const perVersion = (w.transport.posts - postsBefore) / Math.max(1, 6 - moved1);
    expect(perVersion).toBeLessThan(20);
    // Nothing current on W; W is drained (retired, kept for the retention), not deleted.
    expect(w.store.filesAt(W, 0).total).toBe(0);
    const v = await w.vault.load();
    expect(v.webhooks.find((x) => x.id === W)).toMatchObject({ retired: true, drain: expect.any(Object) });
    expect(v.pointer!.webhookId).not.toBe(W);
    // The tree did not change except locators (relocate): names, sizes, versions equal.
    const strip = (x: string) => JSON.parse(x).nodes.map((n: { id: string; name: string; content: { versionId: string; sizeBytes: number } | null }) => [n.id, n.name, n.content?.versionId, n.content?.sizeBytes]);
    expect(strip(canonicalState(w.store))).toEqual(strip(before));
    expect(checkInvariants(w.store)).toEqual([]);
    // Every file downloads (SHA checked inside) from the new places, without W.
    const c2 = await w.mk();
    c2.setHookRetired(W, true);
    for (const f of w.files) {
      const s = sink();
      await c2.download(f.id, s);
      expect(Buffer.compare(s.data(), Buffer.from(f.data))).toBe(0);
    }
    // New rescue kit: pointer webhook only, no server: restore gives the current tree.
    const ptrHook = (await w.vault.load()).webhooks.find((x) => x.id === v.pointer!.webhookId)!;
    const restored = await restoreFromDiscord(rescueBlobIO(w.transport, { id: ptrHook.id, url: ptrHook.url }), w.key, ACCT, v.pointer!);
    // The re-homed chain covers what the old one covered (snapshots were written before the move).
    const oldP = await readPointer(w.io, w.key, ACCT, w.loc);
    expect(restored.pointer.toSeq).toBe(oldP.toSeq);
    // The old pointer is frozen: later snapshots go to the new one only.
    await w.a.commitOp({ type: "create", kind: "folder", nodeId: "fold-0002", parentId: ROOT_ID, name: "later" }, "mkdir");
    const io2 = clientBlobIO(c2, w.transport, 600);
    await writeSnapshot({ io: io2, key: w.key, accountId: ACCT, pointer: v.pointer!, log: w.server.session("dev-A"), store: w.store, now: w.clock.get }, "segment");
    expect((await readPointer(w.io, w.key, ACCT, v.pointer!)).toSeq).toBeGreaterThan(oldP.toSeq);
    expect((await readPointer(w.io, w.key, ACCT, w.loc)).toSeq).toBe(oldP.toSeq);
    // Drain: not before the retention; after it the old messages on W are deleted and W leaves the vault.
    const ww = (await w.vault.load()).webhooks.find((x) => x.id === W)!;
    expect((await finishDrain({ client: c2, vault: w.vault, log: w.arb, transport: w.transport, key: w.key, accountId: ACCT }, ww, w.clock.get(), Infinity)).done).toBe(false);
    w.clock.add(DRAIN_AFTER_MS + 1000);
    const onW = () => [...w.transport.messages.values()].filter((x) => x.webhookId === W).length;
    expect(onW()).toBeGreaterThan(0);
    const r = await finishDrain({ client: c2, vault: w.vault, log: w.arb, transport: w.transport, key: w.key, accountId: ACCT }, ww, w.clock.get(), Infinity);
    expect(r.done).toBe(true);
    expect(onW()).toBe(0);
    expect((await w.vault.load()).webhooks.some((x) => x.id === W)).toBe(false);
    expect((await w.vault.load()).removed?.[0]).toMatchObject({ id: W, how: "moved" });
    // Still all readable after the drain.
    for (const f of w.files) {
      const s = sink();
      await c2.download(f.id, s);
      expect(s.data().byteLength).toBe(f.data.byteLength);
    }
  });

  it("refused without another active channel; a version superseded during the move does not resurrect", async () => {
    const one = await world([H[0]!]);
    await expect(one.mover(one.a).run(H[0]!.id)).rejects.toThrow(/need_other_channel/);
    const w = await world();
    // backfill: versions without pieces (written by an older tab) get their locations from the manifests.
    expect((await backfillPieces(w.a, w.store)).left).toBe(0);
  });
});

describe("ChainIndex (which channels hold snapshot data)", () => {
  it("walks the chain once, then only new segments; equals a full walk", async () => {
    const { ChainIndex } = await import("../src/channels.js");
    const w = await world();
    let gets = 0;
    const real = w.transport.getAttachments.bind(w.transport);
    w.transport.getAttachments = async (...a) => (gets++, real(...a));
    const idx = new ChainIndex();
    const v = await w.vault.load();
    const first = await idx.hooks(w.io, w.key, ACCT, v);
    const full = await snapshotHooks(w.io, w.key, ACCT, v);
    expect([...first.what.keys()].sort()).toEqual([...full.keys()].sort());
    const g1 = gets;
    await idx.hooks(w.io, w.key, ACCT, v);
    expect(gets - g1).toBe(1); // only the pointer read, no segment walked again
    await w.a.commitOp({ type: "create", kind: "folder", nodeId: "fold-0009", parentId: ROOT_ID, name: "x" }, "mkdir");
    await writeSnapshot({ io: w.io, key: w.key, accountId: ACCT, pointer: w.loc, log: w.server.session("dev-A"), store: w.a.store, now: w.clock.get }, "segment");
    const g2 = gets;
    const again = await idx.hooks(w.io, w.key, ACCT, v);
    expect(gets - g2).toBe(2); // pointer + the one new segment
    expect([...again.what.keys()].sort()).toEqual([...(await snapshotHooks(w.io, w.key, ACCT, v)).keys()].sort());
  });
});
