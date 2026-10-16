// Rules v3: `relocate` moves a version to other storage
// locations without touching its content, and content may carry piece locations. Rules-2
// entries replay exactly as before.
import { describe, expect, it } from "vitest";
import { MemoryIndexStore, ROOT_ID, applyEntry, canonicalState, initIndex, loadSnapshot, replay, takeSnapshot, type LogEntry } from "../src/index.js";
import { A, B, Scenario, codes, visibleCodes } from "./helpers.js";

const P1 = [{ loc: "111111111111111111", n: 2, bytes: 200 }];
const P2 = [{ loc: "222222222222222222", n: 2, bytes: 200 }];

describe("relocate (rules v3)", () => {
  it("replaces manifestRef and pieces of the current version; version, seq and author stay; no conflict", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const before = s.node("file0001").content!;
    const r = s.op(B, { type: "relocate", uploadId: before.uploadId, versionId: before.versionId, from: before.manifestRef, manifestRef: "mf-moved", pieces: P2 }, { baseSeq: 0 });
    expect(r.outcome).toBe("applied");
    expect(codes(r)).toEqual([]);
    const after = s.node("file0001").content!;
    expect(after.manifestRef).toBe("mf-moved");
    expect(after.pieces).toEqual(P2);
    expect({ ...after, manifestRef: before.manifestRef, pieces: undefined }).toEqual({ ...before, pieces: undefined });
    expect(s.store.getUpload(before.uploadId)!.relocated).toEqual({ seq: s.seq, at: s.entries.at(-1)!.serverTime });
    expect(s.store.getUpload(before.uploadId)!.status).toBe("bound");
    s.expectValid();
  });

  it("is not new content: trashing after a relocate the author did not see still works (Q2 looks at the version)", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const base = s.seq;
    const c = s.node("file0001").content!;
    s.op(B, { type: "relocate", uploadId: c.uploadId, versionId: c.versionId, from: c.manifestRef, manifestRef: "mf-moved" });
    const t = s.op(A, { type: "trash", nodeId: "file0001" }, { baseSeq: base });
    expect(t.outcome).toBe("applied");
    // ...and a purge by A (who never saw the relocate) deletes it: Q3 looks at placed/content seq.
    const p = s.op(A, { type: "purge", nodeId: "file0001" }, { baseSeq: base });
    expect(p.outcome).toBe("applied");
    expect(s.maybe("file0001")).toBeUndefined();
    expect(s.store.getUpload(c.uploadId)!.status).toBe("released");
    s.expectValid();
  });

  it("works on a version in the trash; stale (superseded / purged) = skipped silently", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const v1 = s.node("file0001").content!;
    s.op(A, { type: "trash", nodeId: "file0001" });
    expect(s.op(B, { type: "relocate", uploadId: v1.uploadId, versionId: v1.versionId, from: v1.manifestRef, manifestRef: "mf-t" }).outcome).toBe("applied");
    expect(s.node("file0001").content!.manifestRef).toBe("mf-t");
    s.op(A, { type: "restore", nodeId: "file0001" });
    s.edit(A, "file0001", v1.versionId);
    const stale = s.op(B, { type: "relocate", uploadId: v1.uploadId, versionId: v1.versionId, from: "mf-t", manifestRef: "mf-late" });
    expect(stale.outcome).toBe("skipped");
    expect(visibleCodes(stale)).toEqual([]);
    expect(codes(stale)).toEqual(["relocate_stale"]);
    expect(s.node("file0001").content!.manifestRef).not.toBe("mf-late");
    const v2 = s.node("file0001").content!;
    s.op(A, { type: "trash", nodeId: "file0001" });
    s.op(A, { type: "purge", nodeId: "file0001" });
    expect(s.op(B, { type: "relocate", uploadId: v2.uploadId, versionId: v2.versionId, from: v2.manifestRef, manifestRef: "mf-x" }).outcome).toBe("skipped");
    s.expectValid();
  });

  it("the same relocate twice = noop; wrong version ID = skipped; bad fields = rejected", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const c = s.node("file0001").content!;
    const op = { type: "relocate" as const, uploadId: c.uploadId, versionId: c.versionId, from: c.manifestRef, manifestRef: "mf-2", pieces: P1 };
    expect(s.op(A, op).outcome).toBe("applied");
    // The same op again: `from` no longer matches (CAS) -> stale, skipped; a no-op relocate is a noop.
    expect(s.op(A, op).outcome).toBe("skipped");
    expect(s.op(A, { ...op, from: "mf-2", manifestRef: "mf-2" }).outcome).toBe("noop");
    // from == manifestRef with new pieces: fills them in, not a move (relocated stays).
    const rel = s.store.getUpload(c.uploadId)!.relocated;
    expect(s.op(A, { ...op, from: "mf-2", manifestRef: "mf-2", pieces: P2 }).outcome).toBe("applied");
    expect(s.node("file0001").content!.pieces).toEqual(P2);
    expect(s.store.getUpload(c.uploadId)!.relocated).toEqual(rel);
    // Two devices move the same version at once: the second one is stale and changes nothing.
    const b = s.op(B, { ...op, from: c.manifestRef, manifestRef: "mf-b" });
    expect(b.outcome).toBe("skipped");
    expect(s.node("file0001").content!.manifestRef).toBe("mf-2");
    const cur = { ...op, from: "mf-2" };
    expect(s.op(A, { ...cur, versionId: "ver-zzzzzz" }).outcome).toBe("skipped");
    expect(s.op(A, { ...cur, manifestRef: "" }).outcome).toBe("rejected");
    expect(s.op(A, { ...cur, pieces: [...P2, ...P1] }).outcome).toBe("rejected"); // not sorted
    expect(s.op(A, { ...cur, pieces: [{ loc: "1", n: 0, bytes: 1 }] }).outcome).toBe("rejected");
    s.expectValid();
  });

  it("in a group with other relocates: one stale member is left out, the rest applies (Q9)", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.file(A, "file0002", ROOT_ID, "b.txt");
    const c1 = s.node("file0001").content!;
    const c2 = s.node("file0002").content!;
    s.op(A, { type: "trash", nodeId: "file0002" });
    s.op(A, { type: "purge", nodeId: "file0002" });
    const r = s.add(B, {
      type: "group",
      ops: [
        { type: "relocate", uploadId: c1.uploadId, versionId: c1.versionId, from: c1.manifestRef, manifestRef: "mf-g1" },
        { type: "relocate", uploadId: c2.uploadId, versionId: c2.versionId, from: c2.manifestRef, manifestRef: "mf-g2" },
      ],
    });
    expect(r.outcome).toBe("applied");
    expect(visibleCodes(r)).toEqual([]);
    expect(s.node("file0001").content!.manifestRef).toBe("mf-g1");
    s.expectValid();
  });

  it("content with pieces: kept in the tree and in snapshots; replay gives the same state", () => {
    const s = new Scenario();
    const c = { ...s.newContent(), pieces: P1 };
    s.add(A, { type: "upload_begin", uploadId: c.uploadId });
    s.add(A, { type: "group", ops: [{ type: "upload_commit", uploadId: c.uploadId }, { type: "create", kind: "file", nodeId: "file0001", parentId: ROOT_ID, name: "p.bin", content: c }] });
    expect(s.node("file0001").content!.pieces).toEqual(P1);
    const snap = JSON.parse(JSON.stringify(takeSnapshot(s.store)));
    expect(canonicalState(loadSnapshot(snap))).toBe(canonicalState(s.store));
    expect(canonicalState(replay(s.entries).store)).toBe(canonicalState(s.store));
  });
});

