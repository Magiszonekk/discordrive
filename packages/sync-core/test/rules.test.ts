import { describe, expect, it } from "vitest";
import { RECOVERED_ID, ROOT_ID, Sequencer, RULES_VERSION, Replica } from "../src/index.js";
import { A, B, C, Scenario, codes } from "./helpers.js";

describe("rule 1: two renames", () => {
  it("later rename wins, notice when the author had not seen the earlier one", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const base = s.seq;
    const r1 = s.op(A, { type: "rename", nodeId: "file0001", name: "b.txt" }, { baseSeq: base });
    const r2 = s.op(B, { type: "rename", nodeId: "file0001", name: "c.txt" }, { baseSeq: base });
    expect(r1.outcome).toBe("applied");
    expect(codes(r1)).toEqual([]);
    expect(r2.outcome).toBe("applied");
    expect(codes(r2)).toEqual(["rename_overrode_unseen"]);
    expect(s.node("file0001").name).toBe("c.txt");
    s.expectValid();
  });

  it("no notice when the author had seen the earlier rename", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.op(A, { type: "rename", nodeId: "file0001", name: "b.txt" });
    const r = s.op(B, { type: "rename", nodeId: "file0001", name: "c.txt" });
    expect(codes(r)).toEqual([]);
    expect(s.node("file0001").name).toBe("c.txt");
  });

  it("no notice for the author's own earlier rename, even with an old baseSeq", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const base = s.seq;
    s.op(A, { type: "rename", nodeId: "file0001", name: "b.txt" }, { baseSeq: base });
    const r = s.op(A, { type: "rename", nodeId: "file0001", name: "c.txt" }, { baseSeq: base });
    expect(codes(r)).toEqual([]);
  });
});

describe("rule 2: name collisions", () => {
  it("later node gets a deterministic (n) suffix", () => {
    const s = new Scenario();
    const base = s.seq;
    s.file(A, "file0001", ROOT_ID, "raport.pdf", { baseSeq: base });
    const r = s.file(B, "file0002", ROOT_ID, "raport.pdf", { baseSeq: base });
    expect(codes(r)).toEqual(["name_suffixed"]);
    expect(s.node("file0001").name).toBe("raport.pdf");
    expect(s.node("file0002").name).toBe("raport (2).pdf");
    s.file(C, "file0003", ROOT_ID, "raport.pdf");
    expect(s.node("file0003").name).toBe("raport (3).pdf");
    s.expectValid();
  });

  it("is case-insensitive and Unicode-aware (NFC names, case folding)", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "Żółw.TXT");
    s.file(B, "file0002", ROOT_ID, "żółw.txt");
    expect(s.node("file0002").name).toBe("żółw (2).txt");
    s.folder(A, "fold0001", ROOT_ID, "ΣΟΦΙΑ");
    s.folder(B, "fold0002", ROOT_ID, "σοφια");
    expect(s.node("fold0002").name).toBe("σοφια (2)");
    s.expectValid();
  });

  it("folders and dotfiles have no extension", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "v1.2");
    s.folder(B, "fold0002", ROOT_ID, "v1.2");
    expect(s.node("fold0002").name).toBe("v1.2 (2)");
    s.file(A, "file0001", ROOT_ID, ".env");
    s.file(B, "file0002", ROOT_ID, ".env");
    expect(s.node("file0002").name).toBe(".env (2)");
  });

  it("rename and move into a taken name also get a suffix", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.file(A, "file0002", "fold0001", "a.txt");
    s.file(A, "file0003", ROOT_ID, "b.txt");
    s.op(B, { type: "rename", nodeId: "file0003", name: "A.txt" });
    expect(s.node("file0003").name).toBe("A (2).txt");
    s.op(B, { type: "move", nodeId: "file0001", parentId: "fold0001" });
    expect(s.node("file0001").name).toBe("a (2).txt");
    s.expectValid();
  });

  it("Windows-forbidden names are accepted unchanged", () => {
    const s = new Scenario();
    const r = s.file(A, "file0001", ROOT_ID, 'CON:<>?*".txt');
    expect(r.outcome).toBe("applied");
    expect(s.node("file0001").name).toBe('CON:<>?*".txt');
  });

  it("trashed nodes are outside the uniqueness scope; restore resolves the collision", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.op(A, { type: "trash", nodeId: "file0001" });
    s.file(A, "file0002", ROOT_ID, "a.txt");
    expect(s.node("file0002").name).toBe("a.txt");
    const r = s.op(A, { type: "restore", nodeId: "file0001" });
    expect(codes(r)).toEqual(["name_suffixed"]);
    expect(s.node("file0001").name).toBe("a (2).txt");
    s.expectValid();
  });

  it("swapping two names inside one group op works (all-or-nothing, no transient collision)", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.file(A, "file0002", ROOT_ID, "b.txt");
    const r = s.add(A, {
      type: "group",
      ops: [
        { type: "rename", nodeId: "file0001", name: "tmp.txt" },
        { type: "rename", nodeId: "file0002", name: "a.txt" },
        { type: "rename", nodeId: "file0001", name: "b.txt" },
      ],
    });
    expect(r.outcome).toBe("applied");
    expect(s.node("file0001").name).toBe("b.txt");
    expect(s.node("file0002").name).toBe("a.txt");
    s.expectValid();
  });
});

