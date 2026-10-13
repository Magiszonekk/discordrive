// Owner decisions of 2026-10-05 (DECISIONS.md, rules version 2): one block
// per changed rule, each conflict in both orders where an order exists.

import { describe, expect, it } from "vitest";
import {
  applyEntry,
  expiredTrash,
  initIndex,
  loadSnapshot,
  MemoryIndexStore,
  MIN_REPLAY_RULES_VERSION,
  RECOVERED_ID,
  Replica,
  ROOT_ID,
  RULES_VERSION,
  Sequencer,
  takeSnapshot,
  UnsupportedRulesVersionError,
  type LogEntry,
} from "../src/index.js";
import { A, B, C, H1, H2, Scenario, codes, visibleCodes } from "./helpers.js";
import { checkNoSilentLoss, checkTrashSawContent } from "./oracles.js";

describe("rules version (§5.4)", () => {
  it("decisions bumped the rules version; v1 logs are no longer replayable", () => {
    expect(RULES_VERSION).toBe(3);
    expect(MIN_REPLAY_RULES_VERSION).toBe(2);
    const st = initIndex(new MemoryIndexStore());
    const e: LogEntry = {
      opId: "op-v1-00001",
      rulesVersion: 1,
      baseSeq: 0,
      device: A,
      createdAt: 0,
      op: { type: "create", kind: "folder", nodeId: "fold0001", parentId: ROOT_ID, name: "x" },
      seq: 1,
      serverTime: 0,
    };
    expect(() => applyEntry(st, e)).toThrow(UnsupportedRulesVersionError);
  });

  it("a snapshot built with v1 rules is refused", () => {
    const snap = takeSnapshot(initIndex(new MemoryIndexStore()));
    snap.meta = { headSeq: 5, rulesVersion: 1 };
    expect(() => loadSnapshot(snap)).toThrow(/rules version 1/);
  });

  it("the default server accepts only the current version", () => {
    const server = new Sequencer();
    const env = { opId: "op-v1-00002", baseSeq: 0, device: A, createdAt: 0, op: { type: "trash" as const, nodeId: "fold0001" } };
    expect(server.submit({ ...env, rulesVersion: 1 }).status).toBe("rules_version_rejected");
    expect(server.submit({ ...env, rulesVersion: RULES_VERSION }).status).toBe("accepted");
  });
});

