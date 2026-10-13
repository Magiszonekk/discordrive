// Optional password-protected account key (koncept §3.8, Bitwarden model; zlecenie 2026-10-13 p. 3).
//
// Off by default. When the user turns it on (Settings → Security), the browser:
//   1. derives 32 bytes from the password with Argon2id (discordrive's parameters: 64 MiB, 3
//      passes, 4 lanes; random 16-byte salt),
//   2. splits them with HKDF into a wrap key (AES-256-GCM) and an auth proof,
//   3. seals the account key with the wrap key (AAD binds it to the account),
//   4. sends the server: login name, salt, parameters, sealed key and the auth proof.
// The server keeps SHA-256(proof) as a verifier, never the proof or the password, and hands the
// sealed key out only after a correct proof (attempts limited per account and per IP), so
// guessing needs the database. With the database, a weak password can be cracked offline (Argon2id
// only slows that down): the UI says so and asks for a long password.
// A new device signs in with login + password: it gets the sealed key, opens it locally and
// registers its own device key signed with the rescue key derived from the account key (the same
// path as a rescue kit, decision #13). The same mechanism in every mode.

import { argon2id } from "hash-wasm";
import { fromBase64, toBase64 } from "@ddv4/processing";
import { accountKeyFromRaw, seal, unseal, type AccountKey } from "./account-key.js";
import type { DeviceKey } from "./device-key.js";

export interface Argon2Params {
  alg: "argon2id";
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  saltB64: string;
}

/** discordrive's parameters (@ddv4/config argon2: 64 MiB, 3 iterations, 4 lanes, 32-byte output). */
export const PASSWORD_ARGON2 = { memoryKiB: 65536, iterations: 3, parallelism: 4 } as const;
/** Accepted parameter range (server checks what it stores; the client what it is told to use). */
export const ARGON2_LIMITS = { memoryKiB: [19456, 1048576], iterations: [2, 10], parallelism: [1, 8] } as const;
export const MIN_PASSWORD_LENGTH = 10;

const enc = new TextEncoder();

export function checkArgon2Params(p: unknown): Argon2Params {
  const x = p as Argon2Params;
  const inRange = (v: unknown, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!x || x.alg !== "argon2id" || !inRange(x.memoryKiB, ARGON2_LIMITS.memoryKiB) || !inRange(x.iterations, ARGON2_LIMITS.iterations) || !inRange(x.parallelism, ARGON2_LIMITS.parallelism)) {
    throw new Error("bad_kdf_params");
  }
  if (typeof x.saltB64 !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(x.saltB64)) throw new Error("bad_kdf_params");
  return { alg: "argon2id", memoryKiB: x.memoryKiB, iterations: x.iterations, parallelism: x.parallelism, saltB64: x.saltB64 };
}

/** Login names: trimmed, NFC, case-folded; letters, digits and . _ - + @ (3–64). */
export function normalizeLogin(s: string): string {
  return s.trim().normalize("NFC").toLowerCase();
}
export function validLogin(s: string): boolean {
  return /^[\p{L}\p{N}._+@-]{3,64}$/u.test(s);
}

