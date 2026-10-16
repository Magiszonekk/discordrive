// Storage backends and the rescue kit with more than one webhook.
//
// Segments, snapshot bases, manifests and fragments are spread over every webhook of the vault. A rescue
// kit names the pointer's backend only, so the pointer carries a copy of the vault's backend list: a
// device that has nothing but the kit (server and every device lost) learns the other backends from it,
// rebuilds the tree and reads every file. Also: old kits and pointers keep working, `ddn1:` manifest
// references stay byte for byte the same for Discord, and a second backend kind (in memory) works from
// upload to restore, including Range reads, cleanup, moving a channel and the refusal to share.
import { describe, expect, it } from "vitest";
import { DAY_MS, ROOT_ID, canonicalState, checkInvariants, MemoryIndexStore } from "@ddv4/sync-core";
import {
  ChannelMover,
  ChannelPacer,
  Cleaner,
  EncryptedArbiter,
  InProcessLogServer,
  MANIFEST_REF_MAX,
  MEMORY_BACKEND_KIND,
  MemoryBackend,
  MemoryBucket,
  MemoryTransport,
  MemoryVaultStore,
  MetadataClient,
  OpCodec,
  SnapshotScheduler,
  WebhookVault,
  backendDescriptors,
  clientBackends,
  clientBlobIO,
  createPointerMessage,
  decodeManifestRef,
  encodeManifestRef,
  encodeRescueKit,
  makeRescueKit,
  memoryBackendFactory,
  memorySource,
  newAccountKey,
  openRescueKit,
  prepareShare,
  readPointer,
  restoreFromRescueKit,
  sealVault,
  openVault,
  writePointer,
  writeSnapshot,
  type AccountKey,
  type BackendDescriptor,
  type ByteSink,
  type PointerLocation,
  type VaultBackend,
  type VaultContent,
  type VaultWebhook,
} from "../src/index.js";
import { SqliteIndexStore } from "../src/node/sqlite-store.js";

const ACCT = "acct-backends";
const hookOf = (n: number): VaultWebhook => {
  const id = String(n).repeat(18).slice(0, 18);
  return { id, url: `https://discord.com/api/webhooks/${id}/${String.fromCharCode(64 + n).repeat(68)}`, channelId: `chan-${id}`, guildId: null, label: `#${n}`, addedAt: n };
};

function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (d) => void parts.push(new Uint8Array(d)), data: () => new Uint8Array(Buffer.concat(parts)) };
}

interface Account {
  key: AccountKey;
  transport: MemoryTransport;
  server: InProcessLogServer;
  vault: WebhookVault;
  a: MetadataClient;
  loc: PointerLocation;
  files: { id: string; data: Uint8Array }[];
  sched: SnapshotScheduler;
  now: { get(): number; add(ms: number): void };
  buckets: Map<string, MemoryBucket>;
}

/**
 * An account the way the web app runs it: vault with `hooks` webhooks (and optional memory backends), a
 * pointer on the first webhook, files uploaded round-robin, snapshots written by the scheduler (which
 * carries the vault's backend list in every pointer write).
 */
