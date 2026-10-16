// HTTP client for the metadata-only server (fetch; Node + browser).
// Implements the client-side interfaces, so MetadataClient / WebhookVault do
// not know whether the server is in-process or remote.
//
// Sign-in (decision #13): the device key signs a one-shot server challenge
// and gets a short session token. HttpApi signs in lazily and once more when
// the session has expired (401), so callers never handle tokens.

import { fromBase64, toBase64 } from "@ddv4/processing";
import type { SubmitResult } from "@ddv4/sync-core";
import type { AccountKey } from "./account-key.js";
import { authMessage, rescueKey, type Challenge, type DeviceKey } from "./device-key.js";
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

const defaultFetch: typeof fetch = (...a) => fetch(...a);

async function post<T>(f: typeof fetch, url: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const r = await f(url, { method: "POST", headers, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ServerError(r.status, j.error ?? "?");
  return j;
}

/** Ask for a challenge and check it is for the expected server instance (if pinned). */
export async function getChallenge(baseUrl: string, f: typeof fetch = defaultFetch, instanceId?: string): Promise<Challenge> {
  const c = await post<Challenge>(f, `${baseUrl}/v1/auth/challenge`, {});
  if (instanceId && c.instanceId !== instanceId) throw new Error("challenge from another server instance");
  return c;
}

/**
 * New account: registers this device's public key and the rescue public key
 * (derived from the account key), both proving possession by signing.
 */
export async function createAccountHttp(
  baseUrl: string,
  device: DeviceKey,
  account: AccountKey,
  f: typeof fetch = defaultFetch,
  invite?: string,
): Promise<{ accountId: string; deviceId: string; instanceId: string }> {
  const c = await getChallenge(baseUrl, f);
  const rk = await rescueKey(account);
  const msg = authMessage.createAccount(c, device.publicKey, rk.publicKey);
  const r = await post<{ accountId: string; deviceId: string }>(f, `${baseUrl}/v1/accounts`, {
    challengeId: c.challengeId,
    devicePublicKey: device.publicKey,
    rescuePublicKey: rk.publicKey,
    deviceSignature: await device.sign(msg),
    rescueSignature: await rk.sign(msg),
    ...(invite ? { invite } : {}),
  });
  return { ...r, instanceId: c.instanceId };
}

/**
 * Optional password sign-in: parameters for a login, then the sealed account key for a
 * correct proof. The caller opens the key locally and registers its device with the rescue key.
 */
export async function passwordParams(baseUrl: string, login: string, f: typeof fetch = defaultFetch): Promise<{ kdf: unknown }> {
  return post<{ kdf: unknown }>(f, `${baseUrl}/v1/auth/password/params`, { login });
}
export async function passwordSealedKey(baseUrl: string, login: string, proof: string, f: typeof fetch = defaultFetch): Promise<{ accountId: string; sealedKey: string }> {
  return post<{ accountId: string; sealedKey: string }>(f, `${baseUrl}/v1/auth/password/key`, { login, proof });
}

/** Rescue kit: register a new device with the rescue key, no other device needed. */
export async function rescueRegisterDevice(
  baseUrl: string,
  account: AccountKey,
  accountId: string,
  device: DeviceKey,
  f: typeof fetch = defaultFetch,
): Promise<{ deviceId: string }> {
  const c = await getChallenge(baseUrl, f);
  const rk = await rescueKey(account);
  return post<{ deviceId: string }>(f, `${baseUrl}/v1/auth/rescue-device`, {
    challengeId: c.challengeId,
    accountId,
    devicePublicKey: device.publicKey,
    signature: await rk.sign(authMessage.rescueAddDevice(c, accountId, device.publicKey)),
  });
}

export interface ServerDevice {
  deviceId: string;
  publicKey: string;
  createdAt: number;
  /** "create", "rescue" or the ID of the device that paired it. */
  addedBy?: string;
  /** Display name sealed with the account key, or null. */
  nameSealed?: string | null;
}

/** Server health (GET /v1/health, no auth). */
export async function getHealth(baseUrl: string, f: typeof fetch = defaultFetch): Promise<{ ok: boolean; version: string; mode: string; rulesVersion: number; uptimeS: number; signup: string; shares: boolean; language?: string }> {
  const r = await f(`${baseUrl}/v1/health`);
  if (!r.ok) throw new ServerError(r.status, "health");
  return r.json() as never;
}

export interface HttpSession {
  baseUrl: string;
  accountId: string;
  deviceId: string;
  /** This device's signing key (secret part stays inside). */
  key: DeviceKey;
  /** Pin the server instance (refuse challenges of another one). */
  instanceId?: string;
  fetch?: typeof fetch;
}

export class HttpApi implements EncryptedLogApi, VaultStore {
  private readonly f: typeof fetch;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private signingIn: Promise<string> | null = null;
  /** Number of successful sign-ins (tests, diagnostics). */
  logins = 0;

  constructor(readonly s: HttpSession) {
    this.f = s.fetch ?? defaultFetch;
  }

  get baseUrl(): string {
    return this.s.baseUrl;
  }

  private challenge(): Promise<Challenge> {
    return getChallenge(this.s.baseUrl, this.f, this.s.instanceId);
  }

  /** Sign in (or reuse a valid session). Concurrent callers share one sign-in. */
  async session(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt - 30_000) return this.token;
    if (!this.signingIn) {
      this.signingIn = (async () => {
        const c = await this.challenge();
        const t0 = Date.now();
        const r = await post<{ token: string; expiresAt: number; ttlMs: number }>(this.f, `${this.s.baseUrl}/v1/auth/login`, {
          challengeId: c.challengeId,
          accountId: this.s.accountId,
          deviceId: this.s.deviceId,
          signature: await this.s.key.sign(authMessage.login(c, this.s.accountId, this.s.deviceId)),
        });
        this.token = r.token;
        // Own clock + server TTL: a skewed device clock must not make sessions look expired or eternal.
        this.tokenExpiresAt = t0 + r.ttlMs;
        this.logins++;
        return r.token;
      })().finally(() => (this.signingIn = null));
    }
    return this.signingIn;
  }

  private async call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; body: T }> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.session(attempt > 0);
      const headers: Record<string, string> = { authorization: "Bearer " + token };
      if (body !== undefined) headers["content-type"] = "application/json";
      const r = await this.f(`${this.s.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const j = (await r.json().catch(() => ({}))) as T & { error?: string };
      // Expired/unknown session: sign in again once.
      if (r.status === 401 && j.error === "unauthorized" && attempt === 0) continue;
      if (!r.ok && !okStatuses.includes(r.status)) throw new ServerError(r.status, j.error ?? "?");
      return { status: r.status, body: j };
    }
  }

  /**
   * Authenticated request with any body (binary blob uploads in e2ee/plain, stage 3).
   * Signs in again once on an expired session. The caller reads the response.
   */
  async request(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.session(attempt > 0);
      const r = await this.f(`${this.s.baseUrl}${path}`, { method, body: init.body, signal: init.signal, headers: { ...init.headers, authorization: "Bearer " + token } });
      if (r.status === 401 && attempt === 0) {
        const j = (await r.clone().json().catch(() => ({}))) as { error?: string };
        if (j.error === "unauthorized") continue;
      }
      return r;
    }
  }

  /** JSON call for mode-specific endpoints (stage 3). Throws ServerError unless 2xx or in `ok`. */
  async json<T>(method: string, path: string, body?: unknown, ok: number[] = []): Promise<{ status: number; body: T }> {
    return this.call<T>(method, path, body, ok);
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
    const r = await this.call<{ revision: number; blob: string | null }>("GET", "/v1/vault", undefined, [404]);
    return r.status === 404 || r.body.blob === null ? null : { revision: r.body.revision, blob: fromBase64(r.body.blob) };
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

  /** Pairing: this signed-in device vouches for the new device's public key. */
  async addDevice(newDevicePublicKey: string): Promise<{ deviceId: string }> {
    const c = await this.challenge();
    return (
      await this.call<{ deviceId: string }>("POST", "/v1/devices", {
        challengeId: c.challengeId,
        devicePublicKey: newDevicePublicKey,
        signature: await this.s.key.sign(authMessage.addDevice(c, this.s.accountId, newDevicePublicKey)),
      })
    ).body;
  }

  async listDevices(): Promise<ServerDevice[]> {
    return (await this.call<{ devices: ServerDevice[] }>("GET", "/v1/devices")).body.devices;
  }

  /** Store a device's display name, sealed with the account key (see device-names.ts). */
  async setDeviceName(deviceId: string, nameSealed: string): Promise<void> {
    await this.call("PUT", `/v1/devices/${deviceId}/name`, { nameSealed });
  }

  // --- optional password-protected account key
  async passwordKeyStatus(): Promise<{ enabled: boolean; login: string | null; updatedAt: number | null }> {
    return (await this.call<{ enabled: boolean; login: string | null; updatedAt: number | null }>("GET", "/v1/password-key")).body;
  }
  async setPasswordKey(body: { login: string; kdf: unknown; sealedKey: string; proof: string }): Promise<{ enabled: boolean; login: string | null; updatedAt: number | null }> {
    return (await this.call<{ enabled: boolean; login: string | null; updatedAt: number | null }>("PUT", "/v1/password-key", body)).body;
  }
  async removePasswordKey(): Promise<void> {
    await this.call("DELETE", "/v1/password-key");
  }

  // --- cleanup bookkeeping (metadata only; cleanup.ts CleanupApi)
  gc(): { status(): Promise<{ now: number; lastRunAt: number | null; firstEntryAt: number | null; doneCount: number }>; done(ids: string[]): Promise<string[]>; record(r: { uploads: string[]; run: boolean }): Promise<void> } {
    return {
      status: async () => (await this.call<{ now: number; lastRunAt: number | null; firstEntryAt: number | null; doneCount: number }>("GET", "/v1/gc")).body,
      done: async (ids) => {
        const out: string[] = [];
        for (let i = 0; i < ids.length; i += 5000) out.push(...(await this.call<{ done: string[] }>("POST", "/v1/gc/done", { uploads: ids.slice(i, i + 5000) })).body.done);
        return out;
      },
      record: async (r) => {
        for (let i = 0; i < Math.max(1, r.uploads.length); i += 5000) await this.call("POST", "/v1/gc", { uploads: r.uploads.slice(i, i + 5000), run: r.run && i + 5000 >= r.uploads.length });
      },
    };
  }

  // --- shares
  async createShare(body: { attachments: { channelId: string; attachmentId: string; filename: string }[]; meta: string; ownerNote: string }): Promise<{ shareId: string }> {
    return (await this.call<{ shareId: string }>("POST", "/v1/shares", body)).body;
  }
  async listShares(): Promise<{ shareId: string; createdAt: number; ownerNote: string; revoked: boolean }[]> {
    return (await this.call<{ shares: { shareId: string; createdAt: number; ownerNote: string; revoked: boolean }[] }>("GET", "/v1/shares")).body.shares;
  }
  async revokeShare(shareId: string): Promise<void> {
    await this.call("DELETE", `/v1/shares/${shareId}`);
  }

  /** Revoke = delete its public key and sessions (signed by this device). */
  async revokeDevice(deviceId: string): Promise<void> {
    const c = await this.challenge();
    await this.call("POST", `/v1/devices/${deviceId}?action=revoke`, {
      challengeId: c.challengeId,
      signature: await this.s.key.sign(authMessage.revokeDevice(c, this.s.accountId, deviceId)),
    });
  }

  /**
   * Push notifications (role 4): a WebSocket that says "the log head is
   * now N". Needs a global WebSocket (browsers, Node 22+). Reconnects with
   * backoff until `close()`. `onHead` is also called once after every
   * (re)connect with -1, so the caller pulls whatever it missed.
   */
  subscribe(onHead: (seq: number) => void, opts: { maxBackoffMs?: number } = {}): { close(): void; readonly connected: boolean } {
    let closed = false;
    let ws: WebSocket | null = null;
    let backoff = 500;
    let connected = false;
    const open = async () => {
      if (closed) return;
      try {
        const t = await this.call<{ ticket: string }>("POST", "/v1/notify-ticket", {});
        const u = new URL(this.s.baseUrl);
        u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
        u.pathname = "/v1/notify";
        u.search = `ticket=${encodeURIComponent(t.body.ticket)}`;
        ws = new WebSocket(u.toString());
        ws.onopen = () => {
          connected = true;
          backoff = 500;
          onHead(-1);
        };
        ws.onmessage = (ev) => {
          try {
            const m = JSON.parse(String(ev.data)) as { type?: string; seq?: number };
            if (m.type === "head" && Number.isInteger(m.seq)) onHead(m.seq!);
          } catch {
            /* ignore */
          }
        };
        ws.onclose = () => {
          connected = false;
          if (!closed) setTimeout(open, (backoff = Math.min(backoff * 2, opts.maxBackoffMs ?? 30_000)));
        };
      } catch {
        if (!closed) setTimeout(open, (backoff = Math.min(backoff * 2, opts.maxBackoffMs ?? 30_000)));
      }
    };
    void open();
    return {
      close: () => {
        closed = true;
        ws?.close();
      },
      get connected() {
        return connected;
      },
    };
  }

  /** Pairing mailbox bound to this device's session. */
  pairingMailbox(): HttpPairingMailbox {
    return new HttpPairingMailbox(this.s.baseUrl, () => this.session(), this.f);
  }
}

/** Pairing mailbox over HTTP. `put` needs a signed-in device; `take` works without credentials. */
export class HttpPairingMailbox {
  private readonly f: typeof fetch;
  constructor(
    private readonly baseUrl: string,
    private readonly token: (() => Promise<string>) | null,
    f?: typeof fetch,
  ) {
    this.f = f ?? defaultFetch;
  }
  async put(pairingId: string, msg: { pub: string; sealed: string }): Promise<void> {
    if (!this.token) throw new Error("pairing put needs a signed-in device");
    const r = await this.f(`${this.baseUrl}/v1/pairing/${pairingId}`, {
      method: "PUT",
      headers: { authorization: "Bearer " + (await this.token()), "content-type": "application/json" },
      body: JSON.stringify(msg),
    });
    if (!r.ok) throw new ServerError(r.status, ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "?");
  }
  async take(pairingId: string): Promise<{ pub: string; sealed: string } | null> {
    const r = await this.f(`${this.baseUrl}/v1/pairing/${pairingId}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new ServerError(r.status, "?");
    return (await r.json()) as { pub: string; sealed: string };
  }
}
