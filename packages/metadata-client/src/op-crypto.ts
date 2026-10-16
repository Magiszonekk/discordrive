// Encrypted operation log (DECISIONS Q6/Q8).
//
// What the server (arbiter) gets per operation:
//   opId, rulesVersion, baseSeq, leaseGuard  - plaintext, it needs them
//                                              (dedup, min client version,
//                                              leases; baseSeq is plaintext by the same contract)
//   payload                                  - AES-256-GCM, account subkey "op":
//                                              device, createdAt, tzOffsetMin, op
// The AAD binds the payload to the account and to every plaintext field, so
// the server cannot move a payload to another envelope or alter opId/baseSeq/
// leaseGuard without the clients noticing. It still assigns seq and
// serverTime (its role as arbiter) and could withhold or reorder
// entries; that costs availability, not confidentiality.
//
// An entry that does not decrypt is turned into the same invalid operation on
// every replica (all replicas share the key, so they fail identically), which
// apply() consumes as a deterministic no-op with `invalid_op` (Q10).

import { fromBase64, toBase64 } from "@ddv4/processing";
import {
  Sequencer,
  type DeviceInfo,
  type LogEntry,
  type OpEnvelope,
  type Operation,
  type Sequenced,
  type SubmitResult,
  type UploadId,
} from "@ddv4/sync-core";
import { sealJson, unsealJson, type AccountKey } from "./account-key.js";
import type { ArbiterApi } from "./arbiter.js";

/** The only thing the server stores per operation. JSON-safe. */
export interface EncryptedEnvelope {
  opId: string;
  rulesVersion: number;
  baseSeq: number;
  leaseGuard?: UploadId[];
  /** base64(version || iv || ciphertext+tag). */
  payload: string;
}
export type EncryptedEntry = Sequenced<EncryptedEnvelope>;

interface OpPayload {
  device: DeviceInfo;
  createdAt: number;
  tzOffsetMin?: number;
  op: Operation;
}

/** Device/op placed into entries that do not decrypt (deterministic invalid_op). */
export const UNDECRYPTABLE_DEVICE: DeviceInfo = { id: "undecryptable", name: "?" };

function aad(accountId: string, e: Pick<EncryptedEnvelope, "opId" | "rulesVersion" | "baseSeq" | "leaseGuard">): string {
  return ["ddn-op-v1", accountId, e.opId, e.rulesVersion, e.baseSeq, (e.leaseGuard ?? []).join(",")].join("|");
}

export class OpCodec {
  constructor(
    private readonly key: AccountKey,
    readonly accountId: string,
  ) {}

  async encrypt(env: OpEnvelope): Promise<EncryptedEnvelope> {
    const head = {
      opId: env.opId,
      rulesVersion: env.rulesVersion,
      baseSeq: env.baseSeq,
      ...(env.leaseGuard ? { leaseGuard: [...env.leaseGuard] } : {}),
    };
    const payload: OpPayload = {
      device: env.device,
      createdAt: env.createdAt,
      ...(env.tzOffsetMin !== undefined ? { tzOffsetMin: env.tzOffsetMin } : {}),
      op: env.op,
    };
    const sealed = await sealJson(await this.key.subkey("op"), payload, aad(this.accountId, head));
    return { ...head, payload: toBase64(sealed) };
  }

  async decrypt(e: EncryptedEntry): Promise<LogEntry> {
    const head = { opId: e.opId, rulesVersion: e.rulesVersion, baseSeq: e.baseSeq, seq: e.seq, serverTime: e.serverTime };
    const lg = e.leaseGuard !== undefined ? { leaseGuard: e.leaseGuard } : {};
    try {
      const p = await unsealJson<OpPayload>(await this.key.subkey("op"), fromBase64(e.payload), aad(this.accountId, e), "operation");
      if (!p || typeof p !== "object") throw new Error("bad payload");
      return {
        ...head,
        ...lg,
        device: p.device,
        createdAt: p.createdAt,
        ...(p.tzOffsetMin !== undefined ? { tzOffsetMin: p.tzOffsetMin } : {}),
        op: p.op,
      };
    } catch {
      return { ...head, ...lg, device: UNDECRYPTABLE_DEVICE, createdAt: 0, op: { type: "undecryptable" } as unknown as Operation };
    }
  }
}

/** The server API as a client sees it; the session decides the device for lease checks. */
export interface EncryptedLogApi {
  submit(env: EncryptedEnvelope): Promise<SubmitResult<EncryptedEnvelope>>;
  read(afterSeq: number, limit?: number): Promise<EncryptedEntry[]>;
  renewLease(uploadId: UploadId): Promise<boolean>;
  releaseLease(uploadId: UploadId): Promise<void>;
}

/**
 * In-process server: one encrypted log per account, sessions bound to a
 * device. Reference for the HTTP server (plan step 6) and the test double.
 */
export class InProcessLogServer {
  readonly log: Sequencer<EncryptedEnvelope>;
  constructor(opts: { now?: () => number; leaseMs?: number; initialLog?: EncryptedEntry[]; onAppend?: (e: EncryptedEntry) => void } = {}) {
    this.log = new Sequencer<EncryptedEnvelope>({ now: opts.now, leaseMs: opts.leaseMs, initialLog: opts.initialLog });
    this.onAppend = opts.onAppend;
  }
  private readonly onAppend?: (e: EncryptedEntry) => void;

  session(deviceId: string): EncryptedLogApi {
    return {
      submit: async (env) => {
        const r = this.log.submit(env, deviceId);
        if (r.status === "accepted") this.onAppend?.(r.entry);
        return r;
      },
      read: async (after, limit) => this.log.read(after, limit),
      renewLease: async (u) => this.log.renewLease(u, deviceId),
      releaseLease: async (u) => this.log.releaseLease(u, deviceId),
    };
  }
}

/**
 * ArbiterApi (what MetadataClient talks to) on top of an encrypted log:
 * encrypts on submit, decrypts on read. Lease calls ignore the deviceId
 * argument: the session is the device.
 */
export class EncryptedArbiter implements ArbiterApi {
  constructor(
    private readonly codec: OpCodec,
    private readonly api: EncryptedLogApi,
  ) {}

  async submit(env: OpEnvelope): Promise<SubmitResult> {
    const r = await this.api.submit(await this.codec.encrypt(env));
    if (r.status === "accepted" || r.status === "duplicate") return { status: r.status, entry: await this.codec.decrypt(r.entry) };
    return r;
  }
  async read(afterSeq: number, limit?: number): Promise<LogEntry[]> {
    const entries = await this.api.read(afterSeq, limit);
    return Promise.all(entries.map((e) => this.codec.decrypt(e)));
  }
  async renewLease(uploadId: UploadId): Promise<boolean> {
    return this.api.renewLease(uploadId);
  }
  async releaseLease(uploadId: UploadId): Promise<void> {
    return this.api.releaseLease(uploadId);
  }
}