async function account(nHooks: number, o: { memory?: number; pointerOn?: "memory"; carryList?: boolean; files?: number } = {}): Promise<Account> {
  let t = Date.UTC(2026, 9, 16, 9);
  const now = { get: () => t, add: (ms: number) => void (t += ms) };
  const key = newAccountKey();
  const transport = new MemoryTransport((id) => `chan-${id}`);
  const server = new InProcessLogServer({ now: now.get });
  const vault = new WebhookVault(new MemoryVaultStore(), key, ACCT);
  for (let i = 1; i <= nHooks; i++) await vault.addWebhook(hookOf(i));
  const buckets = new Map<string, MemoryBucket>();
  for (let i = 1; i <= (o.memory ?? 0); i++) {
    buckets.set(`b${i}`, new MemoryBucket());
    await vault.addBackend({ kind: MEMORY_BACKEND_KIND, id: `mem-${i}`, label: `bucket ${i}`, addedAt: 100 + i, secret: { bucket: `b${i}` } });
  }
  const v = await vault.load();
  const { webhooks, backends } = clientBackends(backendDescriptors(v), memoryBackendFactory(buckets));
  const a = new MetadataClient({
    device: { id: "dev-A", name: "A" },
    arbiter: new EncryptedArbiter(new OpCodec(key, ACCT), server.session("dev-A")),
    transport,
    webhooks,
    backends,
    chunkSize: 400,
    now: now.get,
    sleep: async () => {},
    pacer: new ChannelPacer({ perMin: 600_000, maxPerMin: 600_000, burst: 10_000 }),
  });
  const io = clientBlobIO(a, transport, 700);
  const list = () => (o.carryList === false ? null : { list: backendDescriptors(vault.cached!.content), revision: vault.revision });
  const ptrAt = o.pointerOn === "memory" ? "mem-1" : webhooks[0]!.id;
  const loc = await createPointerMessage(io, key, ACCT, { id: ptrAt }, list());
  await vault.update((x) => ((x.pointer = loc), x));
  const files: { id: string; data: Uint8Array }[] = [];
  for (let i = 0; i < (o.files ?? 5); i++) {
    const data = crypto.getRandomValues(new Uint8Array(700 + 450 * i));
    files.push({ id: (await a.upload(memorySource(data), `plik-${i}.bin`, ROOT_ID)).nodeId, data });
  }
  const sched = new SnapshotScheduler({
    io,
    key,
    accountId: ACCT,
    pointer: loc,
    log: server.session("dev-A"),
    store: a.store,
    now: now.get,
    isPrimary: () => true,
    unmetered: () => true,
    serverTimeOf: () => now.get() - 2 * 60_000,
    backends: list,
  });
  // segment, base (spread over the backends), more changes, segment
  await a.commitOp({ type: "create", kind: "folder", nodeId: "fold-00001", parentId: ROOT_ID, name: "Zdjęcia" }, "mkdir");
  await writeSnapshot({ ...sched["d"], io }, "segment");
  for (let i = 2; i <= 25; i++) await a.commitOp({ type: "create", kind: "folder", nodeId: `fold-${String(i).padStart(5, "0")}`, parentId: ROOT_ID, name: `Folder ${i}` }, "mkdir");
  await writeSnapshot({ ...sched["d"], io }, "base");
  await a.commitOp({ type: "rename", nodeId: "fold-00002", name: "Dokumenty" }, "rename");
  await writeSnapshot({ ...sched["d"], io }, "segment");
  return { key, transport, server, vault, a, loc, files, sched, now, buckets };
}

/** A device with nothing but the kit text: restore the tree, then download every file (no server, no vault). */
async function fromKitOnly(w: Account, kitText: string): Promise<{ restored: string; downloads: string[]; backends: BackendDescriptor[] }> {
  const r = await restoreFromRescueKit(kitText, w.transport, { factory: memoryBackendFactory(w.buckets) });
  expect(checkInvariants(r.store)).toEqual([]);
  const { webhooks, backends } = clientBackends(r.backends, memoryBackendFactory(w.buckets));
  const k = new MetadataClient({
    device: { id: "dev-K", name: "K" },
    arbiter: new EncryptedArbiter(new OpCodec(r.key, r.kit.accountId), new InProcessLogServer({ now: w.now.get }).session("dev-K")),
    transport: w.transport,
    webhooks,
    backends,
    store: r.store,
    now: w.now.get,
    sleep: async () => {},
  });
  const downloads: string[] = [];
  for (const f of w.files) {
    const s = sink();
    await k.download(f.id, s);
    downloads.push(Buffer.compare(Buffer.from(s.data()), Buffer.from(f.data)) === 0 ? "ok" : "DIFFERENT");
  }
  return { restored: canonicalState(r.store), downloads, backends: r.backends };
}