async function derive(password: string, p: Argon2Params): Promise<{ wrap: CryptoKey; proof: Uint8Array }> {
  const out = await argon2id({
    password: password.normalize("NFC"),
    salt: fromBase64(p.saltB64),
    memorySize: p.memoryKiB,
    iterations: p.iterations,
    parallelism: p.parallelism,
    hashLength: 32,
    outputType: "binary",
  });
  const base = await crypto.subtle.importKey("raw", out as BufferSource, "HKDF", false, ["deriveKey", "deriveBits"]);
  const hk = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode(info) });
  const wrap = await crypto.subtle.deriveKey(hk("ddn-pw-wrap-v1"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const proof = new Uint8Array(await crypto.subtle.deriveBits(hk("ddn-pw-auth-v1"), base, 256));
  return { wrap, proof };
}

const aad = (accountId: string) => `ddn-pw-key-v1|${accountId}`;

/** What the client sends to turn the option on or to change the password. */
export interface PasswordKeyUpload {
  login: string;
  kdf: Argon2Params;
  /** Account key sealed with the password wrap key, base64. */
  sealedKey: string;
  /** Auth proof, base64 (the server stores only its SHA-256). */
  proof: string;
}

export async function protectAccountKey(
  key: AccountKey,
  accountId: string,
  login: string,
  password: string,
  params: Pick<Argon2Params, "memoryKiB" | "iterations" | "parallelism"> = PASSWORD_ARGON2,
): Promise<PasswordKeyUpload> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error("password_too_short");
  const kdf: Argon2Params = { alg: "argon2id", memoryKiB: params.memoryKiB, iterations: params.iterations, parallelism: params.parallelism, saltB64: toBase64(crypto.getRandomValues(new Uint8Array(16))) };
  const { wrap, proof } = await derive(password, kdf);
  const sealedKey = toBase64(await seal(wrap, fromBase64(key.rawB64), aad(accountId)));
  return { login: normalizeLogin(login), kdf, sealedKey, proof: toBase64(proof) };
}

/** Proof for a login attempt (Argon2id with the stored parameters). */
export async function passwordProof(password: string, kdf: Argon2Params): Promise<{ proof: string; open(accountId: string, sealedKey: string): Promise<AccountKey> }> {
  const { wrap, proof } = await derive(password, checkArgon2Params(kdf));
  return {
    proof: toBase64(proof),
    open: async (accountId, sealedKey) => accountKeyFromRaw(await unseal(wrap, fromBase64(sealedKey), aad(accountId), "account key")),
  };
}

/**
 * Rough strength estimate for the UI (no dictionary: the warning asks for a long passphrase anyway).
 * bits = length × log2(alphabet), minus repeats and runs; 0 weak, 1 fair, 2 good, 3 strong.
 */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3; bits: number } {
  if (!pw) return { score: 0, bits: 0 };
  let alpha = 0;
  if (/[a-z]/.test(pw)) alpha += 26;
  if (/[A-Z]/.test(pw)) alpha += 26;
  if (/[0-9]/.test(pw)) alpha += 10;
  if (/[^A-Za-z0-9]/.test(pw)) alpha += 33;
  const chars = [...pw];
  let effective = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const prev = chars[i - 1];
    const step = prev ? c.codePointAt(0)! - prev.codePointAt(0)! : 99;
    // repeats ("aaaa") and runs ("abcd", "1234") add little
    effective += c === prev ? 0.1 : Math.abs(step) === 1 ? 0.3 : 1;
  }
  const unique = new Set(chars).size;
  const bits = Math.round(Math.min(effective, unique * 2) * Math.log2(Math.max(alpha, 2)));
  const score = pw.length < MIN_PASSWORD_LENGTH || bits < 45 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : 3;
  return { score, bits };
}

/**
 * New device: login + password -> account key (opened locally) -> this device registered with the
 * rescue key derived from it (same path as a rescue kit). Wrong password: ServerError 401
 * bad_password; too many attempts: 429 rate_limited.
 */
export async function signInWithPassword(
  baseUrl: string,
  login: string,
  password: string,
  device: DeviceKey,
  f?: typeof fetch,
): Promise<{ accountId: string; deviceId: string; instanceId: string; key: AccountKey }> {
  const { passwordParams, passwordSealedKey, rescueRegisterDevice, getChallenge } = await import("./http-api.js");
  const l = normalizeLogin(login);
  const { kdf } = await passwordParams(baseUrl, l, f);
  const pp = await passwordProof(password, checkArgon2Params(kdf));
  const got = await passwordSealedKey(baseUrl, l, pp.proof, f);
  const key = await pp.open(got.accountId, got.sealedKey);
  const { deviceId } = await rescueRegisterDevice(baseUrl, key, got.accountId, device, f);
  const { instanceId } = await getChallenge(baseUrl, f);
  return { accountId: got.accountId, deviceId, instanceId, key };
}
