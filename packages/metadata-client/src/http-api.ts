// HTTP client for the metadata-only server (fetch; Node + browser).
// Implements the client-side interfaces, so MetadataClient / WebhookVault do
// not know whether the server is in-process or remote.

import { fromBase64, toBase64 } from "@ddv4/processing";
import type { SubmitResult } from "@ddv4/sync-core";
import type { EncryptedEntry, EncryptedEnvelope, EncryptedLogApi } from "./op-crypto.js";
import type { SealedVault, VaultPutResult, VaultStore } from "./vault.js";

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`server: HTTP ${status} ${code}`);
    this.name = "ServerError";
  }
}

export interface HttpSession {
  baseUrl: string;
  /** Device credential. Secret. */
  token: string;
  fetch?: typeof fetch;
}

export async function createAccountHttp(baseUrl: string, f: typeof fetch = fetch): Promise<{ accountId: string; deviceId: string; token: string }> {
  const r = await f(`${baseUrl}/v1/accounts`, { method: "POST" });
  if (!r.ok) throw new ServerError(r.status, ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "?");
  return (await r.json()) as { accountId: string; deviceId: string; token: string };
}

export class HttpApi implements EncryptedLogApi, VaultStore {
  private readonly f: typeof fetch;
  constructor(private readonly s: HttpSession) {
    this.f = s.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; body: T }> {
    const r = await this.f(`${this.s.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.s.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const j = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok && !okStatuses.includes(r.status)) throw new ServerError(r.status, j.error ?? "?");
    return { status: r.status, body: j };
  }

  async submit(env: EncryptedEnvelope): Promise<SubmitResult<EncryptedEnvelope>> {
    return (await this.call<SubmitResult<EncryptedEnvelope>>("POST", "/v1/log", env)).body;
  }

  async read(afterSeq: number, limit = 1000): Promise<EncryptedEntry[]> {
    return (await this.call<{ entries: EncryptedEntry[] }>("GET", `/v1/log?after=${afterSeq}&limit=${limit}`)).body.entries;
  }

  /** Long-poll: resolves when entries after `afterSeq` exist or after `waitS` seconds. */
  async waitFor(afterSeq: number, waitS = 25, limit = 1000): Promise<EncryptedEntry[]> {
    return (await this.call<{ entries: EncryptedEntry[] }>("GET", `/v1/log?after=${afterSeq}&limit=${limit}&wait=${waitS}`)).body.entries;
  }

  async renewLease(uploadId: string): Promise<boolean> {
    return (await this.call<{ ok: boolean }>("POST", `/v1/leases/${uploadId}`)).body.ok;
  }
  async releaseLease(uploadId: string): Promise<void> {
    await this.call("DELETE", `/v1/leases/${uploadId}`);
  }

  // VaultStore (accountId comes from the session; the argument is ignored)
  async get(): Promise<SealedVault | null> {
    const r = await this.call<{ revision: number; blob: string }>("GET", "/v1/vault", undefined, [404]);
    return r.status === 404 ? null : { revision: r.body.revision, blob: fromBase64(r.body.blob) };
  }
  async put(_accountId: string, expectedRevision: number, next: SealedVault): Promise<VaultPutResult> {
    const r = await this.call<{ status: "ok" } | { status: "conflict"; current: { revision: number; blob: string } | null }>(
      "PUT",
      "/v1/vault",
      { expectedRevision, revision: next.revision, blob: toBase64(next.blob) },
      [409],
    );
    if (r.body.status === "ok") return { status: "ok" };
    const c = r.body.current;
    return { status: "conflict", current: c ? { revision: c.revision, blob: fromBase64(c.blob) } : null };
  }

  async addDevice(): Promise<{ deviceId: string; token: string }> {
    return (await this.call<{ deviceId: string; token: string }>("POST", "/v1/devices")).body;
  }
  async revokeDevice(deviceId: string): Promise<void> {
    await this.call("DELETE", `/v1/devices/${deviceId}`);
  }
}
