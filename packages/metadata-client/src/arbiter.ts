// Arbiter (server) as seen by a client. Async so an HTTP implementation can
// replace the in-process one without touching the client. Mirrors
// @ddv4/sync-core Sequencer (role 3; rule 8 leases).

import { Sequencer, type LogEntry, type OpEnvelope, type SubmitResult, type UploadId } from "@ddv4/sync-core";

export interface ArbiterApi {
  submit(env: OpEnvelope): Promise<SubmitResult>;
  read(afterSeq: number, limit?: number): Promise<LogEntry[]>;
  renewLease(uploadId: UploadId, deviceId: string): Promise<boolean>;
  releaseLease(uploadId: UploadId, deviceId: string): Promise<void>;
}

/** In-process arbiter (tests, single-device CLI before the server exists). */
export class LocalArbiter implements ArbiterApi {
  constructor(
    readonly seq: Sequencer = new Sequencer(),
    /** Called after every accepted entry (persistence hook for the CLI). */
    private readonly onAppend?: (e: LogEntry) => void,
  ) {}
  async submit(env: OpEnvelope): Promise<SubmitResult> {
    const r = this.seq.submit(env);
    if (r.status === "accepted") this.onAppend?.(r.entry);
    return r;
  }
  async read(afterSeq: number, limit?: number): Promise<LogEntry[]> {
    return this.seq.read(afterSeq, limit);
  }
  async renewLease(uploadId: UploadId, deviceId: string): Promise<boolean> {
    return this.seq.renewLease(uploadId, deviceId);
  }
  async releaseLease(uploadId: UploadId, deviceId: string): Promise<void> {
    this.seq.releaseLease(uploadId, deviceId);
  }
}
