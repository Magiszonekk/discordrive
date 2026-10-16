import { describe, expect, it } from "vitest";
import {
  applyEntry,
  canonicalState,
  checkInvariants,
  conflictName,
  deletableUploads,
  expiredTrash,
  foldName,
  initIndex,
  loadSnapshot,
  LogGapError,
  ManifestCache,
  MemoryIndexStore,
  nameKey,
  normalizeName,
  replay,
  Replica,
  ROOT_ID,
  RULES_VERSION,
  Sequencer,
  suffixedName,
  takeSnapshot,
  UnsupportedRulesVersionError,
  validateName,
  MAX_NAME_LENGTH,
  type ChunkManifest,
  type LogEntry,
} from "../src/index.js";
import { A, B, Scenario } from "./helpers.js";

describe("rules version in the log", () => {
  it("every entry carries the rules version and the index records the highest one", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "x");
    expect(s.entries.every((e) => e.rulesVersion === RULES_VERSION)).toBe(true);
    expect(s.store.getMeta().rulesVersion).toBe(RULES_VERSION);
  });

  it("server refuses ops from clients older than the minimum rules version", () => {
    const server = new Sequencer({ minRulesVersion: RULES_VERSION + 1, maxRulesVersion: RULES_VERSION + 1 });
    const r = server.submit({
      opId: "op-old00001",
      rulesVersion: RULES_VERSION,
      baseSeq: 0,
      device: A,
      createdAt: 0,
      op: { type: "create", kind: "folder", nodeId: "fold0001", parentId: ROOT_ID, name: "x" },
    });
    expect(r).toEqual({ status: "rules_version_rejected", minRulesVersion: RULES_VERSION + 1, maxRulesVersion: RULES_VERSION + 1 });
    expect(server.headSeq).toBe(0);
  });

  it("a client refuses to replay a log written with newer rules instead of diverging", () => {
    const st = initIndex(new MemoryIndexStore());
    const e: LogEntry = {
      opId: "op-new00001",
      rulesVersion: RULES_VERSION + 1,
      baseSeq: 0,
      device: A,
      createdAt: 0,
      op: { type: "create", kind: "folder", nodeId: "fold0001", parentId: ROOT_ID, name: "x" },
      seq: 1,
      serverTime: 0,
    };
    expect(() => applyEntry(st, e)).toThrow(UnsupportedRulesVersionError);
    expect(st.getMeta().headSeq).toBe(0);
  });

  it("log gaps are errors, re-delivered entries are ignored", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "x");
    s.folder(A, "fold0002", ROOT_ID, "y");
    const st = initIndex(new MemoryIndexStore());
    expect(() => applyEntry(st, s.entries[1]!)).toThrow(LogGapError);
    applyEntry(st, s.entries[0]!);
    expect(applyEntry(st, s.entries[0]!).outcome).toBe("already_applied");
  });
});

describe("determinism and snapshots", () => {
  it("replaying the same log gives byte-identical canonical state", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0001", "fold0001", "a.txt");
    s.file(B, "file0002", "fold0001", "A.TXT");
    s.edit(B, "file0001", null);
    const r1 = replay(s.entries).store;
    const r2 = replay(JSON.parse(JSON.stringify(s.entries)) as LogEntry[]).store;
    expect(canonicalState(r1)).toBe(canonicalState(s.store));
    expect(canonicalState(r2)).toBe(canonicalState(s.store));
  });

  it("snapshot + tail == full log, through JSON", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0001", "fold0001", "a.txt");
    const cut = s.seq;
    const snap = JSON.parse(JSON.stringify(takeSnapshot(replay(s.entries).store)));
    s.op(B, { type: "trash", nodeId: "fold0001" });
    s.file(B, "file0002", "fold0001", "late.txt", { baseSeq: cut });
    const st = loadSnapshot(snap);
    for (const e of s.entries.slice(cut)) applyEntry(st, e);
    expect(canonicalState(st)).toBe(canonicalState(s.store));
    expect(checkInvariants(st)).toEqual([]);
  });

  it("snapshot contains only the tree layer (no chunk lists)", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const json = JSON.stringify(takeSnapshot(s.store));
    expect(json).toContain("manifestRef");
    expect(json).not.toContain("chunks");
  });

  it("a replica joining from a snapshot converges with the others", () => {
    const server = new Sequencer();
    let n = 0;
    const id = () => `op-${String(++n).padStart(6, "0")}`;
    const a = new Replica({ device: A, newOpId: id });
    a.enqueue({ type: "create", kind: "folder", nodeId: "fold0001", parentId: ROOT_ID, name: "docs" });
    a.sync(server);
    const b = Replica.fromSnapshot(JSON.parse(JSON.stringify(a.snapshot())), { device: B, newOpId: id });
    a.enqueue({ type: "rename", nodeId: "fold0001", name: "Docs" });
    b.enqueue({ type: "create", kind: "folder", nodeId: "fold0002", parentId: "fold0001", name: "b" });
    a.sync(server);
    b.sync(server);
    a.sync(server);
    expect(canonicalState(a.store)).toBe(canonicalState(b.store));
  });

  it("a snapshot from a newer rules version is refused", () => {
    const snap = takeSnapshot(initIndex(new MemoryIndexStore()));
    snap.meta.rulesVersion = RULES_VERSION + 1;
    expect(() => loadSnapshot(snap)).toThrow(/rules version/);
  });
});

