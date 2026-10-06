// Randomized test (koncept §5.4): thousands of mixed, concurrent operation
// sequences from several devices against one server, then invariants.
//
// Each fast-check case is a list of abstract actions. An interpreter turns
// them into concrete client behaviour: devices create/rename/move/trash/
// restore/purge/edit based on their OWN (often stale) view, upload with
// leases, push/pull at random times, go offline, a cleaner aborts uploads
// whose lease expired, GC physically deletes fragments, a new device joins
// from a snapshot. Invalid ops are mixed in.
//
// Invariants checked at the end of every case:
//  I1 all replicas (incl. a fresh replay, a replay into a store with reversed
//     iteration order, and snapshot+tail at a random cut) have identical state;
//     the reversed-order replay also yields identical notices,
//  I2 no cycles, every node reachable from a root, no orphans (every prefix
//     of the log, not only the final state),
//  I3 names unique per folder (case-folded), every prefix,
//  I4 no content lost without a delete operation whose author had seen it
//     (or an identical-content replacement, Q7); unseen content never
//     disappears silently: it stays visible, or it went to the trash together
//     with a folder and its author was notified (§5.2.3 exception, Q1 + #11),
//  I5 no file points at physically deleted fragments,
//  I6 snapshot + log tail == full log (also through JSON serialization).
//
// FUZZ_RUNS (default 300; `npm run test:fuzz` uses 20000) and FUZZ_SEED control the run.

import fc from "fast-check";
import { expect } from "./expect.js";
import {
  canonicalState,
  checkInvariants,
  deletableUploads,
  initIndex,
  loadSnapshot,
  applyEntry,
  MemoryIndexStore,
  RECOVERED_ID,
  Replica,
  ROOT_ID,
  Sequencer,
  takeSnapshot,
  type ApplyResult,
  type DeviceInfo,
  type IndexSnapshot,
  type IndexStore,
  type LogEntry,
  type NodeRecord,
  type Operation,
  type SingleOp,
  type UploadId,
} from "../src/index.js";
import { checkNoDeletedFragments, checkNoSilentLoss, checkTrashSawContent } from "./oracles.js";


const NAMES = [
  "a",
  "A",
  "a.txt",
  "A.TXT",
  "a (2).txt",
  "b",
  "B.txt",
  "Łódź",
  "ŁÓDŹ",
  "Σοφία",
  "σοφία",
  "ΣΟΦΊΑ",
  "straße",
  "STRASSE",
  "İstanbul",
  "i̇stanbul",
  "x".repeat(1020) + ".txt",
  "CON",
  ".env",
  "v1.2",
];

const LEASE_MS = 1000;
const FRAGMENT_RETENTION_TEST_MS = 3000;

export interface Action {
  who: number;
  what: number;
  x: number;
  y: number;
  z: number;
}

export const actionArb: fc.Arbitrary<Action> = fc.record({
  who: fc.nat({ max: 3 }),
  what: fc.nat({ max: 99 }),
  x: fc.nat({ max: 1_000_000 }),
  y: fc.nat({ max: 1_000_000 }),
  z: fc.nat({ max: 1_000_000 }),
});

/** Weighted action table: [kind, weight]. Upload/edit paths are weighted up so rules 3, 3b, 7, 8 get real coverage. */
const KINDS: [string, number][] = [
  ["mkdir", 8],
  ["upload_begin", 5],
  ["upload_finish", 8],
  ["upload_fast", 10],
  ["rename", 6],
  ["move", 7],
  ["trash", 6],
  ["restore", 4],
  ["purge", 4],
  ["group", 4],
  ["push", 14],
  ["pull", 12],
  ["time", 3],
  ["cleaner", 3],
  ["invalid", 2],
  ["gc", 2],
  ["join", 2],
];
const KIND_TABLE: string[] = KINDS.flatMap(([k, w]) => Array<string>(w).fill(k));
if (KIND_TABLE.length !== 100) throw new Error(`KIND_TABLE must have 100 slots, has ${KIND_TABLE.length}`);

