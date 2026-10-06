import { describe, expect, it } from "vitest";
import { canonicalState, checkInvariants, MemoryIndexStore, ROOT_ID } from "@ddv4/sync-core";
import {
  EncryptedArbiter,
  InProcessLogServer,
  MemoryTransport,
  MetadataClient,
  OpCodec,
  clientBlobIO,
  createPointerMessage,
  decideSnapshot,
  decodeRescueKit,
  emptyPointer,
  encodeRescueKit,
  memorySource,
  newAccountKey,
  readPointer,
  rescueBlobIO,
  restoreFromDiscord,
  writePointer,
  writeSnapshot,
  BASE_MAX_AGE_MS,
  SEGMENT_MAX_DELAY_MS,
  SEGMENT_QUIET_MS,
  type ByteSink,
  type WebhookRef,
} from "../src/index.js";

const ACCT = "acct-snap";
const HOOK: WebhookRef = { id: "333333333333333333", url: `https://discord.com/api/webhooks/333333333333333333/${"T".repeat(68)}` };

function clock(start = Date.UTC(2026, 9, 6)) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

function world() {
  const c = clock();
  const key = newAccountKey();
  const transport = new MemoryTransport();
  const server = new InProcessLogServer({ now: c.now });
  const mk = (id: string) =>
    new MetadataClient({
      device: { id, name: id },
      arbiter: new EncryptedArbiter(new OpCodec(key, ACCT), server.session(id)),
      transport,
      webhooks: [{ ...HOOK }],
      chunkSize: 500,
      now: c.now,
      sleep: c.sleep,
    });
  return { c, key, transport, server, mk };
}

async function mkdir(cl: MetadataClient, id: string, name: string, parent = ROOT_ID) {
  await cl.commitOp({ type: "create", kind: "folder", nodeId: id, parentId: parent, name }, "mkdir");
}

function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    write: async (d) => void parts.push(new Uint8Array(d)),
    data: () => {
      const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
      let o = 0;
      for (const p of parts) (out.set(p, o), (o += p.byteLength));
      return out;
    },
  };
}