describe("Q1: trashing a folder takes unseen nodes along, with a notice", () => {
  it("order 1 (concept): trash first, then a file added to it lands in „Odzyskane” (unchanged)", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    const base = s.seq;
    s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    const r = s.file(B, "file0001", "fold0001", "new.txt", { baseSeq: base });
    expect(codes(r)).toEqual(["moved_to_recovered"]);
    expect(s.node("file0001").parentId).toBe(RECOVERED_ID);
    expect(s.inTrash("file0001")).toBe(false);
    s.expectValid();
  });

  it("order 2: a file added unseen goes to the trash with the folder; its author is notified", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    const base = s.seq;
    s.file(B, "file0001", "fold0001", "new.txt", { baseSeq: base });
    const r = s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    expect(r.outcome).toBe("applied");
    expect(r.notices).toEqual([
      expect.objectContaining({
        code: "unseen_trashed_with_folder",
        deviceId: A.id,
        notifyDeviceId: B.id,
        nodeId: "file0001",
        relatedNodeId: "fold0001",
        reason: "placed",
      }),
    ]);
    expect(r.notices[0]!.silent).toBeUndefined();
    expect(s.node("file0001").parentId).toBe("fold0001");
    expect(s.node("file0001").trashed).toBeNull(); // in the trash through its folder
    expect(s.inTrash("file0001")).toBe(true);
    expect(s.recovered()).toEqual([]);
    s.expectValid();
  });

  it("order 2 is reversible: restoring the folder brings the unseen file back", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    const base = s.seq;
    s.file(B, "file0001", "fold0001", "new.txt", { baseSeq: base });
    s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    s.op(B, { type: "restore", nodeId: "fold0001" });
    expect(s.inTrash("file0001")).toBe(false);
    expect(s.names("fold0001")).toEqual(["new.txt"]);
  });

  it("unseen move-in, restore-into and new content are taken along too, one notice per kind", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0001", ROOT_ID, "moved.txt");
    s.file(A, "file0002", "fold0001", "restored.txt");
    s.file(A, "file0003", "fold0001", "edited.txt");
    s.op(A, { type: "trash", nodeId: "file0002" });
    const base = s.seq;
    s.op(B, { type: "move", nodeId: "file0001", parentId: "fold0001" }, { baseSeq: base });
    s.op(C, { type: "restore", nodeId: "file0002" }, { baseSeq: base });
    s.edit(B, "file0003", s.version("file0003"), { baseSeq: base });
    const r = s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    expect(r.outcome).toBe("applied");
    expect(r.notices.map((n) => [n.code, n.nodeId, n.notifyDeviceId, n.reason])).toEqual([
      ["unseen_trashed_with_folder", "file0001", B.id, "placed"],
      ["unseen_trashed_with_folder", "file0002", C.id, "placed"],
      ["unseen_trashed_with_folder", "file0003", B.id, "content"],
    ]);
    for (const id of ["file0001", "file0002", "file0003"]) expect(s.inTrash(id)).toBe(true);
    s.expectValid();
  });

  it("an unseen subtree upload gives one notice for its top node, not one per file", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    const base = s.seq;
    s.add(B, {
      type: "group",
      ops: [
        { type: "create", kind: "folder", nodeId: "fold0002", parentId: "fold0001", name: "album" },
        { type: "create", kind: "folder", nodeId: "fold0003", parentId: "fold0002", name: "2026" },
      ],
    }, { baseSeq: base });
    s.file(B, "file0001", "fold0002", "a.jpg", { baseSeq: base });
    s.file(B, "file0002", "fold0003", "b.jpg", { baseSeq: base });
    s.file(C, "file0003", "fold0003", "c.jpg", { baseSeq: base });
    const r = s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    expect(r.notices.map((n) => [n.nodeId, n.notifyDeviceId])).toEqual([
      ["fold0002", B.id],
      ["file0003", C.id],
    ]);
  });

  it("no notice for changes the author had seen, for its own changes, or for nodes already trashed", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(B, "file0001", "fold0001", "seen.txt");
    const base = s.seq;
    s.file(A, "file0002", "fold0001", "own.txt", { baseSeq: base });
    s.file(B, "file0003", "fold0001", "trashed.txt", { baseSeq: base });
    s.op(B, { type: "trash", nodeId: "file0003" }, { baseSeq: base });
    const r = s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    expect(codes(r)).toEqual([]);
  });

  it("explicit move out of the folder still wins in both orders (rule 4, second sentence)", () => {
    for (const moveFirst of [true, false]) {
      const s = new Scenario();
      s.folder(A, "fold0001", ROOT_ID, "src");
      s.folder(A, "fold0002", ROOT_ID, "dst");
      s.file(A, "file0001", "fold0001", "a.txt");
      const base = s.seq;
      const mv = () => s.op(B, { type: "move", nodeId: "file0001", parentId: "fold0002" }, { baseSeq: base });
      const tr = () => s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
      if (moveFirst) {
        mv();
        expect(codes(tr())).toEqual([]);
      } else {
        tr();
        mv();
      }
      expect(s.node("file0001").parentId).toBe("fold0002");
      expect(s.inTrash("file0001")).toBe(false);
      s.expectValid();
    }
  });
});