describe("rule 3: operations on a file in the trash", () => {
  it("rename and move are applied, the file stays in the trash", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const base = s.seq;
    s.op(A, { type: "trash", nodeId: "file0001" }, { baseSeq: base });
    const r1 = s.op(B, { type: "rename", nodeId: "file0001", name: "b.txt" }, { baseSeq: base });
    const r2 = s.op(B, { type: "move", nodeId: "file0001", parentId: "fold0001" }, { baseSeq: base });
    expect([r1.outcome, r2.outcome]).toEqual(["applied", "applied"]);
    const n = s.node("file0001");
    expect(n.trashed).not.toBeNull();
    expect(n.name).toBe("b.txt");
    expect(n.parentId).toBe("fold0001");
    s.expectValid();
  });

  it("new content brings the file back from the trash, with a notice", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const v1 = s.version("file0001");
    const base = s.seq;
    s.op(A, { type: "trash", nodeId: "file0001" }, { baseSeq: base });
    const r = s.edit(B, "file0001", v1, { baseSeq: base });
    expect(r.outcome).toBe("applied");
    expect(codes(r)).toContain("restored_by_new_content");
    const n = s.node("file0001");
    expect(n.trashed).toBeNull();
    expect(n.parentId).toBe(ROOT_ID);
    expect(n.content!.versionId).not.toBe(v1);
    s.expectValid();
  });

  it("new content for a file inside a trashed folder lands in „Odzyskane”", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0001", "fold0001", "a.txt");
    const v1 = s.version("file0001");
    const base = s.seq;
    s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    const r = s.edit(B, "file0001", v1, { baseSeq: base });
    expect(codes(r)).toEqual(expect.arrayContaining(["restored_by_new_content", "moved_to_recovered"]));
    const n = s.node("file0001");
    expect(n.parentId).toBe(RECOVERED_ID);
    expect(n.recoveredFrom?.path).toEqual(["docs"]);
    expect(s.node("fold0001").trashed).not.toBeNull();
    s.expectValid();
  });

  it("other order: trash after an unseen new version is skipped (provisional, Q2)", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const v1 = s.version("file0001");
    const base = s.seq;
    s.edit(B, "file0001", v1, { baseSeq: base });
    const r = s.op(A, { type: "trash", nodeId: "file0001" }, { baseSeq: base });
    expect(r.outcome).toBe("skipped");
    expect(codes(r)).toEqual(["trash_skipped_unseen_content"]);
    expect(s.node("file0001").trashed).toBeNull();
  });
});

