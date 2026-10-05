#!/usr/bin/env python3
"""Mutation check: break one rule at a time in src/apply.ts and verify the tests catch it.

Each mutation is (name, old, new). The file is restored after every run.
A mutation that still passes all tests means the tests do not guard that rule.
"""
import subprocess, sys, os, pathlib, signal

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "apply.ts"
ENV = dict(os.environ, PATH="/usr/local/bin:" + os.environ["PATH"], FUZZ_RUNS=os.environ.get("FUZZ_RUNS", "200"))

MUTATIONS = [
    ("r1 no unseen notice", 'if (ctx.unseen(node.nameChanged)) {', 'if (false && ctx.unseen(node.nameChanged)) {'),
    ("r2 no suffix", "  if (!taken(name)) return name;\n", "  return name;\n"),
    ("r2 case-sensitive", "const other = s.childByKey(parentId, nameKey(n));", "const other = s.childByKey(parentId, n);"),
    ("r3 no restore on content", "  if (inTrash(ctx.s, node.id)) {\n    const parentId = node.parentId!;", "  if (false) {\n    const parentId = node.parentId!;"),
    ("r3b drop content", "    placeRecovered(ctx, rec, null, \"content_for_purged_file\");", "    return \"skipped\";"),
    ("r4 create into trash stays", "  } else if (inTrash(ctx.s, op.parentId)) {\n    // Rule 4: added to a deleted folder.\n    placeRecovered(ctx, rec, op.parentId, \"parent_in_trash\");", "  } else if (inTrash(ctx.s, op.parentId)) {\n    placeLive(ctx, rec, op.parentId, op.name);"),
    ("Q1 no unseen notice", "  if (node.kind === \"folder\") notifyUnseenTrashed(ctx, node.id);", ""),
    ("Q1 notify own device", "      if (ctx.unseen(rec.placed)) devices.add(rec.placed.deviceId);", "      devices.add(rec.placed.deviceId);"),
    ("r5 move into trash allowed", "  if (inTrash(ctx.s, op.parentId)) {\n    // Rule 5.", "  if (false) {\n    // Rule 5."),
    ("r6 no cycle check", "  if (isSelfOrAncestor(ctx.s, node.id, op.parentId)) {", "  if (node.id === op.parentId) {"),
    ("r7 no conflict copy", "  if (cur && cur.versionId !== op.baseVersionId) {", "  if (false) {"),
    ("r8 commit after abort", "  if (u.status === \"aborted\") {\n    // Rule 8", "  if (u.status === \"aborted\" && false) {\n    // Rule 8"),
    ("r8 abort bound upload", "  if (u.status === \"bound\" || u.status === \"released\") return ctx.reject(\"upload_in_use\");", ""),
    ("group not atomic", "  const target = ok ? ov : new OverlayStore(store);", "  const target = ov;"),
    ("Q3 purge ignores unseen", "    if (unseen) {\n      keptRoots.push(id);", "    if (false) {\n      keptRoots.push(id);"),
    ("Q3 purge skips whole subtree", "  const toDelete = doomed.filter((id) => !containers.has(id)).sort(cmp);", "  const toDelete: NodeId[] = [];"),
    ("Q3 no clock reset", "  if (top) ctx.s.putNode({ ...top, trashed: { seq: top.trashed!.seq, at: ctx.e.serverTime } });", ""),
    ("Q2 trash ignores unseen content", "  if (node.content && ctx.unseen(contentMark(node.content))) {", "  if (false) {"),
    ("Q2 notice not silent", "  \"trash_skipped_unseen_content\",\n  \"content_identical\",\n]);", "  \"content_identical\",\n]);"),
    ("Q6 ignore author offset", "conflictName(rec.name, cur.device.name, cur.createdAt, cur.tzOffsetMin)", "conflictName(rec.name, cur.device.name, cur.createdAt)"),
    ("Q7 identical still conflicts", "  if (cur && cur.versionId !== op.baseVersionId && !identical) {", "  if (cur && cur.versionId !== op.baseVersionId) {"),
    ("Q7 null hashes count as identical", "cur !== null && cur.plaintextSha256 !== null && cur.plaintextSha256 === version.plaintextSha256;", "cur !== null && cur.plaintextSha256 === version.plaintextSha256;"),
    ("Q9 skipped rolls back group", "    if (r === \"rejected\") {\n      // Q9", "    if (r === \"rejected\" || r === \"skipped\") {\n      // Q9"),
    ("Q9 skipped member leaves traces", "    if (r === \"skipped\") {\n      skipped.push(String(i));", "    if (r === \"skipped\") {\n      memberStore.commit();\n      skipped.push(String(i));"),
    ("Q9 rejected member does not roll back", "      ctx.notice({ code: \"group_rolled_back\", reason: `sub_${i}` });\n      return r;", "      continue;"),
    ("nondeterministic order", "  return [...s.childIds(parentId)].sort(cmp);", "  return [...s.childIds(parentId)];"),
    ("unseen ignores own device", "    return m.seq > this.e.baseSeq && m.deviceId !== this.e.device.id;", "    return m.seq > this.e.baseSeq;"),
]

orig = SRC.read_text()
only = os.environ.get("ONLY")
if only:
    MUTATIONS = [m for m in MUTATIONS if only in m[0]]
survivors = []
try:
    for name, old, new in MUTATIONS:
        if orig.count(old) != 1:
            print(f"?? {name}: pattern found {orig.count(old)} times, skipped")
            survivors.append(name + " (pattern)")
            continue
        SRC.write_text(orig.replace(old, new))
        proc = subprocess.Popen(["npx", "vitest", "run"], cwd=ROOT, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            out, _ = proc.communicate(timeout=300)
        except subprocess.TimeoutExpired:
            # A hang counts as caught (e.g. a cycle let through makes a tree walk spin),
            # but kill the whole process group so vitest workers do not linger.
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()
            print(f"caught  {name}  <- timeout (hang)")
            continue
        r = subprocess.CompletedProcess(proc.args, proc.returncode, out, "")
        caught = r.returncode != 0
        failed = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith("×") or "FAIL" in l][:3]
        print(f"{'caught ' if caught else 'SURVIVED'} {name}" + (f"  <- {failed[0][:110]}" if failed else ""))
        if not caught:
            survivors.append(name)
finally:
    SRC.write_text(orig)
print(f"\n{len(MUTATIONS) - len(survivors)}/{len(MUTATIONS)} mutations caught")
if survivors:
    print("survivors:", survivors)
    sys.exit(1)