describe("#11: Q1 literally, the whole folder goes (koncept §5.2.3 exception)", () => {
  /** Laptop (A) and phone (B) see Raporty/q3.xlsx; B edits q3 and adds q4 offline; A trashes Raporty. */
  function raporty() {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "Raporty");
    s.file(A, "file0003", "fold0001", "q3.xlsx");
    const base = s.seq;
    s.edit(B, "file0003", s.version("file0003"), { baseSeq: base });
    s.file(B, "file0004", "fold0001", "q4.xlsx", { baseSeq: base });
    const newQ3 = s.version("file0003");
    const r = s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    return { s, base, newQ3, r };
  }

  it("new content and new file both go to the trash with the folder; the phone is told about each", () => {
    const { s, newQ3, r } = raporty();
    expect(r.outcome).toBe("applied");
    expect(r.notices.map((n) => [n.code, n.nodeId, n.notifyDeviceId, n.reason, n.silent])).toEqual([
      ["unseen_trashed_with_folder", "file0003", B.id, "content", undefined],
      ["unseen_trashed_with_folder", "file0004", B.id, "placed", undefined],
    ]);
    expect(s.inTrash("file0003")).toBe(true);
    expect(s.inTrash("file0004")).toBe(true);
    expect(s.version("file0003")).toBe(newQ3);
    expect(s.recovered()).toEqual([]);
    s.expectValid();
    // I4 in its amended form accepts it, and nothing was lost.
    expect(checkTrashSawContent(s.entries, s.store, s.results)).toEqual([]);
    expect(checkNoSilentLoss(s.entries, s.store)).toEqual([]);
  });

  it("restorable: restoring the folder brings back the new version and the new file", () => {
    const { s, newQ3 } = raporty();
    s.op(B, { type: "restore", nodeId: "fold0001" });
    expect(s.names("fold0001")).toEqual(["q3.xlsx", "q4.xlsx"]);
    expect(s.version("file0003")).toBe(newQ3);
  });

  it("not purged by the laptop that never saw it (Q3)", () => {
    const { s, base } = raporty();
    const r = s.op(A, { type: "purge", nodeId: "fold0001" }, { baseSeq: base });
    expect(r.notices[0]).toMatchObject({ code: "purge_kept_unseen", items: ["file0003", "file0004"] });
    expect(s.inTrash("file0003")).toBe(true);
    expect(s.store.getUpload(s.node("file0003").content!.uploadId)!.status).toBe("bound");
  });

  it("Q2 unchanged: trashing q3 alone is skipped silently, the file stays visible", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "Raporty");
    s.file(A, "file0003", "fold0001", "q3.xlsx");
    const base = s.seq;
    s.edit(B, "file0003", s.version("file0003"), { baseSeq: base });
    const r = s.op(A, { type: "trash", nodeId: "file0003" }, { baseSeq: base });
    expect(r.outcome).toBe("skipped");
    expect(visibleCodes(r)).toEqual([]);
    expect(s.inTrash("file0003")).toBe(false);
  });

  it("the I4 oracle still catches unseen content in the trash without a notice, or trashed directly", () => {
    const { s } = raporty();
    const muted = s.results.map((r) => ({ ...r, notices: r.notices.filter((n) => n.code !== "unseen_trashed_with_folder") }));
    // Both q3 (new version) and q4 (new file: its content is unseen too).
    expect(checkTrashSawContent(s.entries, s.store, muted).sort()).toEqual([
      expect.stringContaining("file0003"),
      expect.stringContaining("file0004"),
    ]);
    // A file with unseen content trashed on its own (what Q2 forbids), forged into the state.
    const s2 = new Scenario();
    s2.file(A, "file0001", ROOT_ID, "a.txt");
    const base = s2.seq;
    s2.edit(B, "file0001", s2.version("file0001"), { baseSeq: base });
    s2.op(A, { type: "rename", nodeId: "file0001", name: "b.txt" }, { baseSeq: base });
    s2.store.putNode({ ...s2.node("file0001"), trashed: { seq: s2.seq, at: 0 } });
    expect(checkTrashSawContent(s2.entries, s2.store, s2.results)).toEqual([expect.stringContaining("trashed directly")]);
  });
});

