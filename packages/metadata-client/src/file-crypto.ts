// Per-file key and fragment encryption, byte-compatible with discordrive
// (koncept §6.2: same fragment and encryption format, version number, key per file).
//
// discordrive (apps/frontend/src/lib/crypto.ts): random per-file root key
// (rootFEK), content key = HKDF-SHA256(rootFEK, info "ddv4-file-content-v1"),
// fragment = iv(12) || AES-256-GCM(ciphertext || tag). The manifest is JSON
// encrypted with the same content key. We reuse @ddv4/processing directly.

import {
  decryptChunk,
  decryptFileManifestPlaintext,
  deriveFileContentKey,
  encryptChunk,
  encryptFileManifestPlaintext,
  exportKey,
  fromBase64,
  generateRootFEK,
  toBase64,
} from "@ddv4/processing";
import type { ChunkManifest } from "@ddv4/sync-core";

/** Fragment format version (bumped on any change to the bytes on Discord). */
export const FRAGMENT_FORMAT_VERSION = 1;

export interface FileKey {
  /** Raw 32-byte root key, base64. Lives only inside encrypted payloads (manifestRef). */
  rawB64: string;
  contentKey: CryptoKey;
  rootKey: CryptoKey;
}

export async function newFileKey(): Promise<FileKey> {
  const rootKey = await generateRootFEK();
  return { rootKey, contentKey: await deriveFileContentKey(rootKey), rawB64: toBase64(await exportKey(rootKey)) };
}

export async function importFileKey(rawB64: string): Promise<FileKey> {
  const raw = fromBase64(rawB64);
  if (raw.byteLength !== 32) throw new Error("file key must be 32 bytes");
  const rootKey = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
    "wrapKey",
    "unwrapKey",
  ]);
  return { rootKey, contentKey: await deriveFileContentKey(rootKey), rawB64 };
}

export async function encryptFragment(key: FileKey, plaintext: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await encryptChunk(plaintext, key.contentKey));
}

export async function decryptFragment(key: FileKey, ciphertext: Uint8Array): Promise<Uint8Array> {
  const buf = ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer;
  return new Uint8Array(await decryptChunk(buf, key.contentKey));
}

export async function encryptManifest(key: FileKey, m: ChunkManifest): Promise<Uint8Array> {
  return encryptFileManifestPlaintext(m, key.rootKey);
}

export async function decryptManifest(key: FileKey, payload: Uint8Array): Promise<ChunkManifest> {
  return decryptFileManifestPlaintext<ChunkManifest>(payload, key.rootKey);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
