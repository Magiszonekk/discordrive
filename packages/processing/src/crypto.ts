// DiscorDrive v4 — E2E Encryption (browser-compatible)
// Uses Web Crypto API exclusively. ZERO Node.js crypto. ZERO Buffer.

import { argon2id } from "hash-wasm";
import { config } from "@ddv4/config";

export interface Argon2Params {
  memoryKB: number;
  iterations: number;
  parallelism: number;
  saltB64: string;
}

const enc = new TextEncoder();
const IV_LENGTH = config.ivLength;

// === Utilities ===

export function generateSalt(length: number = config.saltLength): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunkSize = 8192;
  let result = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    let binary = "";
    for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]!);
    result += binary;
  }
  return btoa(result);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function exportKey(key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.exportKey("raw", key);
}

export async function importKey(raw: ArrayBuffer, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, usages);
}

async function importHkdfKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey", "deriveBits"]);
}

async function deriveAesKeyFromHkdf(
  baseKey: CryptoKey,
  info: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: enc.encode(info),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    usages,
  );
}

export async function constantTimeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// === Key Derivation (Argon2id) ===

export async function deriveKEK(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const hash = await argon2id({
    password,
    salt,
    parallelism: config.argon2.parallelism,
    iterations: config.argon2.iterations,
    memorySize: config.argon2.memory,
    hashLength: config.argon2.hashLength,
    outputType: "binary",
  });

  return crypto.subtle.importKey(
    "raw",
    hash.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

export async function deriveKEKFromParams(password: string, params: Argon2Params): Promise<CryptoKey> {
  const salt = fromBase64(params.saltB64);
  const hash = await argon2id({
    password,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKB,
    hashLength: config.argon2.hashLength,
    outputType: "binary",
  });

  return crypto.subtle.importKey(
    "raw",
    hash.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

// Runs Argon2id once and derives both the ARK-wrapping key and the server auth proof.
// Use this in login and register flows to avoid running Argon2 twice.
export async function deriveLoginMaterial(
  password: string,
  params: Argon2Params,
): Promise<{ arkWrapKey: CryptoKey; serverAuthProof: Uint8Array }> {
  const salt = fromBase64(params.saltB64);
  const hash = await argon2id({
    password,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKB,
    hashLength: config.argon2.hashLength,
    outputType: "binary",
  });

  const rawBytes = new Uint8Array(
    (hash.buffer as ArrayBuffer).slice(hash.byteOffset, hash.byteOffset + hash.byteLength),
  );

  const arkWrapKey = await crypto.subtle.importKey(
    "raw",
    rawBytes,
    { name: "AES-GCM" },
    false,
    ["wrapKey", "unwrapKey"],
  );

  const hkdfKey = await crypto.subtle.importKey("raw", rawBytes, "HKDF", false, ["deriveBits"]);
  const proofBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode("ddv4-server-auth-v1") },
    hkdfKey,
    256,
  );

  return { arkWrapKey, serverAuthProof: new Uint8Array(proofBits) };
}

// === Root keys ===

export async function generateMasterKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["wrapKey", "unwrapKey"]);
}

export async function generateARK(): Promise<CryptoKey> {
  return generateMasterKey();
}

export async function generateDomainKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["wrapKey", "unwrapKey"]);
}

export async function generateFEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function generateRootFEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
}

// === Wrapping ===

export async function wrapKey(
  keyToWrap: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<{ data: ArrayBuffer; iv: Uint8Array }> {
  const iv = randomBytes(IV_LENGTH);
  const data = await crypto.subtle.wrapKey(
    "raw",
    keyToWrap,
    wrappingKey,
    { name: "AES-GCM", iv: iv as BufferSource },
  );
  return { data, iv };
}

export async function unwrapKey(
  wrapped: ArrayBuffer,
  unwrappingKey: CryptoKey,
  iv: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    wrapped,
    unwrappingKey,
    { name: "AES-GCM", iv: iv as BufferSource },
    { name: "AES-GCM", length: 256 },
    true,
    usages,
  );
}

export async function wrapARKWithPassword(
  ark: CryptoKey,
  password: string,
  params: Argon2Params,
): Promise<{ wrappedARK: ArrayBuffer; iv: Uint8Array; params: Argon2Params }> {
  const kek = await deriveKEKFromParams(password, params);
  const wrapped = await wrapKey(ark, kek);
  return { wrappedARK: wrapped.data, iv: wrapped.iv, params };
}

export async function unwrapARKWithPassword(
  wrappedARK: ArrayBuffer,
  iv: Uint8Array,
  password: string,
  params: Argon2Params,
): Promise<CryptoKey> {
  const kek = await deriveKEKFromParams(password, params);
  return unwrapKey(wrappedARK, kek, iv, ["wrapKey", "unwrapKey"]);
}