describe("Q2: trash of a file with unseen new content is skipped silently", () => {
  it("the notice exists but is silent", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const base = s.seq;
    s.edit(B, "file0001", s.version("file0001"), { baseSeq: base });
    const r = s.op(A, { type: "trash", nodeId: "file0001" }, { baseSeq: base });
    expect(r.outcome).toBe("skipped");
    expect(r.notices).toEqual([expect.objectContaining({ code: "trash_skipped_unseen_content", silent: true })]);
    expect(visibleCodes(r)).toEqual([]);
    expect(s.inTrash("file0001")).toBe(false);
  });

  it("other order (rule 3): trash first, then new content brings the file back, visible notice", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const base = s.seq;
    s.op(A, { type: "trash", nodeId: "file0001" }, { baseSeq: base });
    const r = s.edit(B, "file0001", s.version("file0001"), { baseSeq: base });
    expect(visibleCodes(r)).toEqual(["restored_by_new_content"]);
    expect(s.inTrash("file0001")).toBe(false);
  });

  it("inside a group, a silently skipped trash gives a silent summary", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.file(A, "file0002", ROOT_ID, "b.txt");
    const base = s.seq;
    s.edit(B, "file0001", s.version("file0001"), { baseSeq: base });
    const r = s.add(A, {
      type: "group",
      ops: [
        { type: "trash", nodeId: "file0001" },
        { type: "trash", nodeId: "file0002" },
      ],
    }, { baseSeq: base });
    expect(r.outcome).toBe("applied");
    expect(codes(r)).toEqual(["trash_skipped_unseen_content", "group_members_skipped"]);
    expect(visibleCodes(r)).toEqual([]);
    expect(s.inTrash("file0001")).toBe(false);
    expect(s.inTrash("file0002")).toBe(true);
  });
});

