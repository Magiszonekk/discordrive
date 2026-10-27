// The Safe: a part of the account (Drive and Gallery) closed with its own password.
//
// Threat model: whoever uses the same account (a paired device, the rescue kit, a copy of the server,
// the account's Discord channels) holds the account key and can read everything else; the Safe must stay
// closed to them. A forgotten password opens it for nobody, the owner included.
//
// So the Safe is not in the account's log (whatever is there is readable with the account key). Its whole
// state is one object in a slot on the instance (GET/PUT /v1/slots/safe, compare-and-swap on the
// revision, like the webhook vault), sealed in two layers:
//   blob   = "DDNS" || u32 BE header length || sealed header || sealed state   (base64 in the slot)
//   header = { format, version, kdf, sealedMaster }  sealed with the account subkey "safe"
//            (AAD ddn-safe-head-v1|account|revision): the instance cannot even try the password offline
//   master = 32 random bytes, sealed with HKDF(Argon2id(password, salt), "ddn-safe-wrap-v1")
//            (AAD ddn-safe-key-v1|account). The account key never wraps it.
//   state  = JSON padded to 64 KiB · 2^k, sealed with HKDF(master, "ddn-safe-state-v1")
//            (AAD ddn-safe-state-v1|account|revision): names, paths, thumbnails' keys, how many files.
// Header and state are bound to the slot's revision (the instance cannot mix an old part into a new
// slot) and a client refuses a revision older than the one it saw (rollback).
// A password change re-seals the master only. The master is what a device keeps (Android Keystore /
// the system key store behind a PIN or a fingerprint) and what the optional Safe kit holds.
// What still leaks: that a Safe exists, its padded size, when it changes, and (later) the size and
// number of its pieces on Discord.

import { argon2id } from "hash-wasm";
import { fromBase64, toBase64 } from "@ddv4/processing";
import { seal, unseal, UnsealError, type AccountKey } from "./account-key.js";
import { MIN_PASSWORD_LENGTH, PASSWORD_ARGON2, checkArgon2Params, type Argon2Params } from "./password-key.js";

export const SAFE_SLOT = "safe";
export const SAFE_FORMAT = "ddn-safe";
export const SAFE_VERSION = 1;
/** The account password's parameters (64 MiB, 3 passes, 4 lanes); stored per Safe, changed with the password. */
export const SAFE_ARGON2 = PASSWORD_ARGON2;
/** Smallest padded state (bytes); larger states take the next power of two above it. */
export const SAFE_PAD_MIN = 64 * 1024;
/** Largest padded state one slot holds (the slot's size limit on the instance). */
export const SAFE_PAD_MAX = 1024 * 1024;
export const SAFE_MASTER_BYTES = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAGIC = enc.encode("DDNS");

export interface SafeHeader {
  format: typeof SAFE_FORMAT;
  version: number;
  kdf: Argon2Params;
  /** The master sealed with the password's wrap key, base64. */
  sealedMaster: string;
}

export class SafeBadPasswordError extends Error {
  constructor() {
    super("wrong Safe password");
    this.name = "SafeBadPasswordError";
  }
}
export class SafeRollbackError extends Error {
  constructor(seen: number, got: number) {
    super(`the Safe went back from revision ${seen} to ${got}: refusing (server rollback?)`);
    this.name = "SafeRollbackError";
  }
}
export class SafeExistsError extends Error {
  constructor() {
    super("this account has a Safe already");
    this.name = "SafeExistsError";
  }
}
export class SafeMissingError extends Error {
  constructor() {
    super("this account has no Safe");
    this.name = "SafeMissingError";
  }
}
/** The slot holds something that is not a Safe this account opens (overwritten or damaged): not a wrong password. */
export class SafeDamagedError extends Error {
  constructor(why: string) {
    super(`the Safe is damaged or was replaced (${why})`);
    this.name = "SafeDamagedError";
  }
}
export class SafeTooLargeError extends Error {
  constructor(bytes: number) {
    super(`the Safe's state is too large (${bytes} bytes; at most ${SAFE_PAD_MAX - 4})`);
    this.name = "SafeTooLargeError";
  }
}

// ── keys ──