export async function wrapDomainKey(
  domainKey: CryptoKey,
  ark: CryptoKey,
): Promise<{ data: ArrayBuffer; iv: Uint8Array }> {
  return wrapKey(domainKey, ark);
}

export async function unwrapDomainKey(
  wrappedDomainKey: ArrayBuffer,
  iv: Uint8Array,
  ark: CryptoKey,
): Promise<CryptoKey> {
  return unwrapKey(wrappedDomainKey, ark, iv, ["wrapKey", "unwrapKey"]);
}

// === HKDF subkeys ===

export async function deriveFileContentKey(rootFek: CryptoKey): Promise<CryptoKey> {
  return deriveAesKeyFromHkdf(await importHkdfKey(await exportKey(rootFek)), "ddv4-file-content-v1", ["encrypt", "decrypt"]);
}

export async function deriveFileMetadataKey(rootFek: CryptoKey): Promise<CryptoKey> {
  return deriveAesKeyFromHkdf(await importHkdfKey(await exportKey(rootFek)), "ddv4-file-metadata-v1", ["encrypt", "decrypt"]);
}

async function bufferFromBytes(bytes: Uint8Array): Promise<ArrayBuffer> {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function deriveShareWrapKey(linkSecret: Uint8Array): Promise<CryptoKey> {
  return deriveAesKeyFromHkdf(await importHkdfKey(await bufferFromBytes(linkSecret)), "ddv4-files-share-wrap-v1", ["wrapKey", "unwrapKey"]);
}

export async function deriveShareAuthKey(linkSecret: Uint8Array): Promise<CryptoKey> {
  return deriveAesKeyFromHkdf(await importHkdfKey(await bufferFromBytes(linkSecret)), "ddv4-files-share-auth-v1", ["encrypt", "decrypt"]);
}

// Derives the key that wraps an account's ARK for one API key. The input is the
// cryptoPart half of the API secret, which the client never transmits — so the
// server holds the wrapped ARK but never the means to open it.
export async function deriveApiKeyWrapKey(cryptoPart: Uint8Array): Promise<CryptoKey> {
  return deriveAesKeyFromHkdf(await importHkdfKey(await bufferFromBytes(cryptoPart)), "ddv4-api-key-wrap-v1", ["wrapKey", "unwrapKey"]);
}

export async function deriveShareCapabilityToken(authKey: CryptoKey): Promise<Uint8Array> {
  const raw = await exportKey(authKey);
  const hmacKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", hmacKey, enc.encode("ddv4-files-share-token-v1"));
  return new Uint8Array(sig);
}

// === Chunk encryption/decryption ===

export async function encryptChunk(chunk: ArrayBuffer, fek: CryptoKey): Promise<ArrayBuffer> {
  const iv = randomBytes(IV_LENGTH);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, fek, chunk);
  const output = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  output.set(iv, 0);
  output.set(new Uint8Array(ciphertext), iv.byteLength);
  return output.buffer;
}

export async function decryptChunk(encryptedWithIv: ArrayBuffer, fek: CryptoKey): Promise<ArrayBuffer> {
  const data = new Uint8Array(encryptedWithIv);
  const iv = data.subarray(0, IV_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, fek, ciphertext);
}

// === Secure files blob encryption helpers ===

async function encryptJson(value: unknown, key: CryptoKey): Promise<Uint8Array> {
  const plaintext = enc.encode(JSON.stringify(value));
  return new Uint8Array(await encryptChunk(plaintext.buffer.slice(0), key));
}

async function decryptJson<T>(payload: Uint8Array, key: CryptoKey): Promise<T> {
  const decrypted = await decryptChunk(await bufferFromBytes(payload), key);
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

export async function encryptFileMetadataPlaintext<T>(metadata: T, rootFek: CryptoKey): Promise<Uint8Array> {
  return encryptJson(metadata, await deriveFileMetadataKey(rootFek));
}

export async function decryptFileMetadataPlaintext<T>(payload: Uint8Array, rootFek: CryptoKey): Promise<T> {
  return decryptJson<T>(payload, await deriveFileMetadataKey(rootFek));
}

export async function encryptFileManifestPlaintext<T>(manifest: T, rootFek: CryptoKey): Promise<Uint8Array> {
  return encryptJson(manifest, await deriveFileContentKey(rootFek));
}

export async function decryptFileManifestPlaintext<T>(payload: Uint8Array, rootFek: CryptoKey): Promise<T> {
  return decryptJson<T>(payload, await deriveFileContentKey(rootFek));
}