describe("rescue kit with several webhooks: restore with no server and no device", () => {
  for (const n of [1, 2, 4]) {
    it(`${n} webhook(s): kit 3 restores the exact tree and every file`, async () => {
      const w = await account(n);
      // The objects really are spread: base parts and files on every webhook.
      const p = await readPointer(clientBlobIO(w.a), w.key, ACCT, w.loc);
      expect(new Set(p.base!.parts.map((x) => x.webhookId)).size).toBe(Math.min(n, p.base!.parts.length));
      expect(p.backends?.map((b) => b.id).sort()).toEqual(backendDescriptors((await w.vault.load())).map((b) => b.id).sort());
      const kit = makeRescueKit(ACCT, w.key.rawB64, w.loc, backendDescriptors(await w.vault.load()));
      expect(kit.startsWith("ddn-kit3:")).toBe(true);
      const r = await fromKitOnly(w, kit);
      expect(r.restored).toBe(canonicalState(w.a.store));
      expect(r.downloads).toEqual(w.files.map(() => "ok"));
    });

    it(`${n} webhook(s): an OLD kit (ddn-kit1, pointer webhook only) restores everything once the pointer carries the list`, async () => {
      const w = await account(n);
      const v = await w.vault.load();
      const ptrHook = v.webhooks.find((x) => x.id === w.loc.webhookId)!;
      const kit1 = encodeRescueKit({ v: 1, accountId: ACCT, key: w.key.rawB64, webhookUrl: ptrHook.url, pointerMessageId: w.loc.messageId });
      const r = await fromKitOnly(w, kit1);
      expect(r.restored).toBe(canonicalState(w.a.store));
      expect(r.downloads).toEqual(w.files.map(() => "ok"));
    });
  }

  it("kit 3 without the list in it (long list left out) still restores: the pointer has the list", async () => {
    const w = await account(4);
    const kit = makeRescueKit(ACCT, w.key.rawB64, w.loc, backendDescriptors(await w.vault.load()), 10);
    expect(openRescueKit(kit).backends.length).toBe(1);
    const r = await fromKitOnly(w, kit);
    expect(r.downloads).toEqual(w.files.map(() => "ok"));
  });

  it("before the fix (a pointer without the list): a kit with one webhook cannot restore 3 webhooks; the next scheduler tick repairs it", async () => {
    const w = await account(3, { carryList: false });
    const v = await w.vault.load();
    const ptrHook = v.webhooks.find((x) => x.id === w.loc.webhookId)!;
    const kit1 = encodeRescueKit({ v: 1, accountId: ACCT, key: w.key.rawB64, webhookUrl: ptrHook.url, pointerMessageId: w.loc.messageId });
    await expect(fromKitOnly(w, kit1)).rejects.toThrow(/neither the rescue kit nor the pointer names/);
    // A current client writes the list into the pointer without changing what it covers (same_coverage).
    const io = clientBlobIO(w.a);
    const before = await readPointer(io, w.key, ACCT, w.loc);
    const s2 = new SnapshotScheduler({ ...w.sched["d"], backends: () => ({ list: backendDescriptors(w.vault.cached!.content), revision: w.vault.revision }) });
    expect(await s2.tick()).toBeNull(); // nothing new in the log: no snapshot, only the list
    expect(s2.lastListWrite).toBe("written");
    const after = await readPointer(io, w.key, ACCT, w.loc);
    expect({ ...after, backends: undefined, vaultRevision: undefined, writtenAt: 0 }).toEqual({ ...before, backends: undefined, vaultRevision: undefined, writtenAt: 0 });
    expect(after.vaultRevision).toBe(w.vault.revision);
    const r = await fromKitOnly(w, kit1);
    expect(r.downloads).toEqual(w.files.map(() => "ok"));
    // A second tick has nothing to do.
    await s2.tick();
    expect(s2.lastListWrite).toBe("same");
  });

  it("an older client writing the pointer drops the list; a newer revision is never replaced by an older one; a current device puts it back", async () => {
    const w = await account(3);
    const io = clientBlobIO(w.a);
    const p = await readPointer(io, w.key, ACCT, w.loc);
    const rev = p.vaultRevision!;
    // A device that saw an OLDER vault (revision 1, one webhook) writes the pointer: the newer list stays.
    const stale = { list: backendDescriptors(w.vault.cached!.content).slice(0, 1), revision: 1 };
    await writePointer(io, w.key, ACCT, w.loc, { ...p, backends: stale.list, vaultRevision: stale.revision, toSeq: p.toSeq, writtenAt: 1 }, "same_coverage");
    expect((await readPointer(io, w.key, ACCT, w.loc)).vaultRevision).toBe(rev);
    expect((await readPointer(io, w.key, ACCT, w.loc)).backends!.length).toBe(3);
    // Code from before the list existed rewrites the pointer whole (its JSON has no such fields).
    const { backends: _b, vaultRevision: _r, ...old } = p;
    const { discordSlot } = await import("../src/backends.js");
    const sealed = await (await import("../src/account-key.js")).seal(await w.key.subkey("snapshot"), await (await import("../src/snapshots.js")).gzip(new TextEncoder().encode(JSON.stringify(old))), `ddn-pointer-v1|${ACCT}`);
    await discordSlot(w.transport, w.a.webhook(w.loc.webhookId)).write(w.loc.messageId, sealed, "ddn-pointer.txt");
    expect((await readPointer(io, w.key, ACCT, w.loc)).backends).toBeUndefined();
    // The next tick of a current client puts it back.
    await w.sched.tick();
    expect((await readPointer(io, w.key, ACCT, w.loc)).backends!.length).toBe(3);
    // A webhook added later: the list follows the vault.
    await w.vault.addWebhook(hookOf(7));
    await w.sched.tick();
    const p2 = await readPointer(io, w.key, ACCT, w.loc);
    expect(p2.backends!.map((b) => b.id)).toContain(hookOf(7).id);
    expect(p2.vaultRevision).toBe(w.vault.revision);
  });
});