describe("rule 3b: operations on a purged file", () => {
  it("metadata operations are dropped with a notice", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.op(A, { type: "trash", nodeId: "file0001" });
    const base = s.seq;
    s.op(A, { type: "purge", nodeId: "file0001" }, { baseSeq: base });
    for (const op of [
      { type: "rename", nodeId: "file0001", name: "b.txt" },
      { type: "move", nodeId: "file0001", parentId: "fold0001" },
      { type: "trash", nodeId: "file0001" },
      { type: "restore", nodeId: "file0001" },
    ] as const) {
      const r = s.op(B, op, { baseSeq: base });
      expect(r.outcome).toBe("skipped");
      expect(codes(r)).toEqual(["node_purged"]);
    }
    expect(s.maybe("file0001")).toBeUndefined();
    s.expectValid();
  });

  it("new content for a purged file becomes a new file in „Odzyskane”", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const v1 = s.version("file0001");
    s.op(A, { type: "trash", nodeId: "file0001" });
    const base = s.seq;
    s.op(A, { type: "purge", nodeId: "file0001" }, { baseSeq: base });
    const r = s.edit(B, "file0001", v1, { baseSeq: base, nameHint: "a.txt" });
    expect(r.outcome).toBe("applied");
    expect(codes(r)).toContain("content_for_purged_file");
    const rec = s.recovered();
    expect(rec).toHaveLength(1);
    expect(rec[0]!.name).toBe("a.txt");
    expect(rec[0]!.id).not.toBe("file0001");
    expect(s.maybe("file0001")).toBeUndefined();
    s.expectValid();
  });

  it("unknown ID counts as purged", () => {
    const s = new Scenario();
    const r = s.edit(B, "neverexisted", null, { nameHint: "x.bin" });
    expect(codes(r)).toContain("content_for_purged_file");
    expect(s.recovered().map((n) => n.name)).toEqual(["x.bin"]);
  });

  it("other order: purge after unseen new content is skipped (provisional, Q3)", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const v1 = s.version("file0001");
    s.op(A, { type: "trash", nodeId: "file0001" });
    const base = s.seq;
    s.edit(B, "file0001", v1, { baseSeq: base });
    const r = s.op(A, { type: "purge", nodeId: "file0001" }, { baseSeq: base });
    expect(r.outcome).toBe("skipped");
    expect(s.node("file0001").trashed).toBeNull();
  });
});

describe("rule 4: file added to a deleted folder", () => {
  it("create into a trashed folder lands in „Odzyskane” with the target path", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "zdjęcia");
    s.folder(A, "fold0002", "fold0001", "2026");
    const base = s.seq;
    s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    const r = s.file(B, "file0001", "fold0002", "img.jpg", { baseSeq: base });
    expect(codes(r)).toContain("moved_to_recovered");
    const n = s.node("file0001");
    expect(n.parentId).toBe(RECOVERED_ID);
    expect(n.trashed).toBeNull();
    expect(n.recoveredFrom).toMatchObject({ parentId: "fold0002", path: ["zdjęcia", "2026"] });
    s.expectValid();
  });

  it("create into a purged folder lands in „Odzyskane”", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "tmp");
    s.op(A, { type: "trash", nodeId: "fold0001" });
    const base = s.seq;
    s.op(A, { type: "purge", nodeId: "fold0001" }, { baseSeq: base });
    const r = s.file(B, "file0001", "fold0001", "a.txt", { baseSeq: base });
    expect(codes(r)).toContain("moved_to_recovered");
    expect(s.node("file0001").parentId).toBe(RECOVERED_ID);
    s.expectValid();
  });

  it("other order: trashing a folder rescues children added unseen", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "docs");
    s.file(A, "file0000", "fold0001", "old.txt");
    const base = s.seq;
    s.file(B, "file0001", "fold0001", "new.txt", { baseSeq: base });
    const r = s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    expect(r.outcome).toBe("applied");
    expect(codes(r)).toContain("moved_to_recovered");
    expect(s.node("file0001").parentId).toBe(RECOVERED_ID);
    expect(s.node("file0001").trashed).toBeNull();
    // Seen content goes to the trash with the folder.
    expect(s.node("file0000").parentId).toBe("fold0001");
    s.expectValid();
  });

  it("explicit move of a file wins over indirect deletion through its folder", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "src");
    s.folder(A, "fold0002", ROOT_ID, "dst");
    s.file(A, "file0001", "fold0001", "a.txt");
    const base = s.seq;
    s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    const r = s.op(B, { type: "move", nodeId: "file0001", parentId: "fold0002" }, { baseSeq: base });
    expect(r.outcome).toBe("applied");
    expect(s.node("file0001").parentId).toBe("fold0002");
    expect(s.names("fold0002")).toEqual(["a.txt"]);
    s.expectValid();
  });

  it("explicit move wins in the other order too", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "src");
    s.folder(A, "fold0002", ROOT_ID, "dst");
    s.file(A, "file0001", "fold0001", "a.txt");
    const base = s.seq;
    s.op(B, { type: "move", nodeId: "file0001", parentId: "fold0002" }, { baseSeq: base });
    s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    expect(s.node("file0001").parentId).toBe("fold0002");
    expect(s.node("file0001").trashed).toBeNull();
    s.expectValid();
  });
});

