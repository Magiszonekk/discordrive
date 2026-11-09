// Rules 5: node attributes (`set_attr`). Compatibility: logs of rules 2-4 replay exactly as before;
// a node without attributes has no `attrs` field (snapshots stay byte-identical); `set_attr` in an older
// entry is an unknown type.
import { describe, expect, it } from "vitest";
import {
  GALLERY_ID,
  ROOT_ID,
  RULES_VERSION,
  WRITE_RULES_VERSION,
  canonicalState,
  checkInvariants,
  initIndex,
  loadSnapshot,
  MemoryIndexStore,
  Replica,
  replay,
  takeSnapshot,
} from "../src/index.js";
import { A, B, Scenario, codes } from "./helpers.js";

const hide = (nodeId: string, value = true) => ({ type: "set_attr" as const, nodeId, attr: "thumbHidden" as const, value });

describe("rules 5: node attributes", () => {
  it("versions: replays 5, writes 3 (5 only for an attribute op)", () => {
    expect(RULES_VERSION).toBe(5);
    expect(WRITE_RULES_VERSION).toBe(3);
    const st = initIndex(new MemoryIndexStore());
    let n = 0;
    const r = new Replica({ device: { id: "dev-A", name: "A" }, store: st, newOpId: () => `op-${++n}`.padEnd(10, "0") });
    expect(r.enqueue({ type: "rename", nodeId: "file0001", name: "b" }).rulesVersion).toBe(3);
    expect(r.enqueue(hide("file0001")).rulesVersion).toBe(5);
    expect(r.enqueue({ type: "group", ops: [hide("file0001"), hide("file0002", false)] }).rulesVersion).toBe(5);
    // In the Gallery too (5 > 4).
    expect(r.enqueue({ type: "group", ops: [hide("file0001"), { type: "move", nodeId: "file0001", parentId: GALLERY_ID }] }).rulesVersion).toBe(5);
  });

  it("hide, show, later op wins, no notice; kept by rename, move, trash, restore and new versions", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0001", ROOT_ID, "a.jpg");
    const plain = JSON.stringify(s.node("file0001"));
    expect("attrs" in s.node("file0001")).toBe(false);
    const base = s.seq;
    const r1 = s.op(A, hide("file0001"));
    expect(r1.outcome).toBe("applied");
    expect(r1.notices).toEqual([]);
    expect(s.node("file0001").attrs).toEqual({ thumbHidden: true });
    expect(s.op(A, hide("file0001")).outcome).toBe("noop");
    // B had not seen A's hide and shows it: the later op wins, silently.
    const r2 = s.op(B, hide("file0001", false), { baseSeq: base });
    expect(r2.outcome).toBe("applied");
    expect(r2.notices).toEqual([]);
    expect("attrs" in s.node("file0001")).toBe(false);
    expect(JSON.stringify(s.node("file0001"))).toBe(plain);
    expect(s.op(B, hide("file0001", false)).outcome).toBe("noop");

    s.op(A, hide("file0001"));
    s.op(A, { type: "rename", nodeId: "file0001", name: "b.jpg" });
    s.op(A, { type: "move", nodeId: "file0001", parentId: "fold0001" });
    s.op(A, { type: "trash", nodeId: "file0001" });
    expect(s.node("file0001").attrs?.thumbHidden).toBe(true);
    // In the trash it can still change (the trash view shows thumbnails too).
    expect(s.op(A, hide("file0001", false)).outcome).toBe("applied");
    expect(s.op(A, hide("file0001")).outcome).toBe("applied");
    s.op(A, { type: "restore", nodeId: "file0001" });
    s.edit(A, "file0001", s.node("file0001").content!.versionId);
    expect(s.node("file0001").attrs?.thumbHidden).toBe(true);
    expect(checkInvariants(s.store)).toEqual([]);
  });

  it("rule 7: the conflict copy keeps the attribute of the file it came from", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.jpg");
    const v = s.node("file0001").content!.versionId;
    s.op(A, hide("file0001"));
    const base = s.seq;
    s.edit(A, "file0001", v, { baseSeq: base });
    const r = s.edit(B, "file0001", v, { baseSeq: base });
    expect(codes(r)).toContain("content_conflict");
    const copy = [...s.store.allNodes()].find((n) => n.conflictOf?.nodeId === "file0001")!;
    expect(copy.attrs).toEqual({ thumbHidden: true });
    expect(s.node("file0001").attrs).toEqual({ thumbHidden: true });
    expect(checkInvariants(s.store)).toEqual([]);
  });

  it("invalid: folder, system node, unknown attribute, bad value; purged node is skipped", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0001", ROOT_ID, "a.jpg");
    const before = s.dump();
    expect(s.op(A, hide("fold0001")).outcome).toBe("rejected");
    expect(s.op(A, hide(ROOT_ID)).outcome).toBe("rejected");
    expect(s.op(A, { ...hide("file0001"), attr: "nope" as never }).outcome).toBe("rejected");
    expect(s.op(A, { ...hide("file0001"), value: 1 as never }).outcome).toBe("rejected");
    const r = s.op(A, hide("ghost001"));
    expect(r.outcome).toBe("skipped");
    expect(codes(r)).toEqual(["node_purged"]);
    expect(s.dump()).toBe(before);
    // In a group: a rejected member rolls the group back (Q9).
    const g = s.add(A, { type: "group", ops: [hide("file0001"), hide("fold0001")] });
    expect(g.outcome).toBe("rejected");
    expect(s.dump()).toBe(before);
  });

  it("set_attr in an entry of rules 4 or older is an unknown type (nothing changes)", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.jpg", { rulesVersion: 4 });
    const before = s.dump();
    for (const rv of [2, 3, 4]) {
      const r = s.op(A, hide("file0001"), { rulesVersion: rv });
      expect(r.outcome).toBe("rejected");
      expect(r.notices[0]?.reason).toBe("unknown_type");
    }
    expect(s.dump()).toBe(before);
  });

  it("a log without attributes gives the same state and snapshot as rules 4 did (no attrs field)", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs", { rulesVersion: 4 });
    s.file(A, "file0001", "fold0001", "a.jpg", { rulesVersion: 4 });
    const snap = JSON.stringify(takeSnapshot(s.store));
    expect(snap).not.toContain("attrs");
    expect(snap).not.toContain("thumbHidden");
  });

  it("snapshot + tail with attributes = full replay; a snapshot keeps them", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.jpg");
    s.file(A, "file0002", ROOT_ID, "b.jpg");
    s.op(A, hide("file0001"));
    const cut = s.seq;
    const snap = JSON.parse(JSON.stringify(takeSnapshot(replay(s.entries.slice(0, cut)).store)));
    expect(snap.nodes.find((n: { id: string }) => n.id === "file0001").attrs).toEqual({ thumbHidden: true });
    s.op(B, hide("file0002"));
    s.op(B, hide("file0001", false));
    const tail = replay(s.entries.slice(cut), loadSnapshot(snap, new MemoryIndexStore())).store;
    expect(canonicalState(tail)).toBe(canonicalState(s.store));
    expect(canonicalState(replay(s.entries).store)).toBe(canonicalState(s.store));
  });
});