describe("compatibility", () => {
  it("ddn1: manifestRef is byte for byte the format older devices read (golden)", () => {
    const loc = { v: 1 as const, f: 1, k: "S2V5LWZvci10aGUtZmlsZS0zMi1ieXRlcy0hISEhISE=", at: { provider: "discord-webhook" as const, locationId: "1234567890123456789", channelId: "2234567890123456789", messageId: "3234567890123456789", attachmentId: "4234567890123456789" } };
    const ref = encodeManifestRef(loc);
    expect(ref).toBe('ddn1:[1,1,"S2V5LWZvci10aGUtZmlsZS0zMi1ieXRlcy0hISEhISE=","1234567890123456789","2234567890123456789","3234567890123456789","4234567890123456789"]');
    expect(decodeManifestRef(ref)).toEqual(loc);
  });

  it("ddn2: for other backends: round trip, every field kept, length under the sync core's limit", () => {
    const at = { provider: "example-provider", locationId: "ex-1", chatId: "-1001234567890", messageId: "123456", fileId: "B".repeat(72) };
    const ref = encodeManifestRef({ v: 1, f: 1, k: "K".repeat(44), at });
    expect(ref.startsWith("ddn2:")).toBe(true);
    expect(ref.length).toBeLessThanOrEqual(MANIFEST_REF_MAX);
    expect(decodeManifestRef(ref)).toEqual({ v: 1, f: 1, k: "K".repeat(44), at });
    expect(() => encodeManifestRef({ v: 1, f: 1, k: "K", at: { provider: "x", locationId: "y", blob: "z".repeat(600) } })).toThrow(/too long/);
  });

  it("a vault without `backends` (written by an older tab) opens; unknown fields survive an edit by that tab", async () => {
    const key = newAccountKey();
    const old = { format: "ddn-webhook-vault", version: 1, webhooks: [hookOf(1)], pointer: { webhookId: hookOf(1).id, messageId: "m1" } } as VaultContent;
    expect(await openVault(key, ACCT, await sealVault(key, ACCT, 1, old))).toEqual(old);
    // An older tab edits a vault that has `backends`: its update() clones the whole content, so they stay.
    const store = new MemoryVaultStore();
    const cur = new WebhookVault(store, key, ACCT);
    const b: VaultBackend = { kind: MEMORY_BACKEND_KIND, id: "mem-1", label: "m", addedAt: 5, secret: { bucket: "b1" } };
    await cur.addBackend(b);
    const olderTab = new WebhookVault(store, key, ACCT);
    await olderTab.update((v) => ((v.webhooks = [...v.webhooks, hookOf(2)]), v));
    expect((await cur.load()).backends).toEqual([b]);
  });

  it("the CLI-style kit 1 still opens; e2ee/plain kits are refused here", () => {
    const k1 = encodeRescueKit({ v: 1, accountId: ACCT, key: "a2V5", webhookUrl: hookOf(3).url, pointerMessageId: "99" });
    expect(openRescueKit(k1)).toMatchObject({ v: 1, pointer: { webhookId: hookOf(3).id, messageId: "99" }, backends: [{ kind: "discord-webhook", id: hookOf(3).id }] });
    expect(() => openRescueKit("ddn-kit2:e30")).toThrow(/e2ee\/plain/);
  });
});