describe("rules 2 entries replay unchanged under rules 3", () => {
  const v2 = (seq: number, op: LogEntry["op"], leaseGuard?: string[]): LogEntry => ({
    opId: `op-v2-${String(seq).padStart(5, "0")}`,
    rulesVersion: 2,
    baseSeq: seq - 1,
    device: A,
    createdAt: 0,
    ...(leaseGuard ? { leaseGuard } : {}),
    op,
    seq,
    serverTime: seq * 1000,
  });

  it("a rules-2 relocate is an unknown type (rejected), pieces in a rules-2 create are ignored as before", () => {
    const st = initIndex(new MemoryIndexStore());
    const c = { versionId: "ver-000001", uploadId: "upl-000001", sizeBytes: 5, manifestRef: "mf-1", chunkCount: 1, pieces: [{ loc: "x", n: 1, bytes: 1 }, { loc: "a", n: 0, bytes: -1 }] };
    expect(applyEntry(st, v2(1, { type: "upload_begin", uploadId: c.uploadId }, [c.uploadId])).outcome).toBe("applied");
    const r = applyEntry(st, v2(2, { type: "group", ops: [{ type: "upload_commit", uploadId: c.uploadId }, { type: "create", kind: "file", nodeId: "file0001", parentId: ROOT_ID, name: "a", content: c }] }, [c.uploadId]));
    expect(r.outcome).toBe("applied");
    expect(st.getNode("file0001")!.content!.pieces).toBeUndefined();
    const rel = applyEntry(st, v2(3, { type: "relocate", uploadId: c.uploadId, versionId: c.versionId, from: "mf-1", manifestRef: "mf-2" }));
    expect(rel.outcome).toBe("rejected");
    expect(rel.notices[0]!.reason).toBe("unknown_type");
    expect(st.getNode("file0001")!.content!.manifestRef).toBe("mf-1");
  });
});
