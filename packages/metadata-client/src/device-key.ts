// Device signing keys and auth messages (koncept §3.3, decision #13 of 2026-10-06).
//
// Every device has its own Ed25519 key pair. The server stores only public
// keys; signing in = signing a random one-shot challenge, which yields a
// short-lived session token. Pairing adds a new device's public key with a
// signature of an already signed-in device; the rescue kit adds one with the
// rescue key, an Ed25519 key derived from the account key (its public half is
// registered when the account is created). Revoking = deleting the public key.
//
// All signed messages are built here and shared by client and server, so the
// two can never disagree on the bytes. Every message names its purpose, the
// server instance and the challenge, so a signature is good for exactly one
// action on one server, once.

import { fromBase64, toBase64 } from "@ddv4/processing";
import type { AccountKey } from "./account-key.js";

const ED = { name: "Ed25519" } as const;
const enc = new TextEncoder();

export const b64u = (b: Uint8Array): string => toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function unb64u(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return fromBase64(t);
}

const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
export const isPublicKey = (s: unknown): s is string => typeof s === "string" && PUB_RE.test(s);
export const isSignature = (s: unknown): s is string => typeof s === "string" && SIG_RE.test(s);

export interface DeviceKey {
  /** Raw 32-byte public key, base64url (43 chars). */
  readonly publicKey: string;
  sign(message: string): Promise<string>;
}

async function fromPrivate(priv: CryptoKey, publicRaw: Uint8Array): Promise<DeviceKey> {
  return {
    publicKey: b64u(publicRaw),
    sign: async (m) => b64u(new Uint8Array(await crypto.subtle.sign(ED, priv, enc.encode(m)))),
  };
}

/**
 * New device key. `extractable: false` (browser: keep the CryptoKey in
 * IndexedDB, the private bytes never reach JS); CLI uses true to store PKCS#8 in a 0600 file.
 */
export async function generateDeviceKey(extractable = false): Promise<DeviceKey & { privateKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey(ED, extractable, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { ...(await fromPrivate(kp.privateKey, pub)), privateKey: kp.privateKey };
}

export async function exportDeviceKey(k: { privateKey: CryptoKey; publicKey: string }): Promise<{ pkcs8: string; publicKey: string }> {
  return { pkcs8: b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey))), publicKey: k.publicKey };
}

export async function importDeviceKey(s: { pkcs8: string; publicKey: string }): Promise<DeviceKey> {
  const priv = await crypto.subtle.importKey("pkcs8", unb64u(s.pkcs8) as BufferSource, ED, false, ["sign"]);
  const key = await fromPrivate(priv, unb64u(s.publicKey));
  // Refuse a stored pair whose halves do not match.
  if (!(await verifySignature(s.publicKey, "ddn-selftest", await key.sign("ddn-selftest")))) throw new Error("device key: public key does not match");
  return key;
}

/** Ed25519 PKCS#8 for a 32-byte seed (RFC 8410). */
function pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  const head = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  const out = new Uint8Array(head.length + 32);
  out.set(head);
  out.set(seed, head.length);
  return out;
}

/** The rescue key: deterministic from the account key (HKDF label "ddn-rescue-ed25519-v1"). */
export async function rescueKey(account: AccountKey): Promise<DeviceKey> {
  const raw = fromBase64(account.rawB64);
  const base = await crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, ["deriveBits"]);
  raw.fill(0);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode("ddn-rescue-ed25519-v1") }, base, 256),
  );
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8FromSeed(seed) as BufferSource, ED, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  seed.fill(0);
  return fromPrivate(await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["sign"] }, ED, false, ["sign"]), unb64u(jwk.x!));
}

const pubCache = new Map<string, Promise<CryptoKey>>();
export async function verifySignature(publicKey: string, message: string, signature: string): Promise<boolean> {
  if (!isPublicKey(publicKey) || !isSignature(signature)) return false;
  let k = pubCache.get(publicKey);
  if (!k) {
    k = crypto.subtle.importKey("raw", unb64u(publicKey) as BufferSource, ED, false, ["verify"]);
    if (pubCache.size > 10_000) pubCache.clear();
    pubCache.set(publicKey, k);
  }
  try {
    return await crypto.subtle.verify(ED, await k, unb64u(signature) as BufferSource, enc.encode(message));
  } catch {
    return false;
  }
}

/** A challenge as issued by the server. */
export interface Challenge {
  challengeId: string;
  nonce: string;
  /** The server instance; a client refuses challenges of another instance. */
  instanceId: string;
  expiresAt: number;
}

const m = (...parts: (string | number)[]) => parts.join("|");
export const authMessage = {
  createAccount: (c: Challenge, devicePub: string, rescuePub: string) => m("ddn-create-account-v1", c.instanceId, c.challengeId, c.nonce, devicePub, rescuePub),
  login: (c: Challenge, accountId: string, deviceId: string) => m("ddn-login-v1", c.instanceId, c.challengeId, c.nonce, accountId, deviceId),
  addDevice: (c: Challenge, accountId: string, newDevicePub: string) => m("ddn-add-device-v1", c.instanceId, c.challengeId, c.nonce, accountId, newDevicePub),
  revokeDevice: (c: Challenge, accountId: string, deviceId: string) => m("ddn-revoke-device-v1", c.instanceId, c.challengeId, c.nonce, accountId, deviceId),
  rescueAddDevice: (c: Challenge, accountId: string, newDevicePub: string) => m("ddn-rescue-add-device-v1", c.instanceId, c.challengeId, c.nonce, accountId, newDevicePub),
};
