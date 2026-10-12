// Operations in clear for the server: the plain mode (docs/stage3-modes.md §7).
//
// Same envelope as the encrypted log (opId, rulesVersion, baseSeq, leaseGuard + payload), so
// the server, the Sequencer, snapshots and every client path are unchanged; only the payload
// is plain JSON (base64) instead of AES-GCM under the account key. The server decodes it and
// applies the log to its own replica of each account's index (names, tree, file keys), which
// gives thumbnails, previews, server-side Range streaming and search. The fragments on Discord
// stay encrypted with the per-file key (at rest, like ddrive), which the server now knows.
// Marker for the build-time mode check: ddn-plain-op-codec (never in another mode's bundle).

import { fromBase64, toBase64 } from "@ddv4/processing";
import type { LogEntry, OpEnvelope, Operation, SubmitResult, UploadId } from "@ddv4/sync-core";
import type { ArbiterApi } from "./arbiter.js";
import { UNDECRYPTABLE_DEVICE, type EncryptedEntry, type EncryptedEnvelope, type EncryptedLogApi } from "./op-crypto.js";

export const PLAIN_OP_CODEC_MARKER = "ddn-plain-op-codec";
const PREFIX = "plain1:";
const enc = new TextEncoder();
const dec = new TextDecoder();

interface PlainPayload {
  /** Binds the payload to its envelope, like the AAD of the encrypted codec. */
  bind: string;
  device: OpEnvelope["device"];
  createdAt: number;
  tzOffsetMin?: number;
  op: Operation;
}

function bindOf(accountId: string, e: Pick<EncryptedEnvelope, "opId" | "rulesVersion" | "baseSeq" | "leaseGuard">): string {
  return [PREFIX, accountId, e.opId, e.rulesVersion, e.baseSeq, (e.leaseGuard ?? []).join(",")].join("|");
}

export class PlainOpCodec {
  readonly marker = PLAIN_OP_CODEC_MARKER;
  constructor(readonly accountId: string) {}

  async encrypt(env: OpEnvelope): Promise<EncryptedEnvelope> {
    const head = { opId: env.opId, rulesVersion: env.rulesVersion, baseSeq: env.baseSeq, ...(env.leaseGuard ? { leaseGuard: [...env.leaseGuard] } : {}) };
    const p: PlainPayload = {
      bind: bindOf(this.accountId, head),
      device: env.device,
      createdAt: env.createdAt,
      ...(env.tzOffsetMin !== undefined ? { tzOffsetMin: env.tzOffsetMin } : {}),
      op: env.op,
    };
    return { ...head, payload: toBase64(enc.encode(JSON.stringify(p))) };
  }

  /** Synchronous decode (the server applies entries inside a transaction). */
  decodeSync(e: EncryptedEntry): LogEntry {
    const head = { opId: e.opId, rulesVersion: e.rulesVersion, baseSeq: e.baseSeq, seq: e.seq, serverTime: e.serverTime };
    const lg = e.leaseGuard !== undefined ? { leaseGuard: e.leaseGuard } : {};
    try {
      const p = JSON.parse(dec.decode(fromBase64(e.payload))) as PlainPayload;
      if (!p || p.bind !== bindOf(this.accountId, e)) throw new Error("payload not bound to this entry");
      return { ...head, ...lg, device: p.device, createdAt: p.createdAt, ...(p.tzOffsetMin !== undefined ? { tzOffsetMin: p.tzOffsetMin } : {}), op: p.op };
    } catch {
      // Same deterministic invalid op on every replica (server and clients), like an undecryptable entry.
      return { ...head, ...lg, device: UNDECRYPTABLE_DEVICE, createdAt: 0, op: { type: "undecryptable" } as unknown as Operation };
    }
  }

  async decrypt(e: EncryptedEntry): Promise<LogEntry> {
    return this.decodeSync(e);
  }
}

/** ArbiterApi over the server log with plain payloads (plain-mode clients). */
export class PlainArbiter implements ArbiterApi {
  constructor(
    private readonly codec: PlainOpCodec,
    private readonly api: EncryptedLogApi,
  ) {}
  async submit(env: OpEnvelope): Promise<SubmitResult> {
    const r = await this.api.submit(await this.codec.encrypt(env));
    if (r.status === "accepted" || r.status === "duplicate") return { status: r.status, entry: this.codec.decodeSync(r.entry) };
    return r;
  }
  async read(afterSeq: number, limit?: number): Promise<LogEntry[]> {
    return (await this.api.read(afterSeq, limit)).map((e) => this.codec.decodeSync(e));
  }
  async renewLease(uploadId: UploadId): Promise<boolean> {
    return this.api.renewLease(uploadId);
  }
  async releaseLease(uploadId: UploadId): Promise<void> {
    return this.api.releaseLease(uploadId);
  }
}