describe("Q3: purge deletes what its author had seen; unseen nodes stay in the trash", () => {
  /** B adds a file to docs, A (stale view) trashes docs (Q1 takes the file along). */
  function unseenInTrash() {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0001", "fold0001", "old.txt");
    s.folder(A, "fold0002", "fold0001", "sub");
    s.file(A, "file0004", "fold0002", "old2.txt");
    const base = s.seq;
    s.file(B, "file0002", "fold0002", "new.txt", { baseSeq: base });
    s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    return { s, base };
  }

  it("order 1: unseen change first, then purge: seen nodes go, unseen ones and their containers stay", () => {
    const { s, base } = unseenInTrash();
    const oldUpload = s.node("file0001").content!.uploadId;
    const newUpload = s.node("file0002").content!.uploadId;
    const r = s.op(A, { type: "purge", nodeId: "fold0001" }, { baseSeq: base });
    expect(r.outcome).toBe("applied");
    expect(r.notices).toEqual([expect.objectContaining({ code: "purge_kept_unseen", nodeId: "fold0001", items: ["file0002"] })]);
    expect(s.maybe("file0001")).toBeUndefined();
    expect(s.maybe("file0004")).toBeUndefined();
    expect(s.store.getUpload(oldUpload)).toMatchObject({ status: "released", ended: { reason: "purged" } });
    // Kept: the unseen file and the folders on its path, still in the trash.
    expect(s.node("file0002").parentId).toBe("fold0002");
    expect(s.node("fold0002").parentId).toBe("fold0001");
    expect(s.inTrash("file0002")).toBe(true);
    expect(s.store.getUpload(newUpload)!.status).toBe("bound");
    s.expectValid();
  });

  it("the 30-day clock of the kept nodes restarts at the purge", () => {
    const { s, base } = unseenInTrash();
    const trashedAt = s.node("fold0001").trashed!.at;
    s.op(A, { type: "purge", nodeId: "fold0001" }, { baseSeq: base });
    const purgeAt = s.entries[s.seq - 1]!.serverTime;
    expect(purgeAt).toBeGreaterThan(trashedAt);
    expect(s.node("fold0001").trashed!.at).toBe(purgeAt);
    const ret = 100_000;
    expect(expiredTrash(s.store, trashedAt + ret, ret)).toEqual([]);
    expect(expiredTrash(s.store, purgeAt + ret, ret)).toEqual(["fold0001"]);
  });

  it("a later purge by someone who has seen the kept nodes deletes them", () => {
    const { s, base } = unseenInTrash();
    s.op(A, { type: "purge", nodeId: "fold0001" }, { baseSeq: base });
    const r = s.op(C, { type: "purge", nodeId: "fold0001" });
    expect(r.outcome).toBe("applied");
    expect(codes(r)).toEqual([]);
    expect(s.maybe("fold0001")).toBeUndefined();
    expect(s.maybe("file0002")).toBeUndefined();
    s.expectValid();
  });

  it("order 2: purge first, then the change arrives: file added to the purged folder lands in „Odzyskane”", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0001", "fold0001", "old.txt");
    s.op(A, { type: "trash", nodeId: "fold0001" });
    const base = s.seq;
    s.op(A, { type: "purge", nodeId: "fold0001" }, { baseSeq: base });
    const r = s.file(B, "file0002", "fold0001", "new.txt", { baseSeq: base });
    expect(codes(r)).toEqual(["moved_to_recovered"]);
    expect(s.node("file0002").parentId).toBe(RECOVERED_ID);
    expect(s.maybe("fold0001")).toBeUndefined();
    s.expectValid();
  });

  it("order 2: purge first, then new content for a purged file becomes a new file in „Odzyskane”", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const v1 = s.version("file0001");
    s.op(A, { type: "trash", nodeId: "file0001" });
    const base = s.seq;
    s.op(A, { type: "purge", nodeId: "file0001" }, { baseSeq: base });
    const r = s.edit(B, "file0001", v1, { baseSeq: base, nameHint: "a.txt" });
    expect(codes(r)).toContain("content_for_purged_file");
    expect(s.recovered().map((n) => n.name)).toEqual(["a.txt"]);
  });

  it("an unseen move of a trashed file (rule 3: stays in the trash) keeps it from the purge", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "x");
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.op(A, { type: "trash", nodeId: "file0001" });
    const base = s.seq;
    s.op(B, { type: "move", nodeId: "file0001", parentId: "fold0001" }, { baseSeq: base });
    const r = s.op(A, { type: "purge", nodeId: "file0001" }, { baseSeq: base });
    expect(r.outcome).toBe("applied");
    expect(r.notices[0]).toMatchObject({ code: "purge_kept_unseen", items: ["file0001"] });
    expect(s.node("file0001").parentId).toBe("fold0001");
    expect(s.inTrash("file0001")).toBe(true);
    s.expectValid();
  });

  it("an unseen rename alone does not protect a node (only place and content count)", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.op(A, { type: "trash", nodeId: "file0001" });
    const base = s.seq;
    s.op(B, { type: "rename", nodeId: "file0001", name: "b.txt" }, { baseSeq: base });
    const r = s.op(A, { type: "purge", nodeId: "file0001" }, { baseSeq: base });
    expect(codes(r)).toEqual([]);
    expect(s.maybe("file0001")).toBeUndefined();
  });

  it("emptying the trash as a group: a member restored meanwhile is skipped, the rest is purged (Q3 + Q9)", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.file(A, "file0002", ROOT_ID, "b.txt");
    s.op(A, { type: "trash", nodeId: "file0001" });
    s.op(A, { type: "trash", nodeId: "file0002" });
    const base = s.seq;
    s.op(B, { type: "restore", nodeId: "file0002" }, { baseSeq: base });
    const r = s.add(A, {
      type: "group",
      ops: [
        { type: "purge", nodeId: "file0001" },
        { type: "purge", nodeId: "file0002" },
      ],
    }, { baseSeq: base });
    expect(r.outcome).toBe("applied");
    expect(codes(r)).toEqual(["purge_not_in_trash", "group_members_skipped"]);
    expect(r.notices[1]!.items).toEqual(["1"]);
    expect(s.maybe("file0001")).toBeUndefined();
    expect(s.inTrash("file0002")).toBe(false);
    s.expectValid();
  });
});