describe("garbage collection (rule 8)", () => {
  it("aborted uploads are deletable at once, released ones only after retention", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const u1 = s.node("file0001").content!.uploadId;
    s.edit(A, "file0001", s.version("file0001"));
    s.op(A, { type: "upload_begin", uploadId: "upl-ab0001" });
    s.op(A, { type: "upload_abort", uploadId: "upl-ab0001" });
    const releasedAt = s.store.getUpload(u1)!.ended!.at;
    expect(deletableUploads(s.store, releasedAt, 1000)).toEqual(["upl-ab0001"]);
    expect(deletableUploads(s.store, releasedAt + 1000, 1000)).toEqual([u1, "upl-ab0001"].sort());
    // Never the current version.
    expect(deletableUploads(s.store, Number.MAX_SAFE_INTEGER)).not.toContain(s.node("file0001").content!.uploadId);
  });

  it("expired trash lists only top-level trashed nodes", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "old");
    s.file(A, "file0001", "fold0001", "a.txt");
    s.op(A, { type: "trash", nodeId: "file0001" });
    s.op(A, { type: "trash", nodeId: "fold0001" });
    const at = s.node("fold0001").trashed!.at;
    expect(expiredTrash(s.store, at + 10, 100)).toEqual([]);
    expect(expiredTrash(s.store, at + 100, 100)).toEqual(["fold0001"]);
  });

  it("purge releases every version in the subtree", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "old");
    s.file(A, "file0001", "fold0001", "a.txt");
    s.file(A, "file0002", "fold0001", "b.txt");
    const ups = [s.node("file0001").content!.uploadId, s.node("file0002").content!.uploadId];
    s.op(A, { type: "trash", nodeId: "fold0001" });
    s.op(A, { type: "purge", nodeId: "fold0001" });
    expect(s.maybe("file0001")).toBeUndefined();
    for (const u of ups) expect(s.store.getUpload(u)).toMatchObject({ status: "released", ended: { reason: "purged" } });
    s.expectValid();
  });

  it("purge of a node that is not in the trash is skipped", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const r = s.op(A, { type: "purge", nodeId: "file0001" });
    expect(r.outcome).toBe("skipped");
    expect(s.maybe("file0001")).toBeDefined();
  });
});

