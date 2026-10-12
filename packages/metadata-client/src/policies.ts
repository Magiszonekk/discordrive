// Client policies from sync-core README „Polityka klienta na etap 2”
// (DECISIONS Q4, Q5, Q10). Q5 own names: MetadataClient.upload normalizes to NFC. Pure decisions + small trackers; the client wires them.

import { expiredTrash, TRASH_RETENTION_MS, DAY_MS, type ApplyResult, type IndexStore, type LogEntry, type NodeId, type Operation } from "@ddv4/sync-core";

// --- Q4: automatic trash cleanup

/** Anyone may clean when nobody has purged for this long (Q4). */
export const ANY_DEVICE_CLEANS_AFTER_MS = 7 * DAY_MS;

export interface TrashCleanupContext {
  /** Main device (desktop / main tab, same role as for snapshots). */
  isPrimary: boolean;
  /** The device has applied the whole server log (no pending tail). */
  fullySynced: boolean;
  /** Metered connection (phone data): never clean. */
  metered: boolean;
  /** Server time now (ms). */
  now: number;
  /** Server time of the newest purge in the log, by any device (null = never). */
  lastPurgeAt: number | null;
  /** Server time of the first log entry (to start the 7-day clock on a fresh account). */
  logStartedAt: number | null;
}

export type TrashCleanupDecision = { clean: false; reason: string } | { clean: true; nodeIds: NodeId[] };

export function decideTrashCleanup(store: IndexStore, ctx: TrashCleanupContext): TrashCleanupDecision {
  if (!ctx.fullySynced) return { clean: false, reason: "not_synced" };
  if (ctx.metered) return { clean: false, reason: "metered" };
  if (!ctx.isPrimary) {
    const since = ctx.lastPurgeAt ?? ctx.logStartedAt;
    if (since === null || ctx.now - since < ANY_DEVICE_CLEANS_AFTER_MS) return { clean: false, reason: "primary_cleans" };
  }
  const nodeIds = expiredTrash(store, ctx.now, TRASH_RETENTION_MS);
  return nodeIds.length ? { clean: true, nodeIds } : { clean: false, reason: "nothing_expired" };
}

/**
 * The cleanup as one group op (Q9: a node restored meanwhile is skipped,
 * the rest is purged; Q3: unseen content stays in the trash).
 */
export function trashCleanupOp(nodeIds: NodeId[]): Operation {
  const ops = nodeIds.map((nodeId) => ({ type: "purge" as const, nodeId }));
  return ops.length === 1 ? ops[0]! : { type: "group", ops };
}

function hasPurge(op: Operation): boolean {
  return op.type === "purge" || (op.type === "group" && Array.isArray(op.ops) && op.ops.some((o) => o?.type === "purge"));
}

// --- Q10: invalid_op counter per device

export const INVALID_OP_WARN_AFTER = 5;

export interface InvalidOpAlert {
  deviceId: string;
  count: number;
  lastSeq: number;
  reasons: string[];
}

/**
 * Tracks what the log tells every device: purge times (Q4) and invalid ops
 * per authoring device (Q10). Feed it every applied entry with its result.
 */
export class LogObserver {
  lastPurgeAt: number | null = null;
  logStartedAt: number | null = null;
  private readonly invalid = new Map<string, InvalidOpAlert>();
  private readonly alerted = new Set<string>();
  /** Q5: names created by other devices that are not NFC (warn only, never reject). */
  readonly nonNfcNames: { seq: number; nodeId: string; deviceId: string }[] = [];

  constructor(readonly warnAfter = INVALID_OP_WARN_AFTER) {}

  observe(e: LogEntry, r: ApplyResult): InvalidOpAlert | null {
    if (this.logStartedAt === null) this.logStartedAt = e.serverTime;
    if (r.outcome === "applied" && e.op && hasPurge(e.op)) this.lastPurgeAt = Math.max(this.lastPurgeAt ?? 0, e.serverTime);
    if (r.outcome === "applied" && e.op) {
      const ops = e.op.type === "group" && Array.isArray(e.op.ops) ? e.op.ops : [e.op];
      for (const o of ops) {
        if (!o || (o.type !== "create" && o.type !== "rename")) continue;
        if (typeof o.name === "string" && o.name !== o.name.normalize("NFC")) this.nonNfcNames.push({ seq: e.seq, nodeId: o.nodeId, deviceId: e.device?.id ?? "?" });
      }
    }
    const bad = r.notices.filter((n) => n.code === "invalid_op");
    if (bad.length === 0) return null;
    const dev = e.device?.id ?? "?";
    const a = this.invalid.get(dev) ?? { deviceId: dev, count: 0, lastSeq: 0, reasons: [] };
    a.count++;
    a.lastSeq = e.seq;
    for (const n of bad) if (n.reason && !a.reasons.includes(n.reason) && a.reasons.length < 10) a.reasons.push(n.reason);
    this.invalid.set(dev, a);
    if (a.count >= this.warnAfter && !this.alerted.has(dev)) {
      this.alerted.add(dev);
      return { ...a, reasons: [...a.reasons] };
    }
    return null;
  }

  invalidCount(deviceId: string): number {
    return this.invalid.get(deviceId)?.count ?? 0;
  }

  /** UI text (Q10). */
  static message(a: InvalidOpAlert): string {
    return `Device ${a.deviceId} sent ${a.count} invalid operations (skipped, nothing was lost). Update the app on that device.`;
  }
}