async function hkdf(ikm: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode(info) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Argon2id of the password (NFC) with the Safe's parameters: 32 bytes. */
export async function safeArgon2(password: string, kdf: Argon2Params): Promise<Uint8Array> {
  const p = checkArgon2Params(kdf);
  return (await argon2id({ password: password.normalize("NFC"), salt: fromBase64(p.saltB64), memorySize: p.memoryKiB, iterations: p.iterations, parallelism: p.parallelism, hashLength: 32, outputType: "binary" })) as Uint8Array;
}

/** The key that seals the master: HKDF(Argon2id(password), "ddn-safe-wrap-v1"). */
export async function safeWrapKey(password: string, kdf: Argon2Params): Promise<CryptoKey> {
  return hkdf(await safeArgon2(password, kdf), "ddn-safe-wrap-v1");
}

/** Keys from the master: the state's, and the one later used for the Safe's files. */
export function safeKeys(master: Uint8Array): { state: Promise<CryptoKey>; files: Promise<CryptoKey> } {
  if (master.byteLength !== SAFE_MASTER_BYTES) throw new Error("Safe master must be 32 bytes");
  return { state: hkdf(master, "ddn-safe-state-v1"), files: hkdf(master, "ddn-safe-files-v1") };
}

const masterAad = (accountId: string) => `ddn-safe-key-v1|${accountId}`;
const headAad = (accountId: string, revision: number) => `ddn-safe-head-v1|${accountId}|${revision}`;
const stateAad = (accountId: string, revision: number) => `ddn-safe-state-v1|${accountId}|${revision}`;

/** A header for `master` closed with `password` (new random salt). */
export async function newSafeHeader(master: Uint8Array, password: string, accountId: string, params: Pick<Argon2Params, "memoryKiB" | "iterations" | "parallelism"> = SAFE_ARGON2, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<SafeHeader> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error("password_too_short");
  const kdf: Argon2Params = checkArgon2Params({ alg: "argon2id", memoryKiB: params.memoryKiB, iterations: params.iterations, parallelism: params.parallelism, saltB64: toBase64(salt) });
  const sealedMaster = toBase64(await seal(await safeWrapKey(password, kdf), master, masterAad(accountId)));
  return { format: SAFE_FORMAT, version: SAFE_VERSION, kdf, sealedMaster };
}

/** The master from a header and the password; a wrong password is SafeBadPasswordError. */
export async function openSafeMaster(header: SafeHeader, password: string, accountId: string): Promise<Uint8Array> {
  // No Safe password is empty (create needs MIN_PASSWORD_LENGTH): wrong, without running Argon2.
  if (!password) throw new SafeBadPasswordError();
  try {
    const m = await unseal(await safeWrapKey(password, header.kdf), fromBase64(header.sealedMaster), masterAad(accountId), "Safe key");
    if (m.byteLength !== SAFE_MASTER_BYTES) throw new SafeBadPasswordError();
    return m;
  } catch (e) {
    if (e instanceof UnsealError) throw new SafeBadPasswordError();
    throw e;
  }
}

// ── padding: the state's size tells nothing finer than its power-of-two bucket ──

/** u32 BE length || bytes || zeros, to the smallest 64 KiB · 2^k that holds it. */
export function padState(plain: Uint8Array): Uint8Array {
  const need = plain.byteLength + 4;
  if (need > SAFE_PAD_MAX) throw new SafeTooLargeError(plain.byteLength);
  let size = SAFE_PAD_MIN;
  while (size < need) size *= 2;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, plain.byteLength);
  out.set(plain, 4);
  return out;
}
export function unpadState(padded: Uint8Array): Uint8Array {
  const n = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (n + 4 > padded.byteLength) throw new Error("Safe state: bad padding");
  return padded.subarray(4, 4 + n);
}

// ── the slot's blob ──

/** The slot's blob (base64) for `revision`: the header under the account key, the state under the master. */
export async function sealSafeSlot(o: { key: AccountKey; accountId: string; revision: number; header: SafeHeader; master: Uint8Array; state: unknown }): Promise<string> {
  const head = await seal(await o.key.subkey("safe"), enc.encode(JSON.stringify(o.header)), headAad(o.accountId, o.revision));
  const body = await seal(await safeKeys(o.master).state, padState(enc.encode(JSON.stringify(o.state))), stateAad(o.accountId, o.revision));
  const out = new Uint8Array(8 + head.byteLength + body.byteLength);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, head.byteLength);
  out.set(head, 8);
  out.set(body, 8 + head.byteLength);
  return toBase64(out);
}

/** What the account key opens: the header (no names, no count) and the still sealed state. */
export async function openSafeHeader(key: AccountKey, accountId: string, revision: number, blobB64: string): Promise<{ header: SafeHeader; sealedState: Uint8Array }> {
  const b = fromBase64(blobB64);
  if (b.byteLength < 8 || MAGIC.some((x, i) => b[i] !== x)) throw new Error("not a Safe");
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4);
  if (8 + n > b.byteLength) throw new Error("not a Safe");
  const h = JSON.parse(dec.decode(await unseal(await key.subkey("safe"), b.subarray(8, 8 + n), headAad(accountId, revision), "Safe header"))) as SafeHeader;
  if (h.format !== SAFE_FORMAT || h.version !== SAFE_VERSION) throw new Error("unsupported Safe format");
  checkArgon2Params(h.kdf);
  return { header: h, sealedState: b.subarray(8 + n) };
}

