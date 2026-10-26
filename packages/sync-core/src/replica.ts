// Client replica (rule 10).
//
// A replica only ever applies the server log in server order. Its own
// operations wait in an outbox until the server assigns them a seq; the UI
// may show them optimistically, but the index state is always "log up to
// headSeq". That keeps every replica identical by construction and
// makes long offline periods trivial: fetch the tail, then send the outbox
// (rule 10), with no time limit.

import { applyEntry, initIndex, uploadsTouched, type ApplyResult, rulesVersionFor } from "./apply.js";
import type { Sequencer, SubmitResult } from "./sequencer.js";
import { loadSnapshot, takeSnapshot, type IndexSnapshot } from "./snapshot.js";
import { MemoryIndexStore, type IndexStore } from "./store.js";
import { WRITE_RULES_VERSION, type DeviceInfo, type LogEntry, type OpEnvelope, type Operation } from "./types.js";

export interface ReplicaOptions {
  device: DeviceInfo;
  store?: IndexStore;
  /** Device clock (display only). */
  now?: () => number;
  /** Op ID generator (random in production). */
  newOpId: () => string;
  /**
   * Rules version of the ops this replica writes. Default: WRITE_RULES_VERSION, and 4 for an op that
   * touches the Gallery (rulesVersionFor).
   */
  rulesVersion?: number;
  /**
   * Device UTC offset in minutes at a given instant (CEST = 120); goes into
   * every envelope for the conflict-copy name (Q6). Default: the JS runtime's
   * local zone.
   */
  tzOffsetMin?: (atMs: number) => number;
}

function localTzOffsetMin(atMs: number): number {
  const off = -new Date(atMs).getTimezoneOffset();
  return Number.isInteger(off) && off >= -1080 && off <= 1080 ? off : 0;
}

export class Replica {
  readonly device: DeviceInfo;
  readonly store: IndexStore;
  readonly outbox: OpEnvelope[] = [];
  /** opIds the server has accepted (or reported as duplicate) but whose entry has not been pulled yet. */
  private readonly acked = new Set<string>();
  readonly results: ApplyResult[] = [];
  private readonly now: () => number;
  private readonly newOpId: () => string;
  private readonly tzOffsetMin: (atMs: number) => number;
  readonly rulesVersion: number;
  private readonly fixedVersion: boolean;

  constructor(opts: ReplicaOptions) {
    this.device = opts.device;
    this.store = initIndex(opts.store ?? new MemoryIndexStore());
    this.now = opts.now ?? (() => Date.now());
    this.newOpId = opts.newOpId;
    this.rulesVersion = opts.rulesVersion ?? WRITE_RULES_VERSION;
    this.fixedVersion = opts.rulesVersion !== undefined;
    this.tzOffsetMin = opts.tzOffsetMin ?? localTzOffsetMin;
  }

  static fromSnapshot(snap: IndexSnapshot, opts: ReplicaOptions): Replica {
    const store = loadSnapshot(snap, opts.store ?? new MemoryIndexStore());
    return new Replica({ ...opts, store });
  }

  get headSeq(): number {
    return this.store.getMeta().headSeq;
  }

  /** Queue a local operation. baseSeq = what this device has applied right now. */
  enqueue(op: Operation, leaseGuard: string[] = uploadsTouched(op)): OpEnvelope {
    const createdAt = this.now();
    const env: OpEnvelope = {
      opId: this.newOpId(),
      rulesVersion: this.fixedVersion ? this.rulesVersion : rulesVersionFor(this.store, op, this.rulesVersion),
      baseSeq: this.headSeq,
      device: { ...this.device },
      createdAt,
      tzOffsetMin: this.tzOffsetMin(createdAt),
      ...(leaseGuard.length > 0 ? { leaseGuard: [...leaseGuard] } : {}),
      op,
    };
    this.outbox.push(env);
    return env;
  }

  /** Apply server entries (must be contiguous from headSeq + 1; older ones are ignored). */
  receive(entries: Iterable<LogEntry>): ApplyResult[] {
    const out: ApplyResult[] = [];
    for (const e of entries) {
      if (e.seq <= this.headSeq) continue;
      const r = applyEntry(this.store, e);
      out.push(r);
      this.results.push(r);
      const i = this.outbox.findIndex((o) => o.opId === e.opId);
      if (i >= 0) this.outbox.splice(i, 1);
      this.acked.delete(e.opId);
    }
    return out;
  }

  /** Pull everything new from the server. */
  pull(server: Sequencer): ApplyResult[] {
    return this.receive(server.read(this.headSeq));
  }

  /**
   * Send the oldest op that the server has not acknowledged yet. The op keeps
   * its original baseSeq (what the author saw when it was made), which is
   * exactly what rules 1 and 4 need. Acknowledged ops stay in the outbox
   * until their entry arrives through pull() (so the UI can still show them
   * as pending), but are not re-sent. A refused op (rules version, lease)
   * stays at the head; the caller decides (update the client / drop the op
   * and start the upload over).
   */
  pushOne(server: Sequencer): SubmitResult | null {
    const env = this.nextToSend();
    if (!env) return null;
    const r = server.submit(env);
    if (r.status === "accepted" || r.status === "duplicate") this.acked.add(env.opId);
    return r;
  }

  /**
   * pushOne() for a remote arbiter (HTTP in metadata-only mode). Same
   * semantics; concurrent calls may send the same op twice, which the server
   * answers with "duplicate" (rule 9).
   */
  async pushOneAsync(server: { submit(env: OpEnvelope): Promise<SubmitResult> }): Promise<SubmitResult | null> {
    const env = this.nextToSend();
    if (!env) return null;
    const r = await server.submit(env);
    if (r.status === "accepted" || r.status === "duplicate") this.acked.add(env.opId);
    return r;
  }

  /** The envelope pushOne() would send next (oldest not yet acknowledged). */
  nextToSend(): OpEnvelope | undefined {
    return this.outbox.find((o) => !this.acked.has(o.opId));
  }

  /** Ops not yet acknowledged by the server. */
  get unsent(): number {
    return this.outbox.filter((o) => !this.acked.has(o.opId)).length;
  }

  /** Drop a queued op (e.g. after lease_rejected). */
  drop(opId: string): void {
    const i = this.outbox.findIndex((o) => o.opId === opId);
    if (i >= 0) this.outbox.splice(i, 1);
    this.acked.delete(opId);
  }

  /** Rule 10: after being offline, first catch up, then send own ops at the end. */
  sync(server: Sequencer): SubmitResult | null {
    this.pull(server);
    while (this.unsent > 0) {
      const r = this.pushOne(server);
      if (!r || (r.status !== "accepted" && r.status !== "duplicate")) return r;
      this.pull(server);
    }
    return null;
  }

  snapshot(): IndexSnapshot {
    return takeSnapshot(this.store);
  }
}