interface Dev {
  info: DeviceInfo;
  r: Replica;
  nodeN: number;
  upN: number;
  /** Uploads this device started and still intends to finish. */
  myUploads: UploadId[];
}

/** Store with reversed iteration order: apply() must not depend on it. */
class ReversedStore extends MemoryIndexStore {
  override childIds(p: string): Iterable<string> {
    return [...super.childIds(p)].reverse();
  }
  override allNodes(): Iterable<NodeRecord> {
    return [...super.allNodes()].reverse();
  }
}

const pick = <T>(arr: readonly T[], n: number): T | undefined => (arr.length === 0 ? undefined : arr[n % arr.length]);
const pad = (n: number) => String(n).padStart(5, "0");

/** Canonical nodes + uploads without meta (headSeq always moves). */
function canonicalTree(store: IndexStore): string {
  const s = takeSnapshot(store);
  return JSON.stringify([s.nodes, s.uploads]);
}

export interface Stats {
  runs: number;
  entries: number;
  outcomes: Record<string, number>;
  notices: Record<string, number>;
  leaseRejected: number;
  fragmentsDeleted: number;
  joins: number;
  maxLog: number;
}

export function newStats(): Stats {
  return { runs: 0, entries: 0, outcomes: {}, notices: {}, leaseRejected: 0, fragmentsDeleted: 0, joins: 0, maxLog: 0 };
}

let lastLogValue: LogEntry[] | null = null;
/** Log of the most recent runCase() (for cross-engine replay). */
export function lastLog(): LogEntry[] | null {
  return lastLogValue;
}