describe("a second backend kind (memory) next to Discord", () => {
  it("mixed account: upload spreads over both, download + Range, snapshot and restore from kit 3 with the pointer on the memory backend", async () => {
    const w = await account(2, { memory: 1, pointerOn: "memory", files: 6 });
    const bucket = w.buckets.get("b1")!;
    expect(bucket.puts).toBeGreaterThan(0);
    expect(w.transport.messages.size).toBeGreaterThan(0);
    const refs = w.files.map((f) => w.a.store.getNode(f.id)!.content!.manifestRef);
    expect(refs.some((r) => r.startsWith("ddn2:"))).toBe(true);
    expect(refs.some((r) => r.startsWith("ddn1:"))).toBe(true);
    // Range read across fragments on different backends.
    const big = w.files.at(-1)!;
    const r = await w.a.readRange(big.id, 350, 1500);
    expect(Buffer.compare(Buffer.from(r.data), Buffer.from(big.data.subarray(350, 1501)))).toBe(0);
    // Restore from kit 3 (pointer on the memory backend), nothing else.
    const kit = makeRescueKit(ACCT, w.key.rawB64, w.loc, backendDescriptors(await w.vault.load()));
    expect(openRescueKit(kit).pointer.webhookId).toBe("mem-1");
    const k = await fromKitOnly(w, kit);
    expect(k.restored).toBe(canonicalState(w.a.store));
    expect(k.downloads).toEqual(w.files.map(() => "ok"));
  });

  it("cleanup deletes on both kinds; sharing a file stored on the memory backend is refused", async () => {
    const w = await account(1, { memory: 1, files: 4 });
    const bucket = w.buckets.get("b1")!;
    const f = w.files[3]!;
    const ref = w.a.store.getNode(f.id)!.content!.manifestRef;
    const { manifest } = await w.a.loadManifest(ref);
    const kinds = new Set([decodeManifestRef(ref).at.provider, ...manifest.chunks.map((c) => c.placements![0]!.provider)]);
    expect(kinds).toEqual(new Set(["discord-webhook", MEMORY_BACKEND_KIND]));
    await expect(prepareShare({ transport: w.transport, hook: (id) => w.a.webhook(id), loadManifest: (x) => w.a.loadManifest(x) }, ref, { name: "x", size: 1, sha256: "" })).rejects.toThrow(/share_unavailable/);
    // Delete the file for good: trash, purge after 30 days, fragments after the retention.
    const before = { mem: bucket.objects.size, msgs: w.transport.messages.size };
    await w.a.commitOp({ type: "trash", nodeId: f.id }, "trash");
    const gc = { done: new Set<string>(), last: null as number | null };
    const api = {
      status: async () => ({ now: w.now.get(), lastRunAt: gc.last, firstEntryAt: w.now.get() - 60 * DAY_MS, doneCount: gc.done.size }),
      done: async (ids: string[]) => ids.filter((x) => gc.done.has(x)),
      record: async (r: { uploads: string[]; run: boolean }) => void (r.uploads.forEach((x) => gc.done.add(x)), r.run && (gc.last = w.now.get())),
    };
    const io = clientBlobIO(w.a);
    const cleaner = new Cleaner({ client: w.a, log: new EncryptedArbiter(new OpCodec(w.key, ACCT), w.server.session("dev-A")), api, transport: w.transport, webhook: (id) => w.a.webhook(id), backend: (id) => w.a.backend(id), pointer: () => readPointer(io, w.key, ACCT, w.loc), isPrimary: () => true, metered: () => false, sleep: async () => {} });
    w.now.add(31 * DAY_MS);
    await cleaner.run(true);
    // Bases from after the release push the old ones out of retention.
    for (let d = 0; d < 40; d++) {
      w.now.add(DAY_MS);
      await w.a.commitOp({ type: "create", kind: "folder", nodeId: `day-${String(d).padStart(5, "0")}`, parentId: ROOT_ID, name: `d${d}` }, "mk");
      await w.sched.tick(true);
    }
    const r = await cleaner.run(true);
    expect(r.uploads).toBe(1);
    expect(bucket.objects.size).toBeLessThan(before.mem + 40); // fragments on the bucket went too
    for (const c of manifest.chunks) {
      const p = c.placements![0]! as { provider: string; key?: string; messageId?: string };
      if (p.provider === MEMORY_BACKEND_KIND) expect(bucket.objects.has(p.key!)).toBe(false);
      else expect(w.transport.messages.has(p.messageId!)).toBe(false);
    }
  });

  it("moving a Discord channel onto the memory backend (relocate): every file reads without the webhook", async () => {
    let t = Date.UTC(2026, 9, 16);
    const key = newAccountKey();
    const transport = new MemoryTransport();
    const server = new InProcessLogServer({ now: () => t });
    const vault = new WebhookVault(new MemoryVaultStore(), key, ACCT);
    await vault.addWebhook(hookOf(1));
    const bucket = new MemoryBucket();
    const mem = new MemoryBackend("mem-1", bucket);
    mem.retired = true; // the account starts on Discord only; the bucket is added for the move
    await vault.addBackend({ kind: MEMORY_BACKEND_KIND, id: "mem-1", label: "bucket", addedAt: 9, secret: { bucket: "b1" } });
    const store = new SqliteIndexStore();
    const arb = new EncryptedArbiter(new OpCodec(key, ACCT), server.session("dev-A"));
    const a = new MetadataClient({ device: { id: "dev-A", name: "A" }, arbiter: arb, transport, webhooks: [{ ...hookOf(1) }], backends: [mem], store, chunkSize: 400, now: () => t, sleep: async () => {}, pacer: new ChannelPacer({ perMin: 600_000, maxPerMin: 600_000, burst: 10_000 }) });
    const io = clientBlobIO(a, transport, 600);
    const loc = await createPointerMessage(io, key, ACCT, { id: hookOf(1).id });
    await vault.update((x) => ((x.pointer = loc), x));
    const files: { id: string; data: Uint8Array }[] = [];
    for (let i = 0; i < 3; i++) {
      const data = crypto.getRandomValues(new Uint8Array(900 + 300 * i));
      files.push({ id: (await a.upload(memorySource(data), `f${i}.bin`)).nodeId, data });
    }
    expect(bucket.puts).toBe(0);
    await writeSnapshot({ io, key, accountId: ACCT, pointer: loc, log: server.session("dev-A"), store: a.store, now: () => t }, "base");
    mem.retired = false;
    const m = new ChannelMover({ client: a, store, vault, key, accountId: ACCT, transport, log: arb, now: () => t });
    const s = await m.run(hookOf(1).id);
    expect(s.state).toBe("done");
    expect(store.filesAt(hookOf(1).id, 0).total).toBe(0);
    expect(bucket.puts).toBeGreaterThan(0);
    // The webhook is gone from Discord's side entirely: every file still reads (from the bucket only).
    transport.messages.clear();
    a.setHookRetired(hookOf(1).id, true);
    for (const f of files) {
      const out = sink();
      await a.download(f.id, out);
      expect(Buffer.compare(Buffer.from(out.data()), Buffer.from(f.data))).toBe(0);
    }
    // The chain moved too: the vault's pointer is on the bucket, and its kit restores the tree alone.
    const v = await vault.load();
    expect(v.pointer!.webhookId).toBe("mem-1");
    const restored = await restoreFromRescueKit(makeRescueKit(ACCT, key.rawB64, v.pointer!, backendDescriptors(v)), transport, { factory: memoryBackendFactory(new Map([["b1", bucket]])), store: new MemoryIndexStore() });
    expect(restored.store.getMeta().headSeq).toBeGreaterThan(0);
  });
});
