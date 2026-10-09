// Account key and its subkeys (koncept §3.2, §3.5, §3.8).
//
// Metadata-only mode has one secret per account: a random 256-bit account key
// (on every paired device, in the rescue kit; optionally password-wrapped on
// the server, §3.8). Everything the server stores for the account is
// encrypted with subkeys derived from it by HKDF-SHA256 with distinct labels,
// so one ciphertext can never be replayed as another kind:
//   vault      - webhook vault (§3.2)
//   op         - operation payloads in the log (§3.3)
//   snapshot   - snapshots and the pointer message (§6.2), later
// File keys stay random per file (koncept §6.2) and travel inside encrypted
// op payloads.

import { fromBase64, toBase64 } from "@ddv4/processing";

export const ACCOUNT_KEY_BYTES = 32;
export type SubkeyLabel = "vault" | "op" | "snapshot" | "device-name";

export interface AccountKey {
  /** Raw key, base64. Secret: never log. */
  readonly rawB64: string;
  subkey(label: SubkeyLabel): Promise<CryptoKey>;
}

const enc = new TextEncoder();

export function accountKeyFromRaw(raw: Uint8Array): AccountKey {
  if (raw.byteLength !== ACCOUNT_KEY_BYTES) throw new Error("account key must be 32 bytes");
  const copy = new Uint8Array(raw);
  const cache = new Map<SubkeyLabel, Promise<CryptoKey>>();
  return {
    rawB64: toBase64(copy),
    subkey(label) {
      let k = cache.get(label);
      if (!k) {
        k = crypto.subtle
          .importKey("raw", copy as BufferSource, "HKDF", false, ["deriveKey"])
          .then((base) =>
            crypto.subtle.deriveKey(
              { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode(`ddn-${label}-v1`) },
              base,
              { name: "AES-GCM", length: 256 },
              false,
              ["encrypt", "decrypt"],
            ),
          );
        cache.set(label, k);
      }
      return k;
    },
  };
}

export function newAccountKey(): AccountKey {
  return accountKeyFromRaw(crypto.getRandomValues(new Uint8Array(ACCOUNT_KEY_BYTES)));
}

export function accountKeyFromB64(b64: string): AccountKey {
  return accountKeyFromRaw(fromBase64(b64.trim()));
}

// --- Authenticated encryption with associated data (AES-256-GCM).
// Wire format: version byte (1) || iv (12) || ciphertext+tag.
// AAD binds the ciphertext to its context (kind, IDs, plaintext envelope
// fields), so the server cannot move it to another envelope or edit them.

const SEAL_VERSION = 1;
const IV_BYTES = 12;

export async function seal(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, plaintext as BufferSource),
  );
  const out = new Uint8Array(1 + IV_BYTES + ct.byteLength);
  out[0] = SEAL_VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return out;
}

export class UnsealError extends Error {
  constructor(what: string) {
    super(`cannot decrypt ${what} (wrong key, tampered data or wrong context)`);
    this.name = "UnsealError";
  }
}

export async function unseal(key: CryptoKey, sealed: Uint8Array, aad: string, what = "data"): Promise<Uint8Array> {
  if (sealed.byteLength < 1 + IV_BYTES + 16 || sealed[0] !== SEAL_VERSION) throw new UnsealError(what);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: sealed.subarray(1, 1 + IV_BYTES) as BufferSource, additionalData: enc.encode(aad) },
        key,
        sealed.subarray(1 + IV_BYTES) as BufferSource,
      ),
    );
  } catch {
    throw new UnsealError(what);
  }
}

export async function sealJson(key: CryptoKey, value: unknown, aad: string): Promise<Uint8Array> {
  return seal(key, enc.encode(JSON.stringify(value)), aad);
}

export async function unsealJson<T>(key: CryptoKey, sealed: Uint8Array, aad: string, what?: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await unseal(key, sealed, aad, what))) as T;
}