describe("Q6: conflict copy name in the local time of the losing version's author", () => {
  it("uses the tzOffsetMin from the losing version's envelope, no 'UTC'", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "raport.docx");
    const v1 = s.version("file0001");
    const base = s.seq;
    s.edit(A, "file0001", v1, { baseSeq: base, createdAt: Date.UTC(2026, 8, 29, 14, 5), tzOffsetMin: 120 });
    s.edit(B, "file0001", v1, { baseSeq: base, tzOffsetMin: -300 });
    expect(s.names()).toEqual(["raport (konflikt, laptop, 2026-09-29 16.05).docx", "raport.docx"]);
    s.expectValid();
  });

  it("day and year boundaries follow the author's offset", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const v1 = s.version("file0001");
    const base = s.seq;
    s.edit(C, "file0001", v1, { baseSeq: base, createdAt: Date.UTC(2026, 11, 31, 20, 0), tzOffsetMin: 330 });
    s.edit(B, "file0001", v1, { baseSeq: base });
    expect(s.names()).toContain("a (konflikt, pc, 2027-01-01 01.30).txt");
  });

  it("missing offset means UTC wall time; a bad offset is an invalid op", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const v1 = s.version("file0001");
    const base = s.seq;
    s.edit(A, "file0001", v1, { baseSeq: base, createdAt: Date.UTC(2026, 0, 1, 0, 0) });
    s.edit(B, "file0001", v1, { baseSeq: base });
    expect(s.names()).toContain("a (konflikt, laptop, 2026-01-01 00.00).txt");
    for (const bad of [1081, 1.5, Number.NaN]) {
      const r = s.op(A, { type: "rename", nodeId: "file0001", name: "z.txt" }, { tzOffsetMin: bad });
      expect(r.outcome).toBe("rejected");
      expect(r.notices[0]!.reason).toBe("bad_tz_offset");
    }
  });

  it("replicas agree on the name whatever their own zone; Replica stamps its own offset", () => {
    const server = new Sequencer();
    let n = 0;
    const id = () => `op-${String(++n).padStart(6, "0")}`;
    const t = Date.UTC(2026, 8, 29, 14, 5);
    const a = new Replica({ device: A, newOpId: id, now: () => t, tzOffsetMin: () => 120 });
    const b = new Replica({ device: B, newOpId: id, now: () => t + 1, tzOffsetMin: () => -420 });
    const env = a.enqueue({ type: "create", kind: "folder", nodeId: "fold0001", parentId: ROOT_ID, name: "x" });
    expect(env.tzOffsetMin).toBe(120);
    a.sync(server);
    b.sync(server);
    expect(b.store.getNode("fold0001")!.name).toBe("x");
    expect(takeSnapshot(a.store)).toEqual(takeSnapshot(b.store));
  });
});