describe("snapshots on Discord + pointer message (koncept §6.2)", () => {
  it("segments + base + segments restore the exact tree with no server (rescue kit, §3.5)", async () => {
    const w = world();
    const a = w.mk("dev-A");
    const io = clientBlobIO(a, w.transport, 400); // tiny parts: the base is split
    const loc = await createPointerMessage(io, w.key, ACCT, a.webhook(HOOK.id));
    const deps = () => ({ io, key: w.key, accountId: ACCT, pointer: loc, log: w.server.session("dev-A"), store: a.store, now: w.c.now });

    await mkdir(a, "fold-00001", "Zdjęcia");
    const data = crypto.getRandomValues(new Uint8Array(1700));
    const up = await a.upload(memorySource(data), "plaża.jpg", "fold-00001");
    let r = await writeSnapshot(deps(), "segment");
    expect(r).toMatchObject({ kind: "segment", written: "written" });
    expect(r.pointer.toSeq).toBe(a.replica.headSeq);

    for (let i = 2; i <= 30; i++) await mkdir(a, `fold-${String(i).padStart(5, "0")}`, `Folder ${i}`);
    r = await writeSnapshot(deps(), "base");
    expect(r.kind).toBe("base");
    expect(r.pointer.base!.parts.length).toBeGreaterThan(1);
    expect(r.pointer.segmentBytesSinceBase).toBe(0);

    await a.commitOp({ type: "rename", nodeId: "fold-00002", name: "Dokumenty" }, "rename");
    await a.commitOp({ type: "trash", nodeId: "fold-00003" }, "trash");
    r = await writeSnapshot(deps(), "segment");
    expect(r.pointer.lastSegment!.fromSeq).toBe(r.pointer.base!.headSeq + 1);

    // Disaster: server and every device gone. Only the rescue kit is left.
    const kit = decodeRescueKit(encodeRescueKit({ v: 1, accountId: ACCT, key: w.key.rawB64, webhookUrl: HOOK.url, pointerMessageId: loc.messageId }));
    const { accountKeyFromB64 } = await import("../src/account-key.js");
    const key2 = accountKeyFromB64(kit.key);
    const rio = rescueBlobIO(w.transport, { id: HOOK.id, url: kit.webhookUrl });
    const restored = await restoreFromDiscord(rio, key2, kit.accountId, { webhookId: HOOK.id, messageId: kit.pointerMessageId });
    expect(canonicalState(restored.store)).toBe(canonicalState(a.store));
    expect(checkInvariants(restored.store)).toEqual([]);
    expect(restored.tail.length).toBe(2);

    // A new instance: server log reseeded with the tail, a device on the restored tree downloads the file.
    const server2 = new InProcessLogServer({ now: w.c.now });
    const b = new MetadataClient({
      device: { id: "dev-B", name: "B" },
      arbiter: new EncryptedArbiter(new OpCodec(key2, ACCT), server2.session("dev-B")),
      transport: w.transport,
      webhooks: [{ ...HOOK }],
      store: restored.store,
      now: w.c.now,
      sleep: w.c.sleep,
    });
    const s = sink();
    await b.download(up.nodeId, s);
    expect(s.data()).toEqual(data);
  });

  it("restores from segments alone (no base yet) and from a chain spanning a base", async () => {
    const w = world();
    const a = w.mk("dev-A");
    const io = clientBlobIO(a, w.transport);
    const loc = await createPointerMessage(io, w.key, ACCT, a.webhook(HOOK.id));
    const deps = { io, key: w.key, accountId: ACCT, pointer: loc, log: w.server.session("dev-A"), store: a.store, now: w.c.now };
    for (let k = 0; k < 4; k++) {
      await mkdir(a, `fold-k${k}0000`, `k${k}`);
      await writeSnapshot(deps, "segment");
    }
    const r = await restoreFromDiscord(io, w.key, ACCT, loc);
    expect(r.baseHeadSeq).toBe(0);
    expect(canonicalState(r.store)).toBe(canonicalState(a.store));
  });

  it("the pointer never goes back; two devices snapshotting is harmless", async () => {
    const w = world();
    const a = w.mk("dev-A");
    const b = w.mk("dev-B");
    const io = clientBlobIO(a, w.transport);
    const loc = await createPointerMessage(io, w.key, ACCT, a.webhook(HOOK.id));
    await mkdir(a, "fold-00001", "x");
    await mkdir(a, "fold-00002", "y");
    await b.pull();
    // B snapshots first, at the same head.
    const rb = await writeSnapshot({ io: clientBlobIO(b, w.transport), key: w.key, accountId: ACCT, pointer: loc, log: w.server.session("dev-B"), store: b.store, now: w.c.now }, "segment");
    expect(rb.written).toBe("written");
    // A has nothing new: no posts, pointer untouched.
    const ra = await writeSnapshot({ io, key: w.key, accountId: ACCT, pointer: loc, log: w.server.session("dev-A"), store: a.store, now: w.c.now }, "segment");
    expect(ra).toMatchObject({ kind: "none", written: "nothing", posts: 0 });
    // A stale write (lower toSeq) is refused.
    const stale = { ...emptyPointer(), toSeq: 1, writtenAt: 1 };
    expect(await writePointer(io, w.key, ACCT, loc, stale)).toBe("kept_newer");
    expect((await readPointer(io, w.key, ACCT, loc)).toSeq).toBe(2);
  });

  it("nothing readable on Discord and a forged/relabelled object is rejected", async () => {
    const w = world();
    const a = w.mk("dev-A");
    const io = clientBlobIO(a, w.transport);
    const loc = await createPointerMessage(io, w.key, ACCT, a.webhook(HOOK.id));
    await mkdir(a, "fold-00001", "Tajny folder");
    await writeSnapshot({ io, key: w.key, accountId: ACCT, pointer: loc, log: w.server.session("dev-A"), store: a.store, now: w.c.now }, "base");
    for (const m of w.transport.messages.values()) {
      const t = new TextDecoder("latin1").decode(m.attachments[0]!.data);
      expect(t).not.toContain("Tajny");
      expect(t).not.toContain("fold-00001");
    }
    await expect(readPointer(io, newAccountKey(), ACCT, loc)).rejects.toThrow(/cannot decrypt pointer/);
    await expect(readPointer(io, w.key, "acct-other", loc)).rejects.toThrow(/cannot decrypt pointer/);
  });

  it("policy: 1 min quiet / 5 min max for segments, 20 % or 7 days for bases, phone never writes bases", () => {
    const t = 1_000_000_000;
    const p = { ...emptyPointer(), toSeq: 10, base: { headSeq: 5, parts: [], size: 1000, createdAt: t - 1000 }, segmentBytesSinceBase: 100 };
    const quiet = { lastEntryAt: t - SEGMENT_QUIET_MS, firstPendingAt: t - SEGMENT_QUIET_MS };
    expect(decideSnapshot(t, 10, p, quiet, { unmetered: true })).toBe("none"); // nothing new
    expect(decideSnapshot(t, 11, p, { lastEntryAt: t - 1000, firstPendingAt: t - 2000 }, { unmetered: true })).toBe("none");
    expect(decideSnapshot(t, 11, p, quiet, { unmetered: true })).toBe("segment");
    expect(decideSnapshot(t, 11, p, { lastEntryAt: t - 1000, firstPendingAt: t - SEGMENT_MAX_DELAY_MS }, { unmetered: true })).toBe("segment");
    expect(decideSnapshot(t, 11, { ...p, segmentBytesSinceBase: 201 }, quiet, { unmetered: true })).toBe("base");
    expect(decideSnapshot(t, 11, { ...p, segmentBytesSinceBase: 201 }, quiet, { unmetered: false })).toBe("segment");
    expect(decideSnapshot(t, 11, { ...p, base: { ...p.base, createdAt: t - BASE_MAX_AGE_MS } }, quiet, { unmetered: true })).toBe("base");
    expect(decideSnapshot(t, 11, { ...p, base: null }, quiet, { unmetered: true })).toBe("base");
  });

  it("a broken chain is detected instead of restoring a wrong tree", async () => {
    const w = world();
    const a = w.mk("dev-A");
    const io = clientBlobIO(a, w.transport);
    const loc = await createPointerMessage(io, w.key, ACCT, a.webhook(HOOK.id));
    const deps = { io, key: w.key, accountId: ACCT, pointer: loc, log: w.server.session("dev-A"), store: a.store, now: w.c.now };
    await mkdir(a, "fold-00001", "a");
    const r1 = await writeSnapshot(deps, "segment");
    await mkdir(a, "fold-00002", "b");
    await writeSnapshot(deps, "segment");
    await w.transport.deleteMessage(a.webhook(HOOK.id), r1.pointer.lastSegment!.messageId);
    await expect(restoreFromDiscord(io, w.key, ACCT, loc, new MemoryIndexStore())).rejects.toThrow();
  });
});
