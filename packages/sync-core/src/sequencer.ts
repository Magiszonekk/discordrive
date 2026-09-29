// Server-side arbiter model (koncept §3.4 role 3, §5.1, §5.4, rule 8, rule 9).
//
// The real server stores the log in Postgres and sees only the plaintext
// envelope fields (opId, rulesVersion, baseSeq, sizes); the op payload is
// encrypted in metadata-only mode. This class is the reference behaviour the
// server must implement, and the in-memory server used by tests.

import { RULES_VERSION } from "./types.js";
import type { LogEntry, OpEnvelope, UploadId } from "./types.js";

export type SubmitResult =
  | { status: "accepted"; entry: LogEntry }
  /** Rule 9: known opId. Returns the original entry so a retrying client can confirm it. */
  | { status: "duplicate"; entry: LogEntry }
  /** §5.4: client rules too old (or unknown to this server). Client must update before writing. */
  | { status: "rules_version_rejected"; minRulesVersion: number; maxRulesVersion: number };

export interface SequencerOptions {
  /** Oldest rules version the server accepts for NEW operations. */
  minRulesVersion?: number;
  /** Newest rules version the server knows about. */
  maxRulesVersion?: number;
  /** Server clock (ms). Used for serverTime and leases only, never for ordering. */
  now?: () => number;
  /** Lease duration for uploads (rule 8), ms. */
  leaseMs?: number;
}

export interface Lease {
  uploadId: UploadId;
  deviceId: string;
  expiresAt: number;
}

export class Sequencer {
  private readonly log: LogEntry[] = [];
  private readonly byOpId = new Map<string, LogEntry>();
  private readonly leases = new Map<UploadId, Lease>();
  minRulesVersion: number;
  maxRulesVersion: number;
  private readonly now: () => number;
  readonly leaseMs: number;

  constructor(opts: SequencerOptions = {}) {
    this.minRulesVersion = opts.minRulesVersion ?? RULES_VERSION;
    this.maxRulesVersion = opts.maxRulesVersion ?? RULES_VERSION;
    this.now = opts.now ?? (() => Date.now());
    this.leaseMs = opts.leaseMs ?? 10 * 60_000;
  }

  get headSeq(): number {
    return this.log.length;
  }

  submit(env: OpEnvelope): SubmitResult {
    const dup = this.byOpId.get(env.opId);
    if (dup) return { status: "duplicate", entry: dup };
    if (env.rulesVersion < this.minRulesVersion || env.rulesVersion > this.maxRulesVersion) {
      return {
        status: "rules_version_rejected",
        minRulesVersion: this.minRulesVersion,
        maxRulesVersion: this.maxRulesVersion,
      };
    }
    const entry: LogEntry = { ...structuredCloneSafe(env), seq: this.log.length + 1, serverTime: this.now() };
    this.log.push(entry);
    this.byOpId.set(entry.opId, entry);
    return { status: "accepted", entry };
  }

  /** Entries with seq > afterSeq, in order. */
  read(afterSeq: number, limit = Number.POSITIVE_INFINITY): LogEntry[] {
    return this.log.slice(Math.max(0, afterSeq), Math.max(0, afterSeq) + limit);
  }

  // --- Upload leases (outside the log, plaintext on the server; §3.3, rule 8)

  /** Start or renew. Returns false if another device holds an unexpired lease. */
  renewLease(uploadId: UploadId, deviceId: string): boolean {
    const now = this.now();
    const cur = this.leases.get(uploadId);
    if (cur && cur.deviceId !== deviceId && cur.expiresAt > now) return false;
    this.leases.set(uploadId, { uploadId, deviceId, expiresAt: now + this.leaseMs });
    return true;
  }

  releaseLease(uploadId: UploadId): void {
    this.leases.delete(uploadId);
  }

  /** Expired leases: candidates for cleanup (delete fragments, then upload_abort). */
  expiredLeases(): Lease[] {
    const now = this.now();
    return [...this.leases.values()].filter((l) => l.expiresAt <= now).sort((a, b) => (a.uploadId < b.uploadId ? -1 : 1));
  }

  /**
   * Cleanup may only start after the lease expired (rule 8). A cleaning device
   * takes the lease over, so the original uploader's renew fails from now on.
   */
  claimExpiredLease(uploadId: UploadId, deviceId: string): boolean {
    const now = this.now();
    const cur = this.leases.get(uploadId);
    if (!cur || cur.expiresAt > now) return false;
    this.leases.set(uploadId, { uploadId, deviceId, expiresAt: now + this.leaseMs });
    return true;
  }
}

function structuredCloneSafe<T>(v: T): T {
  // Log entries are plain JSON; a JSON round-trip also drops anything a
  // client could smuggle that would not survive the real wire format.
  return JSON.parse(JSON.stringify(v)) as T;
}