describe("rule 5: move into a folder in the trash", () => {
  it("is skipped, the node stays where it was, with a notice", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "dst");
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const base = s.seq;
    s.op(A, { type: "trash", nodeId: "fold0001" }, { baseSeq: base });
    const r = s.op(B, { type: "move", nodeId: "file0001", parentId: "fold0001" }, { baseSeq: base });
    expect(r.outcome).toBe("skipped");
    expect(codes(r)).toEqual(["move_target_in_trash"]);
    expect(s.node("file0001").parentId).toBe(ROOT_ID);
  });

  it("also when only an ancestor of the target is in the trash", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "a");
    s.folder(A, "fold0002", "fold0001", "b");
    s.file(A, "file0001", ROOT_ID, "x.txt");
    s.op(A, { type: "trash", nodeId: "fold0001" });
    const r = s.op(B, { type: "move", nodeId: "file0001", parentId: "fold0002" });
    expect(r.outcome).toBe("skipped");
  });

  it("move into a purged folder is skipped", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "dst");
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.op(A, { type: "trash", nodeId: "fold0001" });
    const base = s.seq;
    s.op(A, { type: "purge", nodeId: "fold0001" }, { baseSeq: base });
    const r = s.op(B, { type: "move", nodeId: "file0001", parentId: "fold0001" }, { baseSeq: base });
    expect(r.outcome).toBe("skipped");
    expect(codes(r)).toEqual(["move_target_purged"]);
  });
});

describe("rule 6: move cycles", () => {
  it("first move applies, the one closing a cycle is skipped", () => {
    const s = new Scenario();
    s.folder(A, "foldA001", ROOT_ID, "A");
    s.folder(A, "foldB001", ROOT_ID, "B");
    const base = s.seq;
    const r1 = s.op(A, { type: "move", nodeId: "foldA001", parentId: "foldB001" }, { baseSeq: base });
    const r2 = s.op(B, { type: "move", nodeId: "foldB001", parentId: "foldA001" }, { baseSeq: base });
    expect(r1.outcome).toBe("applied");
    expect(r2.outcome).toBe("skipped");
    expect(codes(r2)).toEqual(["move_cycle"]);
    expect(s.node("foldA001").parentId).toBe("foldB001");
    expect(s.node("foldB001").parentId).toBe(ROOT_ID);
    s.expectValid();
  });

  it("moving a folder into itself is skipped", () => {
    const s = new Scenario();
    s.folder(A, "foldA001", ROOT_ID, "A");
    const r = s.op(A, { type: "move", nodeId: "foldA001", parentId: "foldA001" });
    expect(r.outcome).toBe("skipped");
  });

  it("deep cycle through several levels is skipped", () => {
    const s = new Scenario();
    s.folder(A, "fold0001", ROOT_ID, "1");
    s.folder(A, "fold0002", "fold0001", "2");
    s.folder(A, "fold0003", "fold0002", "3");
    const r = s.op(B, { type: "move", nodeId: "fold0001", parentId: "fold0003" });
    expect(r.outcome).toBe("skipped");
    s.expectValid();
  });
});

describe("rule 7: two content versions", () => {
  it("later version is current, earlier one stays as a visible conflict copy", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "notatki.md");
    const v1 = s.version("file0001");
    const base = s.seq;
    s.edit(A, "file0001", v1, { baseSeq: base, createdAt: Date.UTC(2026, 8, 29, 14, 5) });
    const vA = s.version("file0001");
    const r = s.edit(B, "file0001", v1, { baseSeq: base });
    expect(codes(r)).toContain("content_conflict");
    const vB = s.version("file0001");
    expect(vB).not.toBe(vA);
    expect(s.names()).toEqual(["notatki (konflikt, laptop, 2026-09-29 14.05 UTC).md", "notatki.md"]);
    const copy = s.recovered().length === 0 ? [...s.store.allNodes()].find((n) => n.conflictOf) : undefined;
    expect(copy?.content?.versionId).toBe(vA);
    expect(copy?.conflictOf?.nodeId).toBe("file0001");
    s.expectValid();
  });

  it("sequential edits (author saw the current version) produce no copy", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    s.edit(A, "file0001", s.version("file0001"));
    const r = s.edit(B, "file0001", s.version("file0001"));
    expect(codes(r)).toEqual([]);
    expect(s.names()).toEqual(["a.txt"]);
    s.expectValid();
  });

  it("three concurrent versions produce two copies", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const v1 = s.version("file0001");
    const base = s.seq;
    s.edit(A, "file0001", v1, { baseSeq: base });
    s.edit(B, "file0001", v1, { baseSeq: base });
    s.edit(C, "file0001", v1, { baseSeq: base });
    expect(s.names()).toHaveLength(3);
    s.expectValid();
  });

  it("superseded version releases its upload; conflict copy keeps it bound", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const u1 = s.node("file0001").content!.uploadId;
    s.edit(A, "file0001", s.version("file0001"));
    expect(s.store.getUpload(u1)!.status).toBe("released");
    expect(s.store.getUpload(u1)!.ended?.reason).toBe("superseded");
  });
});

