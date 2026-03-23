// DiscorDrive v4 — E2E Encryption (browser-compatible)
// Uses Web Crypto API exclusively. ZERO Node.js crypto. ZERO Buffer.

import { argon2id } from "hash-wasm";
import { config } from "@ddv4/config";

// === Utilities ===

export function generateSalt(length: number = config.saltLength): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // Chunked conversion to avoid call stack overflow on large buffers
  const CHUNK_SIZE = 8192;
  let result = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += String.fromCharCode(...chunk);
  }
  return btoa(result);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function exportKey(key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.exportKey("raw", key);
}

export async function importKey(
  raw: ArrayBuffer,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, usages);
}

// === Key Derivation (Argon2id) ===

export async function deriveKEK(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
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

// === Master Key ===

export async function generateMasterKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable — must be true so it can be wrapped
    ["wrapKey", "unwrapKey"],
  );
}

// === Key Wrapping ===

export async function wrapKey(
  keyToWrap: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<{ data: ArrayBuffer; iv: Uint8Array }> {
  const iv = randomBytes(config.ivLength);
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

// === File Encryption Key (FEK) ===

export async function generateFEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable — must be true so it can be wrapped
    ["encrypt", "decrypt"],
  );
}

// === Chunk Encryption/Decryption ===

export async function encryptChunk(
  chunk: ArrayBuffer,
  fek: CryptoKey,
): Promise<ArrayBuffer> {
  const iv = randomBytes(config.ivLength);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    fek,
    chunk,
  );

  // Output format: [12B IV | ciphertext (includes 16B auth tag)]
  const output = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  output.set(iv, 0);
  output.set(new Uint8Array(ciphertext), iv.byteLength);
  return output.buffer;
}

export async function decryptChunk(
  encryptedWithIv: ArrayBuffer,
  fek: CryptoKey,
): Promise<ArrayBuffer> {
  const data = new Uint8Array(encryptedWithIv);
  const iv = data.subarray(0, config.ivLength);
  const ciphertext = data.subarray(config.ivLength);

  return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, fek, ciphertext);
}