/** The state, opened with the master. */
export async function openSafeState<S>(master: Uint8Array, accountId: string, revision: number, sealedState: Uint8Array): Promise<S> {
  const p = await unseal(await safeKeys(master).state, sealedState, stateAad(accountId, revision), "Safe state");
  return JSON.parse(dec.decode(unpadState(p))) as S;
}

// ── the store ──

export interface SlotApi {
  /** revision 0 + blob null = none. */
  getSlot(name: string): Promise<{ revision: number; blob: string | null }>;
  /** null = stored; else the current one that won. `dropHistory`: forget the earlier revisions (a new password). */
  putSlot(name: string, expectedRevision: number, revision: number, blob: string, opts?: { dropHistory?: boolean }): Promise<{ revision: number; blob: string | null } | null>;
  /** Earlier revisions the instance keeps (newest first), and one of them. */
  slotHistory?(name: string): Promise<{ revision: number; replacedAt: number; chars: number }[]>;
  slotRevision?(name: string, revision: number): Promise<{ revision: number; blob: string }>;
}

/** An open Safe: its master (keep it only in memory or behind the device's key store), header and state. */
export interface UnlockedSafe<S> {
  readonly master: Uint8Array;
  readonly revision: number;
  readonly header: SafeHeader;
  readonly state: S;
}

export class SafeStore<S = unknown> {
  constructor(
    private readonly api: SlotApi,
    private readonly key: AccountKey,
    private readonly accountId: string,
    /** Highest revision seen (persist it): an older one from the server is refused. */
    public seenRevision = 0,
  ) {}

  private async read(): Promise<{ revision: number; blob: string | null }> {
    const r = await this.api.getSlot(SAFE_SLOT);
    if (r.revision < this.seenRevision) throw new SafeRollbackError(this.seenRevision, r.revision);
    return r;
  }

  /** Whether the account has a Safe (the account key opens this much; nothing about what is inside). */
  async exists(): Promise<boolean> {
    return (await this.read()).blob !== null;
  }

  private async open(revision: number, blob: string, master: (h: SafeHeader) => Promise<Uint8Array>): Promise<UnlockedSafe<S>> {
    // What the account key must open (the outer layer): failing here is a damaged / replaced Safe.
    const opened = await openSafeHeader(this.key, this.accountId, revision, blob).catch((e: unknown) => {
      throw new SafeDamagedError(e instanceof Error ? e.message : String(e));
    });
    const { header, sealedState } = opened;
    const m = await master(header);
    const state = await openSafeState<S>(m, this.accountId, revision, sealedState);
    this.seenRevision = Math.max(this.seenRevision, revision);
    return { master: m, revision, header, state };
  }

  /** A new Safe with `password` (the owner confirmed there is no recovery without it). */
  async create(password: string, state: S, params: Pick<Argon2Params, "memoryKiB" | "iterations" | "parallelism"> = SAFE_ARGON2): Promise<UnlockedSafe<S>> {
    if ((await this.read()).blob !== null) throw new SafeExistsError();
    const master = crypto.getRandomValues(new Uint8Array(SAFE_MASTER_BYTES));
    const header = await newSafeHeader(master, password, this.accountId, params);
    const blob = await sealSafeSlot({ key: this.key, accountId: this.accountId, revision: 1, header, master, state });
    if (await this.api.putSlot(SAFE_SLOT, 0, 1, blob)) throw new SafeExistsError();
    this.seenRevision = 1;
    return { master, revision: 1, header, state };
  }

  async unlock(password: string): Promise<UnlockedSafe<S>> {
    const r = await this.read();
    if (r.blob === null) throw new SafeMissingError();
    return this.open(r.revision, r.blob, (h) => openSafeMaster(h, password, this.accountId));
  }

  /** With the master kept by this device (key store) or from a Safe kit. */
  async unlockWithMaster(master: Uint8Array): Promise<UnlockedSafe<S>> {
    const r = await this.read();
    if (r.blob === null) throw new SafeMissingError();
    return this.open(r.revision, r.blob, async () => master);
  }

  /** Apply `change` to the newest state and store it; on a concurrent edit re-read and apply again. */
  async update(u: UnlockedSafe<S>, change: (s: S) => S, maxAttempts = 5): Promise<UnlockedSafe<S>> {
    let cur = u;
    for (let i = 0; i < maxAttempts; i++) {
      const next = change(structuredClone(cur.state));
      const rev = cur.revision + 1;
      const blob = await sealSafeSlot({ key: this.key, accountId: this.accountId, revision: rev, header: cur.header, master: cur.master, state: next });
      const won = await this.api.putSlot(SAFE_SLOT, cur.revision, rev, blob);
      if (!won) {
        this.seenRevision = rev;
        return { master: cur.master, revision: rev, header: cur.header, state: next };
      }
      if (won.blob === null) throw new SafeMissingError();
      // Another device wrote meanwhile (maybe a new password: its header is taken as it is).
      cur = await this.open(won.revision, won.blob, async () => cur.master);
    }
    throw new Error("Safe: too many concurrent edits");
  }