describe("rule 8: interrupted upload", () => {
  it("commit after abort is refused with a notice", () => {
    const s = new Scenario();
    s.op(A, { type: "upload_begin", uploadId: "upl-x0001" });
    s.op(C, { type: "upload_abort", uploadId: "upl-x0001" });
    const r = s.op(A, { type: "upload_commit", uploadId: "upl-x0001" });
    expect(r.outcome).toBe("rejected");
    expect(codes(r)).toEqual(["upload_aborted"]);
    expect(s.store.getUpload("upl-x0001")!.status).toBe("aborted");
  });

  it("group commit+create after abort is rolled back entirely", () => {
    const s = new Scenario();
    const c = s.newContent();
    s.op(A, { type: "upload_begin", uploadId: c.uploadId });
    s.op(C, { type: "upload_abort", uploadId: c.uploadId });
    const r = s.add(A, {
      type: "group",
      ops: [
        { type: "upload_commit", uploadId: c.uploadId },
        { type: "create", kind: "file", nodeId: "file0001", parentId: ROOT_ID, name: "a.txt", content: c },
      ],
    });
    expect(r.outcome).toBe("rejected");
    expect(codes(r)).toEqual(["upload_aborted", "group_rolled_back"]);
    expect(s.maybe("file0001")).toBeUndefined();
    s.expectValid();
  });

  it("an upload cannot be bound twice, nor bound before commit", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const c = s.node("file0001").content!;
    const r = s.op(B, { type: "create", kind: "file", nodeId: "file0002", parentId: ROOT_ID, name: "b.txt", content: { ...c, versionId: "ver-other1" } });
    expect(r.outcome).toBe("rejected");
    const c2 = s.newContent();
    s.op(A, { type: "upload_begin", uploadId: c2.uploadId });
    const r2 = s.op(A, { type: "create", kind: "file", nodeId: "file0003", parentId: ROOT_ID, name: "c.txt", content: c2 });
    expect(r2.outcome).toBe("rejected");
    expect(r2.notices[0]!.reason).toBe("upload_not_committed");
  });

  it("an op that touches an upload without declaring it in leaseGuard is rejected", () => {
    const s = new Scenario();
    const r = s.op(A, { type: "upload_begin", uploadId: "upl-x0001" }, { leaseGuard: [] });
    expect(r.outcome).toBe("rejected");
    expect(r.notices[0]!.reason).toBe("upload_not_guarded");
  });

  it("abort of a bound upload is refused (fragments are in use)", () => {
    const s = new Scenario();
    s.file(A, "file0001", ROOT_ID, "a.txt");
    const u = s.node("file0001").content!.uploadId;
    const r = s.op(C, { type: "upload_abort", uploadId: u });
    expect(r.outcome).toBe("rejected");
    s.expectValid();
  });

  it("server: leases gate cleanup; the uploader loses the race once the lease is taken over", () => {
    let now = 0;
    const server = new Sequencer({ now: () => now, leaseMs: 1000 });
    let n = 0;
    const mk = (d: typeof A) => new Replica({ device: d, newOpId: () => `op-${d.id}-${++n}`.padEnd(8, "x"), now: () => now });
    const up = mk(A);
    const cleaner = mk(C);

    expect(server.renewLease("upl-l0001", A.id)).toBe(true);
    up.enqueue({ type: "upload_begin", uploadId: "upl-l0001" });
    expect(up.sync(server)).toBeNull();

    // Lease still valid: nobody else can take it.
    expect(server.renewLease("upl-l0001", C.id)).toBe(false);
    expect(server.expiredLeases()).toEqual([]);

    now = 5000; // uploader went silent
    expect(server.expiredLeases().map((l) => l.uploadId)).toEqual(["upl-l0001"]);
    expect(server.renewLease("upl-l0001", C.id)).toBe(true);
    cleaner.pull(server);
    expect(cleaner.store.getUpload("upl-l0001")!.status).toBe("open");
    cleaner.enqueue({ type: "upload_abort", uploadId: "upl-l0001" });
    expect(cleaner.sync(server)).toBeNull();

    // The uploader comes back and tries to commit: the server refuses (lease lost).
    up.enqueue({ type: "upload_commit", uploadId: "upl-l0001" });
    const r = up.sync(server);
    expect(r?.status).toBe("lease_rejected");
    up.pull(server);
    expect(up.store.getUpload("upl-l0001")!.status).toBe("aborted");
  });
});

