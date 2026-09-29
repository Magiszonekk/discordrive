// Client replica (koncept §5.1, rule 10).
//
// A replica only ever applies the server log in server order. Its own
// operations wait in an outbox until the server assigns them a seq; the UI
// may show them optimistically, but the index state is always "log up to
// headSeq". That keeps every replica identical by construction (§5.2.2) and
// makes long offline periods trivial: fetch the tail, then send the outbox
// (rule 10), with no time limit.

import { applyEntry, initIndex, type ApplyResult } from "./apply.js";
import type { Sequencer, SubmitResult } from "./sequencer.js";
import { loadSnapshot, takeSnapshot, type IndexSnapshot } from "./snapshot.js";
import { MemoryIndexStore, type IndexStore } from "./store.js";
import { RULES_VERSION, type DeviceInfo, type LogEntry, type OpEnvelope, type Operation } from "./types.js";

export interface ReplicaOptions {
  device: DeviceInfo;
  store?: IndexStore;
  /** Device clock (display only). */
  now?: () => number;
  /** Op ID generator (random in production). */
  newOpId: () => string;
  rulesVersion?: number;
}

export class Replica {
  readonly device: DeviceInfo;
  readonly store: IndexStore;
  readonly outbox: OpEnvelope[] = [];
  readonly results: ApplyResult[] = [];
  private readonly now: () => number;
  private readonly newOpId: () => string;
  readonly rulesVersion: number;

  constructor(opts: ReplicaOptions) {
    this.device = opts.device;
    this.store = initIndex(opts.store ?? new MemoryIndexStore());
    this.now = opts.now ?? (() => Date.now());
    this.newOpId = opts.newOpId;
    this.rulesVersion = opts.rulesVersion ?? RULES_VERSION;
  }

  static fromSnapshot(snap: IndexSnapshot, opts: ReplicaOptions): Replica {
    const store = loadSnapshot(snap, opts.store ?? new MemoryIndexStore());
    return new Replica({ ...opts, store });
  }

  get headSeq(): number {
    return this.store.getMeta().headSeq;
  }

  /** Queue a local operation. baseSeq = what this device has applied right now. */
  enqueue(op: Operation): OpEnvelope {
    const env: OpEnvelope = {
      opId: this.newOpId(),
      rulesVersion: this.rulesVersion,
      baseSeq: this.headSeq,
      device: { ...this.device },
      createdAt: this.now(),
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
    }
    return out;
  }

  /** Pull everything new from the server. */
  pull(server: Sequencer): ApplyResult[] {
    return this.receive(server.read(this.headSeq));
  }

  /**
   * Send the oldest queued op. The op keeps its original baseSeq (what the
   * author saw when it was made), which is exactly what rules 1 and 4 need.
   */
  pushOne(server: Sequencer): SubmitResult | null {
    const env = this.outbox[0];
    if (!env) return null;
    const r = server.submit(env);
    if (r.status === "rules_version_rejected") return r;
    // accepted or duplicate: the entry will arrive through pull() and leave the outbox there.
    return r;
  }

  /** Rule 10: after being offline, first catch up, then send own ops at the end. */
  sync(server: Sequencer): void {
    this.pull(server);
    while (this.outbox.length > 0) {
      const r = this.pushOne(server);
      if (!r || r.status === "rules_version_rejected") break;
      this.pull(server);
    }
  }

  snapshot(): IndexSnapshot {
    return takeSnapshot(this.store);
  }
}