describe("Q7: concurrent version with identical content is not a conflict", () => {
  it("same plaintext hash: no copy, silent notice, the later version is current", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt", { hash: H1 });
    const v1 = s.version("file0001");
    const base = s.seq;
    s.edit(A, "file0001", v1, { baseSeq: base, hash: H2 });
    const vA = s.node("file0001").content!;
    const r = s.edit(B, "file0001", v1, { baseSeq: base, hash: H2 });
    expect(r.outcome).toBe("applied");
    expect(codes(r)).toEqual(["content_identical"]);
    expect(visibleCodes(r)).toEqual([]);
    expect(s.names()).toEqual(["a.txt"]);
    expect(s.version("file0001")).not.toBe(vA.versionId);
    expect(s.node("file0001").content!.plaintextSha256).toBe(H2);
    expect(s.store.getUpload(vA.uploadId)).toMatchObject({ status: "released", ended: { reason: "superseded" } });
    s.expectValid();
  });

  it("baseVersionId = null with identical content: no conflict either", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt", { hash: H1 });
    const r = s.edit(B, "file0001", null, { hash: H1 });
    expect(codes(r)).toEqual(["content_identical"]);
    expect(s.names()).toEqual(["a.txt"]);
  });

  it("baseVersionId = null with different or unknown content is a conflict (Q7 unchanged)", () => {
    for (const [h1, h2] of [[H1, H2], [undefined, H1], [H1, undefined], [undefined, undefined]] as const) {
      const s = new Scenario();
      s.file(A, "file0001", ROOT_ID, "a.txt", h1 ? { hash: h1 } : {});
      const r = s.edit(B, "file0001", null, h2 ? { hash: h2 } : {});
      expect(codes(r)).toEqual(["content_conflict"]);
      expect(s.names()).toHaveLength(2);
    }
  });

  it("different hash with a concurrent edit is still a conflict", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt", { hash: H1 });
    const v1 = s.version("file0001");
    const base = s.seq;
    s.edit(A, "file0001", v1, { baseSeq: base, hash: H1 });
    const r = s.edit(B, "file0001", v1, { baseSeq: base, hash: H2 });
    expect(codes(r)).toEqual(["content_conflict"]);
  });

  it("a malformed hash is an invalid op", () => {
    const s = new Scenario();
    const r = s.file(A, "file0001", ROOT_ID, "a.txt", { hash: "ABC" });
    expect(r.outcome).toBe("rejected");
    expect(r.notices[0]!.reason).toBe("bad_plaintext_hash");
  });
});

describe("Q9: group ops skip only skipped members; rejected rolls back", () => {
  it("all members skipped: outcome skipped, state unchanged except headSeq", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "t");
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.op(A, { type: "trash", nodeId: "fold0001" });
    const before = s.dump();
    const r = s.add(B, {
      type: "group",
      ops: [
        { type: "move", nodeId: "file0001", parentId: "fold0001" },
        { type: "rename", nodeId: "ghost-0001", name: "x" },
      ],
    });
    expect(r.outcome).toBe("skipped");
    expect(codes(r)).toEqual(["move_target_in_trash", "node_purged", "group_members_skipped"]);
    expect(r.notices[2]!.items).toEqual(["0", "1"]);
    expect(s.dump()).toBe(before);
  });

  it("later members see the effects of earlier applied ones, skipped ones leave no trace", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "a");
    s.folder(A, "fold0002", ROOT_ID, "b");
    const r = s.add(B, {
      type: "group",
      ops: [
        { type: "move", nodeId: "fold0001", parentId: "fold0002" },
        { type: "move", nodeId: "fold0002", parentId: "fold0001" }, // cycle given member 0: skipped
        { type: "create", kind: "folder", nodeId: "fold0003", parentId: "fold0001", name: "c" },
      ],
    });
    expect(r.outcome).toBe("applied");
    expect(codes(r)).toEqual(["move_cycle", "group_members_skipped"]);
    expect(s.node("fold0001").parentId).toBe("fold0002");
    expect(s.node("fold0002").parentId).toBe(ROOT_ID);
    expect(s.node("fold0003").parentId).toBe("fold0001");
    s.expectValid();
  });

  it("a rejected member after applied ones: everything rolled back, notices of applied members dropped", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.file(A, "file0002", ROOT_ID, "b.txt");
    const before = s.dump();
    const r = s.add(B, {
      type: "group",
      ops: [
        { type: "rename", nodeId: "file0002", name: "A.TXT" }, // would be suffixed (name_suffixed)
        { type: "rename", nodeId: ROOT_ID, name: "x" }, // invalid
      ],
    });
    expect(r.outcome).toBe("rejected");
    expect(codes(r)).toEqual(["invalid_op", "group_rolled_back"]);
    expect(s.dump()).toBe(before);
  });
});