  /** Earlier revisions the instance keeps (newest first): to bring back a damaged or overwritten Safe. */
  async history(): Promise<{ revision: number; replacedAt: number }[]> {
    if (!this.api.slotHistory) return [];
    return (await this.api.slotHistory(SAFE_SLOT)).map((r) => ({ revision: r.revision, replacedAt: r.replacedAt }));
  }

  /**
   * Bring back an earlier revision: opened with the password it had then (or a master), re-sealed under the
   * next revision of the slot (both layers are bound to their revision), with its header (that password).
   */
  async restore(revision: number, unlock: { password: string } | { master: Uint8Array }): Promise<UnlockedSafe<S>> {
    if (!this.api.slotRevision) throw new Error("this instance keeps no Safe history");
    const old = await this.api.slotRevision(SAFE_SLOT, revision);
    const u = await this.open(old.revision, old.blob, (h) => ("password" in unlock ? openSafeMaster(h, unlock.password, this.accountId) : Promise.resolve(unlock.master)));
    for (let i = 0; i < 5; i++) {
      const cur = await this.api.getSlot(SAFE_SLOT);
      const rev = cur.revision + 1;
      const blob = await sealSafeSlot({ key: this.key, accountId: this.accountId, revision: rev, header: u.header, master: u.master, state: u.state });
      if (!(await this.api.putSlot(SAFE_SLOT, cur.revision, rev, blob))) {
        this.seenRevision = Math.max(this.seenRevision, rev);
        return { master: u.master, revision: rev, header: u.header, state: u.state };
      }
    }
    throw new Error("Safe: too many concurrent edits");
  }

  /**
   * A new password: the master re-sealed (the files and the state stay as they are), and the instance's earlier
   * revisions dropped in the same write: they hold the master under the old password, which must stop working
   * (someone who learned the old password and had already opened the Safe knows the master: see the threat model).
   */
  async changePassword(u: UnlockedSafe<S>, newPassword: string, params: Pick<Argon2Params, "memoryKiB" | "iterations" | "parallelism"> = SAFE_ARGON2): Promise<UnlockedSafe<S>> {
    const header = await newSafeHeader(u.master, newPassword, this.accountId, params);
    for (let cur = u, i = 0; i < 5; i++) {
      const rev = cur.revision + 1;
      const blob = await sealSafeSlot({ key: this.key, accountId: this.accountId, revision: rev, header, master: cur.master, state: cur.state });
      const won = await this.api.putSlot(SAFE_SLOT, cur.revision, rev, blob, { dropHistory: true });
      if (!won) {
        this.seenRevision = rev;
        return { master: cur.master, revision: rev, header, state: cur.state };
      }
      if (won.blob === null) throw new SafeMissingError();
      cur = await this.open(won.revision, won.blob, async () => cur.master);
    }
    throw new Error("Safe: too many concurrent edits");
  }
}

// ── the optional Safe kit: the master in text (whoever has it opens the Safe without the password) ──

// ddn-safe1:<account>:<master, base64url>:<check: 8 hex of SHA-256("ddn-safe-kit|account|master b64url")>,
// so a typo says "not a Safe kit" instead of "wrong key or tampered data".
const KIT_PREFIX = "ddn-safe1";
async function kitCheck(accountId: string, m64: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`ddn-safe-kit|${accountId}|${m64}`)));
  return [...h.subarray(0, 4)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export async function safeKitText(accountId: string, master: Uint8Array): Promise<string> {
  const m64 = toBase64(master).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${KIT_PREFIX}:${accountId}:${m64}:${await kitCheck(accountId, m64)}`;
}
export async function parseSafeKit(text: string): Promise<{ accountId: string; master: Uint8Array }> {
  const m = /^ddn-safe1:([A-Za-z0-9_-]{4,80}):([A-Za-z0-9_-]{43}):([0-9a-f]{8})$/.exec(text.trim());
  if (!m || (await kitCheck(m[1]!, m[2]!)) !== m[3]) throw new Error("not a Safe kit");
  const master = fromBase64(m[2]!.replace(/-/g, "+").replace(/_/g, "/") + "=");
  if (master.byteLength !== SAFE_MASTER_BYTES) throw new Error("not a Safe kit");
  return { accountId: m[1]!, master };
}
