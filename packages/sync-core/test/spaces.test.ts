// Rules 4: the Gallery space (a third system root). Compatibility: logs of rules 2-3 replay exactly
// as before; the Gallery's root appears with the first rules-4 entry; moves between spaces are
// plain moves; recovery places follow the space.
import { describe, expect, it } from "vitest";
import {
  GALLERY_ID,
  RECOVERED_ID,
  ROOT_ID,
  RULES_VERSION,
  WRITE_RULES_VERSION,
  canonicalState,
  checkInvariants,
  initIndex,
  loadSnapshot,
  MemoryIndexStore,
  replay,
  spaceOf,
  takeSnapshot,
} from "../src/index.js";
import { A, B, Scenario, codes } from "./helpers.js";

const V3 = { rulesVersion: 3 };

describe("rules 4: the Gallery space", () => {
  it("versions: replays 4, writes 3 until every reader has rules 4", () => {
    expect(RULES_VERSION).toBe(4);
    expect(WRITE_RULES_VERSION).toBe(3);
  });

  it("a log of rules 3 has no Gallery root and the same state as before", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs", V3);
    s.file(A, "file0001", "fold0001", "a.txt", V3);
    s.op(A, { type: "trash", nodeId: "fold0001" }, V3);
    expect(s.store.getNode(GALLERY_ID)).toBeUndefined();
    // "gallery" as a node ID in a rules-3 op is what it was then: unknown node (not a system one).
    const r = s.op(B, { type: "rename", nodeId: GALLERY_ID, name: "x" }, V3);
    expect(r.outcome).toBe("skipped");
    expect(codes(r)).toEqual(["node_purged"]);
    expect(checkInvariants(s.store)).toEqual([]);
  });

  it("the first applied rules-4 entry makes the Gallery root; one not applied changes nothing", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs", V3);
    const before = s.dump();
    expect(s.op(A, { type: "rename", nodeId: "fold0001", name: "a/b" }, { rulesVersion: 4 }).outcome).toBe("rejected");
    expect(s.op(A, { type: "rename", nodeId: "fold0001", name: "docs" }, { rulesVersion: 4 }).outcome).toBe("noop");
    expect(s.op(A, { type: "rename", nodeId: "ghost001", name: "x" }, { rulesVersion: 4 }).outcome).toBe("skipped");
    expect(s.dump()).toBe(before);
    expect(s.store.getNode(GALLERY_ID)).toBeUndefined();
    expect(s.op(A, { type: "rename", nodeId: "fold0001", name: "Dokumenty" }, { rulesVersion: 4 }).outcome).toBe("applied");
    const g = s.store.getNode(GALLERY_ID)!;
    expect(g.parentId).toBeNull();
    expect(g.kind).toBe("folder");
    expect(checkInvariants(s.store)).toEqual([]);
  });

  it("files and albums in the Gallery; spaceOf; the Gallery root cannot be renamed, moved or trashed", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs", { rulesVersion: 4 });
    s.folder(A, "albm0001", GALLERY_ID, "Wakacje");
    s.file(A, "phot0001", "albm0001", "IMG_1.jpg");
    s.file(A, "phot0002", GALLERY_ID, "IMG_2.jpg");
    expect(spaceOf(s.store, "phot0001")).toBe("gallery");
    expect(spaceOf(s.store, "phot0002")).toBe("gallery");
    expect(spaceOf(s.store, "fold0001")).toBe("drive");
    expect(spaceOf(s.store, RECOVERED_ID)).toBe("drive");
    for (const op of [
      { type: "rename" as const, nodeId: GALLERY_ID, name: "x" },
      { type: "move" as const, nodeId: GALLERY_ID, parentId: ROOT_ID },
      { type: "trash" as const, nodeId: GALLERY_ID },
      { type: "purge" as const, nodeId: GALLERY_ID },
    ]) {
      const r = s.op(B, op);
      expect(r.outcome).toBe("rejected");
      expect(r.notices.map((n) => n.reason)).toContain("system_node");
    }
    // "gallery" is never a client ID: a create with it is refused as before.
    expect(s.op(A, { type: "create", kind: "folder", nodeId: GALLERY_ID, parentId: ROOT_ID, name: "g" }).outcome).toBe("rejected");
    expect(checkInvariants(s.store)).toEqual([]);
  });

  it("move between spaces is a plain move; the subtree goes along; names suffixed per folder", () => {
    const s = new Scenario();
    s.folder(A, "albm0001", GALLERY_ID, "Wakacje", { rulesVersion: 4 });
    s.file(A, "phot0001", "albm0001", "IMG_1.jpg");
    s.folder(A, "fold0001", ROOT_ID, "Wakacje");
    expect(s.op(A, { type: "move", nodeId: "albm0001", parentId: ROOT_ID }).outcome).toBe("applied");
    expect(s.node("albm0001").name).toBe("Wakacje (2)");
    expect(spaceOf(s.store, "phot0001")).toBe("drive");
    expect(s.op(A, { type: "move", nodeId: "phot0001", parentId: GALLERY_ID }).outcome).toBe("applied");
    expect(spaceOf(s.store, "phot0001")).toBe("gallery");
    expect(checkInvariants(s.store)).toEqual([]);
  });

  it("trash and restore stay in the space (one trash, the parent decides)", () => {
    const s = new Scenario();
    s.folder(A, "albm0001", GALLERY_ID, "Wakacje", { rulesVersion: 4 });
    s.file(A, "phot0001", "albm0001", "IMG_1.jpg");
    s.op(A, { type: "trash", nodeId: "phot0001" });
    expect(s.inTrash("phot0001")).toBe(true);
    expect(spaceOf(s.store, "phot0001")).toBe("gallery");
    s.op(A, { type: "restore", nodeId: "phot0001" });
    expect(s.node("phot0001").parentId).toBe("albm0001");
  });

  it("rule 4 in the Gallery: added to a trashed album → the Gallery's root, not „Odzyskane”", () => {
    const s = new Scenario();
    s.folder(A, "albm0001", GALLERY_ID, "Wakacje", { rulesVersion: 4 });
    const base = s.seq;
    s.op(A, { type: "trash", nodeId: "albm0001" }, { baseSeq: base });
    const r = s.file(B, "phot0001", "albm0001", "IMG_1.jpg", { baseSeq: base });
    expect(codes(r)).toContain("moved_to_recovered");
    expect(s.node("phot0001").parentId).toBe(GALLERY_ID);
    expect(s.node("phot0001").recoveredFrom?.parentId).toBe("albm0001");
    expect(spaceOf(s.store, "phot0001")).toBe("gallery");
    expect(checkInvariants(s.store)).toEqual([]);
  });

  it("rule 4 with a purged album: the op's space decides (gallery → Gallery root, none → „Odzyskane”)", () => {
    const s = new Scenario();
    s.folder(A, "albm0001", GALLERY_ID, "Wakacje", { rulesVersion: 4 });
    s.folder(A, "fold0001", ROOT_ID, "docs");
    const base = s.seq;
    s.op(A, { type: "trash", nodeId: "albm0001" });
    s.op(A, { type: "purge", nodeId: "albm0001" });
    s.op(A, { type: "trash", nodeId: "fold0001" });
    s.op(A, { type: "purge", nodeId: "fold0001" });
    const c1 = s.newContent();
    s.op(B, { type: "upload_begin", uploadId: c1.uploadId }, { baseSeq: base });
    s.add(B, { type: "group", ops: [{ type: "upload_commit", uploadId: c1.uploadId }, { type: "create", kind: "file", nodeId: "phot0001", parentId: "albm0001", name: "IMG.jpg", content: c1, space: "gallery" }] }, { baseSeq: base });
    const c2 = s.newContent();
    s.op(B, { type: "upload_begin", uploadId: c2.uploadId }, { baseSeq: base });
    s.add(B, { type: "group", ops: [{ type: "upload_commit", uploadId: c2.uploadId }, { type: "create", kind: "file", nodeId: "file0002", parentId: "fold0001", name: "a.txt", content: c2 }] }, { baseSeq: base });
    expect(s.node("phot0001").parentId).toBe(GALLERY_ID);
    expect(s.node("file0002").parentId).toBe(RECOVERED_ID);
    expect(checkInvariants(s.store)).toEqual([]);
  });

  it("rule 3b in the Gallery: new content for a purged photo → the Gallery's root", () => {
    const s = new Scenario();
    s.file(A, "phot0001", GALLERY_ID, "IMG.jpg", { rulesVersion: 4 });
    const v = s.node("phot0001").content!.versionId;
    const base = s.seq;
    s.op(A, { type: "trash", nodeId: "phot0001" });
    s.op(A, { type: "purge", nodeId: "phot0001" });
    const c = s.newContent();
    s.op(B, { type: "upload_begin", uploadId: c.uploadId }, { baseSeq: base });
    const r = s.add(B, { type: "group", ops: [{ type: "upload_commit", uploadId: c.uploadId }, { type: "new_content_version", nodeId: "phot0001", baseVersionId: v, content: c, nameHint: "IMG.jpg", space: "gallery" }] }, { baseSeq: base });
    expect(codes(r)).toContain("content_for_purged_file");
    const rec = [...s.store.allNodes()].find((n) => n.content?.uploadId === c.uploadId)!;
    expect(rec.parentId).toBe(GALLERY_ID);
    expect(checkInvariants(s.store)).toEqual([]);
  });

  it("a bad space in a rules-4 op is invalid; in a rules-3 op it is ignored as before", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "x", V3);
    const r3 = s.op(A, { type: "create", kind: "folder", nodeId: "fold0002", parentId: ROOT_ID, name: "y", space: "elsewhere" as never }, V3);
    expect(r3.outcome).toBe("applied");
    const r4 = s.op(A, { type: "create", kind: "folder", nodeId: "fold0003", parentId: ROOT_ID, name: "z", space: "elsewhere" as never }, { rulesVersion: 4 });
    expect(r4.outcome).toBe("rejected");
  });

  it("snapshot + tail across the first rules-4 entry = full replay", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs", V3);
    s.file(A, "file0001", "fold0001", "a.txt", V3);
    const cut = s.seq;
    s.folder(A, "albm0001", GALLERY_ID, "Wakacje", { rulesVersion: 4 });
    s.file(A, "phot0001", "albm0001", "IMG.jpg");
    s.op(A, { type: "move", nodeId: "file0001", parentId: "albm0001" });
    const head = replay(s.entries.slice(0, cut)).store;
    const snap = JSON.parse(JSON.stringify(takeSnapshot(head)));
    const restored = loadSnapshot(snap);
    for (const e of s.entries.slice(cut)) replayOne(restored, e);
    expect(canonicalState(restored)).toBe(canonicalState(s.store));
    expect(canonicalState(replay(s.entries).store)).toBe(canonicalState(s.store));
  });
});

import { applyEntry, type IndexStore, type LogEntry } from "../src/index.js";
function replayOne(st: IndexStore, e: LogEntry) {
  applyEntry(st, e);
}
void initIndex;
void MemoryIndexStore;