describe("rule 9: duplicates", () => {
  it("server refuses a known opId and returns the original entry", () => {
    const server = new Sequencer();
    const env = {
      opId: "op-dup0001",
      rulesVersion: RULES_VERSION,
      baseSeq: 0,
      device: A,
      createdAt: 0,
      op: { type: "create" as const, kind: "folder" as const, nodeId: "fold0001", parentId: ROOT_ID, name: "x" },
    };
    const r1 = server.submit(env);
    const r2 = server.submit({ ...env, baseSeq: 0 });
    expect(r1.status).toBe("accepted");
    expect(r2.status).toBe("duplicate");
    expect(server.headSeq).toBe(1);
    if (r1.status === "accepted" && r2.status === "duplicate") expect(r2.entry.seq).toBe(r1.entry.seq);
  });

  it("replica: re-sending after a lost response leaves one entry and an empty outbox", () => {
    const server = new Sequencer();
    let n = 0;
    const r = new Replica({ device: A, newOpId: () => `op-A-${String(++n).padStart(4, "0")}` });
    r.enqueue({ type: "create", kind: "folder", nodeId: "fold0001", parentId: ROOT_ID, name: "x" });
    server.submit(r.outbox[0]!); // response lost
    r.sync(server); // resend
    expect(server.headSeq).toBe(1);
    expect(r.outbox).toHaveLength(0);
    expect(r.store.getNode("fold0001")!.name).toBe("x");
  });
});

describe("rule 10: device offline for a long time", () => {
  it("catches up first, then sends its ops; rules act on the current state", () => {
    const server = new Sequencer();
    let n = 0;
    const id = (d: string) => () => `op-${d}-${String(++n).padStart(4, "0")}`;
    const a = new Replica({ device: A, newOpId: id("A") });
    const b = new Replica({ device: B, newOpId: id("B") });

    a.enqueue({ type: "create", kind: "folder", nodeId: "fold0001", parentId: ROOT_ID, name: "docs" });
    a.sync(server);
    b.sync(server);

    // B goes offline and works on docs.
    b.enqueue({ type: "create", kind: "folder", nodeId: "fold0002", parentId: "fold0001", name: "offline" });
    b.enqueue({ type: "rename", nodeId: "fold0001", name: "docs-b" });

    // Meanwhile A deletes docs and makes 500 other changes.
    a.enqueue({ type: "trash", nodeId: "fold0001" });
    for (let i = 0; i < 500; i++) {
      a.enqueue({ type: "create", kind: "folder", nodeId: `fa${String(i).padStart(6, "0")}`, parentId: ROOT_ID, name: `f${i}` });
    }
    a.sync(server);

    b.sync(server);
    a.sync(server);
    expect(b.outbox).toHaveLength(0);
    expect(a.snapshot()).toEqual(b.snapshot());
    // B's folder was created into a trashed folder: rule 4.
    expect(a.store.getNode("fold0002")!.parentId).toBe(RECOVERED_ID);
    // B's rename applied to the trashed folder: rule 3, still in the trash.
    expect(a.store.getNode("fold0001")!.name).toBe("docs-b");
    expect(a.store.getNode("fold0001")!.trashed).not.toBeNull();
  });
});