export function runCase(actions: Action[], stats: Stats): void {
  let now = 0;
  const server = new Sequencer({ now: () => now, leaseMs: LEASE_MS });
  let opCounter = 0;
  const devs: Dev[] = [];
  const mkDev = (i: number, snap?: IndexSnapshot): Dev => {
    const info = { id: `dev-${i}`, name: `urządzenie ${i}` };
    // Devices in different zones (Q6): CEST, US east, India, UTC.
    const tz = [120, -300, 330, 0][i % 4]!;
    const opts = {
      device: info,
      now: () => 1_700_000_000_000 + now,
      newOpId: () => `op-${i}-${pad(++opCounter)}`,
      tzOffsetMin: () => tz,
    };
    const r = snap ? Replica.fromSnapshot(snap, opts) : new Replica(opts);
    return { info, r, nodeN: 0, upN: 0, myUploads: [] };
  };
  for (let i = 0; i < 3; i++) devs.push(mkDev(i));
  const deleted = new Set<UploadId>();

  const nodesOf = (d: Dev) => [...d.r.store.allNodes()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const userNodes = (d: Dev) => nodesOf(d).filter((n) => n.parentId !== null);
  const folders = (d: Dev) => nodesOf(d).filter((n) => n.kind === "folder" && n.id !== RECOVERED_ID);
  const files = (d: Dev) => nodesOf(d).filter((n) => n.kind === "file");
  const newNodeId = (d: Dev) => `n${d.info.id.slice(4)}-${pad(++d.nodeN)}`;

  /** Target node: mostly known, sometimes an unknown (purged/never existed) ID. */
  const pickNode = (d: Dev, list: NodeRecord[], n: number): string | undefined =>
    n % 17 === 0 ? `ghost-${pad(n % 50)}` : pick(list, n)?.id;

  const metaOp = (d: Dev, a: Action, kind: number): SingleOp | undefined => {
    switch (kind % 4) {
      case 0: {
        const parent = pickNode(d, folders(d), a.x) ?? ROOT_ID;
        return { type: "create", kind: "folder", nodeId: newNodeId(d), parentId: parent, name: pick(NAMES, a.y)! };
      }
      case 1: {
        const id = pickNode(d, userNodes(d), a.x);
        return id ? { type: "rename", nodeId: id, name: pick(NAMES, a.y)! } : undefined;
      }
      case 2: {
        const id = pickNode(d, userNodes(d), a.x);
        const target = pickNode(d, folders(d), a.y) ?? ROOT_ID;
        return id ? { type: "move", nodeId: id, parentId: target } : undefined;
      }
      default: {
        const id = pickNode(d, userNodes(d), a.x);
        return id ? { type: "trash", nodeId: id } : undefined;
      }
    }
  };

  const push = (d: Dev, count: number) => {
    for (let i = 0; i < count && d.r.unsent > 0; i++) {
      const env = d.r.nextToSend()!;
      // A live client keeps renewing the leases of uploads it still works on.
      for (const u of env.leaseGuard ?? []) server.renewLease(u, d.info.id);
      const res = d.r.pushOne(server)!;
      if (res.status === "lease_rejected") {
        stats.leaseRejected++;
        d.r.drop(env.opId);
        d.myUploads = d.myUploads.filter((u) => !(env.leaseGuard ?? []).includes(u));
      } else if (res.status === "rules_version_rejected") {
        throw new Error("unexpected rules_version_rejected");
      }
    }
  };

  const gc = (d: Dev) => {
    for (const u of deletableUploads(d.r.store, now, FRAGMENT_RETENTION_TEST_MS)) {
      if (!deleted.has(u)) {
        deleted.add(u);
        stats.fragmentsDeleted++;
      }
    }
  };

  /** Commit an open upload of this device as a new file or a new version of a known file. */
  const finish = (d: Dev, u: UploadId, a: Action) => {
    // Plaintext hash from a tiny pool, so identical content (Q7) happens often; sometimes absent.
    const hash = a.x % 4 === 0 ? undefined : String(a.x % 3).repeat(64);
    const content = {
      versionId: `v-${u}`,
      uploadId: u,
      sizeBytes: a.y % 5000,
      manifestRef: `mf-${u}`,
      chunkCount: 1 + (a.y % 3),
      ...(hash !== undefined ? { plaintextSha256: hash } : {}),
    };
    const fl = files(d);
    let op: SingleOp;
    if (fl.length > 0 && a.z % 3 !== 0) {
      const f = pickNode(d, fl, a.y)!;
      const local = d.r.store.getNode(f);
      op = {
        type: "new_content_version",
        nodeId: f,
        baseVersionId: a.z % 11 === 0 ? null : (local?.content?.versionId ?? null),
        content,
        nameHint: local?.name ?? pick(NAMES, a.y)!,
      };
    } else {
      const parent = pickNode(d, folders(d), a.y) ?? ROOT_ID;
      op = { type: "create", kind: "file", nodeId: newNodeId(d), parentId: parent, name: pick(NAMES, a.z)!, content };
    }
    d.r.enqueue({ type: "group", ops: [{ type: "upload_commit", uploadId: u }, op] });
  };

  const beginUpload = (d: Dev): UploadId => {
    const u = `up-${d.info.id.slice(4)}-${pad(++d.upN)}`;
    server.renewLease(u, d.info.id);
    d.r.enqueue({ type: "upload_begin", uploadId: u });
    d.myUploads.push(u);
    return u;
  };

  let joined = false;
  for (const a of actions) {
    const d = devs[a.who % devs.length]!;
    switch (KIND_TABLE[a.what]) {
      case "mkdir": {
        const op = metaOp(d, a, 0);
        if (op) d.r.enqueue(op);
        break;
      }
      case "upload_begin":
        beginUpload(d);
        break;
      case "upload_finish": {
        // Finish an upload whose begin this device has seen in the log.
        const open = d.myUploads.filter((u) => d.r.store.getUpload(u)?.status === "open");
        const u = pick(open, a.x);
        if (!u) break;
        d.myUploads = d.myUploads.filter((x) => x !== u);
        if (a.z % 7 === 0) break; // abandon: never committed, lease will expire
        finish(d, u, a);
        break;
      }
      case "upload_fast": {
        // Whole upload in one step for an online device: begin, wait for the
        // log, commit + bind. The bind is queued behind other outbox ops, so
        // it still races with other devices.
        const u = beginUpload(d);
        push(d, d.r.unsent);
        d.r.receive(server.read(d.r.headSeq));
        if (d.r.store.getUpload(u)?.status !== "open") break;
        d.myUploads = d.myUploads.filter((x) => x !== u);
        finish(d, u, a);
        break;
      }
      case "rename": {
        const op = metaOp(d, a, 1);
        if (op) d.r.enqueue(op);
        break;
      }
      case "move": {
        const op = metaOp(d, a, 2);
        if (op) d.r.enqueue(op);
        break;
      }
      case "trash": {
        const op = metaOp(d, a, 3);
        if (op) d.r.enqueue(op);
        break;
      }
      case "restore": {
        const trashed = userNodes(d).filter((n) => n.trashed);
        const id = pickNode(d, trashed, a.x);
        if (id) d.r.enqueue({ type: "restore", nodeId: id });
        break;
      }
      case "purge": {
        const trashed = userNodes(d).filter((n) => n.trashed);
        const id = a.y % 5 === 0 ? pickNode(d, userNodes(d), a.x) : pickNode(d, trashed, a.x);
        if (id) d.r.enqueue({ type: "purge", nodeId: id });
        break;
      }
      case "group": {
        // Group op: 2-4 metadata ops (Q9: skipped members are left out,
        // an invalid member rolls back everything). Sometimes one member is
        // invalid on purpose.
        const ops: SingleOp[] = [];
        const k = 2 + (a.z % 3);
        for (let i = 0; i < k; i++) {
          const sub = metaOp(d, { ...a, x: a.x + i * 7919, y: a.y + i * 104729 }, (a.z >> i) & 3);
          if (sub) ops.push(sub);
        }
        if (ops.length > 0 && a.y % 9 === 0) {
          ops.splice(a.x % (ops.length + 1), 0, { type: "rename", nodeId: ops[0]!.type === "create" ? ops[0]!.nodeId : "zzzzzzzz", name: "a/b" });
        }
        if (ops.length > 0) d.r.enqueue({ type: "group", ops } as Operation);
        break;
      }
      case "push":
        push(d, 1 + (a.x % 4));
        break;
      case "pull": {
        // Pull everything or only a part of the tail.
        const limit = a.x % 3 === 0 ? 1 + (a.y % 5) : Number.POSITIVE_INFINITY;
        d.r.receive(server.read(d.r.headSeq, limit));
        break;
      }
      case "time":
        now += a.x % 4 === 0 ? LEASE_MS * 2 : a.x % 300;
        break;
      case "cleaner": {
        // Take over expired leases and abort uploads still open in the log.
        for (const l of server.expiredLeases()) {
          if (!server.renewLease(l.uploadId, d.info.id)) continue;
          d.r.receive(server.read(d.r.headSeq));
          const st = d.r.store.getUpload(l.uploadId)?.status;
          if (st === "open" || st === "committed") d.r.enqueue({ type: "upload_abort", uploadId: l.uploadId });
        }
        push(d, d.r.unsent);
        d.r.receive(server.read(d.r.headSeq));
        gc(d);
        break;
      }
      case "invalid": {
        // Invalid ops from a buggy client.
        const bad: SingleOp[] = [
          { type: "rename", nodeId: ROOT_ID, name: "x" },
          { type: "rename", nodeId: pick(userNodes(d), a.x)?.id ?? "zzzzzzzz", name: "" },
          { type: "rename", nodeId: pick(userNodes(d), a.x)?.id ?? "zzzzzzzz", name: "a/b" },
          { type: "move", nodeId: RECOVERED_ID, parentId: ROOT_ID },
          { type: "create", kind: "folder", nodeId: "short", parentId: ROOT_ID, name: "x" },
          { type: "create", kind: "folder", nodeId: newNodeId(d), parentId: pick(files(d), a.x)?.id ?? ROOT_ID, name: "in-file" },
          { type: "upload_commit", uploadId: `up-9-${pad(a.y % 100)}` },
        ];
        d.r.enqueue(pick(bad, a.y)!);
        break;
      }
      case "gc":
        gc(d);
        break;
      case "join": {
        // A new device joins from another device's snapshot (serialized).
        if (joined || devs.length >= 4) break;
        joined = true;
        stats.joins++;
        const snap = JSON.parse(JSON.stringify(d.r.snapshot())) as IndexSnapshot;
        devs.push(mkDev(devs.length, snap));
        break;
      }
    }
  }

  // Settle: every device sends its outbox and catches up.
  for (let round = 0; round < 50; round++) {
    let pending = 0;
    for (const d of devs) {
      d.r.receive(server.read(d.r.headSeq));
      push(d, d.r.unsent);
      d.r.receive(server.read(d.r.headSeq));
      pending += d.r.outbox.length;
    }
    if (pending === 0) break;
  }
  for (const d of devs) d.r.receive(server.read(d.r.headSeq));
  for (const d of devs) {
    gc(d);
    expect(d.r.outbox).toEqual([]);
  }

  const log = server.read(0);
  lastLogValue = log;
  stats.runs++;
  stats.entries += log.length;
  stats.maxLog = Math.max(stats.maxLog, log.length);

  // I1 + I2 + I3: replay the full log, checking every prefix.
  // Also: an entry that was not applied (skipped/rejected) must not change
  // the state at all (all-or-nothing, §4), only headSeq.
  const full = initIndex(new MemoryIndexStore());
  const results: ApplyResult[] = [];
  for (const e of log) {
    const before = canonicalTree(full);
    const r = applyEntry(full, e);
    results.push(r);
    if ((r.outcome === "skipped" || r.outcome === "rejected" || r.outcome === "noop") && canonicalTree(full) !== before) {
      throw new Error(`entry ${e.seq} (${r.outcome}) changed the state`);
    }
    const v = checkInvariants(full);
    if (v.length > 0) throw new Error(`invariants broken after seq ${e.seq}: ${JSON.stringify(v)}`);
  }
  for (const r of results) {
    stats.outcomes[r.outcome] = (stats.outcomes[r.outcome] ?? 0) + 1;
    for (const n of r.notices) stats.notices[n.code] = (stats.notices[n.code] ?? 0) + 1;
  }
  const want = canonicalState(full);

  for (const d of devs) expect(canonicalState(d.r.store)).toBe(want);

  // Same state AND same notices (every replica shows the user the same thing),
  // whatever the store's iteration order.
  const rev = initIndex(new ReversedStore());
  const revResults = log.map((e) => applyEntry(rev, e));
  expect(canonicalState(rev)).toBe(want);
  expect(JSON.stringify(revResults)).toBe(JSON.stringify(results));

  // I6: snapshot at a random cut (derived from the actions) + tail.
  const cut = log.length === 0 ? 0 : (actions.length * 7 + (actions[0]?.x ?? 0)) % (log.length + 1);
  const head = initIndex(new MemoryIndexStore());
  for (const e of log.slice(0, cut)) applyEntry(head, e);
  const snap = JSON.parse(JSON.stringify(takeSnapshot(head))) as IndexSnapshot;
  const restored = loadSnapshot(snap);
  for (const e of log.slice(cut)) applyEntry(restored, e as LogEntry);
  expect(canonicalState(restored)).toBe(want);

  // I4 + I5.
  expect(checkNoSilentLoss(log, full)).toEqual([]);
  expect(checkTrashSawContent(log, full, results)).toEqual([]);
  expect(checkNoDeletedFragments(full, deleted)).toEqual([]);
}