describe("names", () => {
  it("case folding is pinned and handles non-ASCII", () => {
    expect(foldName("ŁÓDŹ")).toBe("łódź");
    expect(foldName("ΣΟΦΊΑ")).toBe(foldName("σοφία"));
    expect(foldName("ς")).toBe("σ");
    expect(foldName("Straße")).toBe("straße");
    expect(foldName("STRASSE")).toBe("strasse");
    expect(foldName("K")).toBe("k"); // Kelvin sign
    expect(nameKey("İ")).toBe("i\u0307");
    expect(foldName("😀A")).toBe("😀a");
  });

  it("NFC normalization is a client step; apply() only folds", () => {
    const nfd = "Z\u0307olw.txt";
    expect(normalizeName(nfd)).toBe("Żolw.txt");
    expect(nameKey(nfd)).not.toBe(nameKey(normalizeName(nfd)));
  });

  it("validation", () => {
    expect(validateName("a/b")).toBe("name_bad_char");
    expect(validateName("")).toBe("name_empty");
    expect(validateName("..")).toBe("name_reserved");
    expect(validateName("\ud800x")).toBe("name_bad_unicode");
    expect(validateName("x".repeat(MAX_NAME_LENGTH + 1))).toBe("name_too_long");
    expect(validateName("😀 ok.txt")).toBeNull();
  });

  it("suffix and conflict names stay valid even for maximal names", () => {
    const long = "x".repeat(MAX_NAME_LENGTH - 4) + ".txt";
    const suf = suffixedName(long, "file", 12);
    expect(validateName(suf)).toBeNull();
    expect(suf.endsWith(" (12).txt")).toBe(true);
    const c = conflictName(long, "tel/efon", Date.UTC(2026, 0, 2, 3, 4));
    expect(validateName(c)).toBeNull();
    expect(c.endsWith(" (konflikt, tel_efon, 2026-01-02 03.04).txt")).toBe(true);
    const c2 = conflictName(long, "tel", Date.UTC(2026, 0, 2, 23, 30), 120);
    expect(validateName(c2)).toBeNull();
    expect(c2.endsWith(" (konflikt, tel, 2026-01-03 01.30).txt")).toBe(true);
    // Surrogate pair at the cut is not split.
    const emoji = "😀".repeat(MAX_NAME_LENGTH / 2);
    expect(validateName(suffixedName(emoji, "folder", 2))).toBeNull();
  });
});

describe("manifest layer", () => {
  it("loads on demand, dedupes concurrent loads, evicts by size", async () => {
    let loads = 0;
    const mk = (n: number): ChunkManifest => ({
      schemaVersion: 1,
      chunkSizeBytes: 8 << 20,
      chunks: Array.from({ length: n }, (_, i) => ({ index: i, blobId: `b${i}`, ciphertextSizeBytes: 1 })),
    });
    const cache = new ManifestCache({ load: async (ref) => (loads++, mk(Number(ref.slice(3)))) }, 64 + 100 * 160);
    const [x, y] = await Promise.all([cache.get("mf-50"), cache.get("mf-50")]);
    expect(x).toBe(y);
    expect(loads).toBe(1);
    await cache.get("mf-60");
    expect(cache.has("mf-50")).toBe(false);
    expect(cache.has("mf-60")).toBe(true);
    await cache.get("mf-60");
    expect(loads).toBe(2);
  });
});

describe("sequencer restart from a persisted log", () => {
  it("keeps seq numbering and duplicate detection, refuses a gapped log", () => {
    const s1 = new Sequencer();
    const env = (opId: string, name: string) => ({
      opId,
      rulesVersion: RULES_VERSION,
      baseSeq: 0,
      device: A,
      createdAt: 0,
      op: { type: "create" as const, kind: "folder" as const, nodeId: `n-${opId}`, parentId: ROOT_ID, name },
    });
    s1.submit(env("op-aaaa0001", "a"));
    s1.submit(env("op-aaaa0002", "b"));
    const s2 = new Sequencer({ initialLog: s1.read(0) });
    expect(s2.headSeq).toBe(2);
    expect(s2.submit(env("op-aaaa0001", "a")).status).toBe("duplicate");
    const r = s2.submit(env("op-aaaa0003", "c"));
    expect(r.status === "accepted" && r.entry.seq).toBe(3);
    expect(() => new Sequencer({ initialLog: s1.read(1) })).toThrow(/contiguous/);
  });
});

describe("replica with an async arbiter", () => {
  it("pushOneAsync acks like pushOne and the entry arrives through receive()", async () => {
    const server = new Sequencer();
    let n = 0;
    const r = new Replica({ device: A, newOpId: () => `op-async${String(++n).padStart(4, "0")}` });
    r.enqueue({ type: "create", kind: "folder", nodeId: "fold-async1", parentId: ROOT_ID, name: "x" });
    const res = await r.pushOneAsync({ submit: async (env) => server.submit(env) });
    expect(res?.status).toBe("accepted");
    expect(r.unsent).toBe(0);
    expect(r.outbox.length).toBe(1);
    r.receive(server.read(r.headSeq));
    expect(r.outbox.length).toBe(0);
    expect(r.store.getNode("fold-async1")?.name).toBe("x");
  });
});
