// DiscorDrive v4 — Crypto orchestrator for secure files v2

import {
  generateSalt,
  toBase64,
  fromBase64,
  generateARK,
  generateDomainKey,
  generateRootFEK,
  wrapARKWithPassword,
  unwrapARKWithPassword,
  wrapDomainKey,
  unwrapDomainKey,
  wrapKey,
  unwrapKey,
  deriveLoginMaterial,
  deriveApiKeyWrapKey,
  deriveShareWrapKey,
  deriveShareAuthKey,
  deriveShareCapabilityToken,
  encryptFileMetadataPlaintext,
  encryptFileManifestPlaintext,
  decryptFileManifestPlaintext,
  deriveFileContentKey,
  encryptChunk,
  decryptChunk,
} from "@ddv4/processing";
import type { FileChunkManifestPlaintext } from "@ddv4/types";

export async function registerCrypto(password: string) {
  const ark = await generateARK();
  const filesKey = await generateDomainKey();
  const rootFek = await generateRootFEK();

  const salt = generateSalt();
  const params = {
    memoryKB: 19456,
    iterations: 2,
    parallelism: 1,
    saltB64: toBase64(salt),
  };

  // Single Argon2 run — derives both the ARK-wrapping key and the server auth proof
  const { arkWrapKey, serverAuthProof } = await deriveLoginMaterial(password, params);

  const wrappedArkData = await wrapKey(ark, arkWrapKey);
  const wrappedFilesKey = await wrapDomainKey(filesKey, ark);
  const wrappedRootFek = await wrapKey(rootFek, filesKey);

  return {
    wrappedARKByPassword: toBase64(packWrappedKey(wrappedArkData.data, wrappedArkData.iv)),
    wrappedARKByRecovery: toBase64(packWrappedKey(wrappedArkData.data, wrappedArkData.iv)),
    argon2Params: params,
    serverAuthProof: toBase64(serverAuthProof),
    ark,
    filesKey,
    wrappedFilesKey: toBase64(wrappedFilesKey.data),
    wrappedFilesKeyIv: toBase64(wrappedFilesKey.iv),
    wrappedFEK: toBase64(wrappedRootFek.data),
    wrappedFEKIv: toBase64(wrappedRootFek.iv),
    rootFek,
  };
}

export async function loginCrypto(
  password: string,
  wrappedARKByPassword: string,
  argon2Params: { memoryKB: number; iterations: number; parallelism: number; saltB64: string },
  wrappedFilesKey?: string,
  wrappedFilesKeyIv?: string,
): Promise<{ ark: CryptoKey; filesKey: CryptoKey | null }> {
  const { data: arkData, iv: arkIv } = unpackWrappedKey(fromBase64(wrappedARKByPassword));
  const ark = await unwrapARKWithPassword(arkData, arkIv, password, argon2Params);

  if (!wrappedFilesKey || !wrappedFilesKeyIv) {
    return { ark, filesKey: null };
  }

  const filesKey = await unwrapDomainKey(
    fromBase64(wrappedFilesKey).buffer as ArrayBuffer,
    fromBase64(wrappedFilesKeyIv),
    ark,
  );

  return { ark, filesKey };
}

// Unwraps the ARK using a pre-computed arkWrapKey from deriveLoginMaterial,
// avoiding a second Argon2 run in the login flow.
export async function loginCryptoFromKey(
  arkWrapKey: CryptoKey,
  wrappedARKByPassword: string,
  wrappedFilesKey?: string,
  wrappedFilesKeyIv?: string,
): Promise<{ ark: CryptoKey; filesKey: CryptoKey | null }> {
  const { data: arkData, iv: arkIv } = unpackWrappedKey(fromBase64(wrappedARKByPassword));
  const ark = await unwrapKey(arkData, arkWrapKey, arkIv, ["wrapKey", "unwrapKey"]);

  if (!wrappedFilesKey || !wrappedFilesKeyIv) {
    return { ark, filesKey: null };
  }

  const filesKey = await unwrapDomainKey(
    fromBase64(wrappedFilesKey).buffer as ArrayBuffer,
    fromBase64(wrappedFilesKeyIv),
    ark,
  );

  return { ark, filesKey };
}

export async function prepareFileUpload(filesKey: CryptoKey, metadata: {
  fileName: string;
  mimeType: string;
  plaintextSizeBytes: number;
}) {
  const rootFek = await generateRootFEK();
  const wrapped = await wrapKey(rootFek, filesKey);
  const encryptedMetadata = await encryptFileMetadataPlaintext(
    {
      schemaVersion: 1,
      fileName: metadata.fileName,
      mimeType: metadata.mimeType,
      plaintextSizeBytes: metadata.plaintextSizeBytes,
      tags: [],
      removedTags: [],
      favorite: false,
      hidden: false,
      scalarLWW: {},
    },
    rootFek,
  );

  return {
    rootFek,
    wrappedFEK: toBase64(packWrappedKey(wrapped.data, wrapped.iv)),
    encryptedMetadata,
    encryptedName: await encryptMeta(rootFek, metadata.fileName),
    encryptedMimeType: await encryptMeta(rootFek, metadata.mimeType),
  };
}

export async function buildEncryptedManifest(rootFek: CryptoKey, manifest: FileChunkManifestPlaintext) {
  return encryptFileManifestPlaintext(manifest, rootFek);
}

export async function decryptManifest(rootFek: CryptoKey, manifestB64: string): Promise<FileChunkManifestPlaintext> {
  return decryptFileManifestPlaintext<FileChunkManifestPlaintext>(fromBase64(manifestB64), rootFek);
}

export async function unwrapRootFek(filesKey: CryptoKey, wrappedFEK: string, wrappedFEKIv?: string | null): Promise<CryptoKey> {
  const wrappedBytes = fromBase64(wrappedFEK);

  if (wrappedFEKIv) {
    return unwrapKey(
      wrappedBytes.buffer.slice(wrappedBytes.byteOffset, wrappedBytes.byteOffset + wrappedBytes.byteLength) as ArrayBuffer,
      filesKey,
      fromBase64(wrappedFEKIv),
      ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
    );
  }

  const { data, iv } = unpackWrappedKey(wrappedBytes);
  return unwrapKey(data, filesKey, iv, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
}

export async function encryptFileContentChunk(rootFek: CryptoKey, plaintext: ArrayBuffer): Promise<Uint8Array> {
  const contentKey = await deriveFileContentKey(rootFek);
  return new Uint8Array(await encryptChunk(plaintext, contentKey));
}

export async function decryptFileContentChunk(rootFek: CryptoKey, ciphertext: Uint8Array): Promise<ArrayBuffer> {
  const contentKey = await deriveFileContentKey(rootFek);
  const buffer = ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer;
  return decryptChunk(buffer, contentKey);
}

export { toBase64, fromBase64, generateSalt, wrapARKWithPassword, wrapKey, deriveLoginMaterial };

// === Folder key helpers ===

export async function generateFolderKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function unwrapFolderKey(wrappedB64: string, filesKey: CryptoKey): Promise<CryptoKey> {
  const { data, iv } = unpackWrappedKey(fromBase64(wrappedB64));
  return unwrapKey(data, filesKey, iv, ["encrypt", "decrypt"]);
}

export async function encryptFolderBody(body: { name: string }, key: CryptoKey): Promise<string> {
  return encryptMeta(key, JSON.stringify(body));
}

export async function decryptFolderBody(encryptedB64: string, key: CryptoKey): Promise<{ name: string }> {
  const json = await decryptMeta(key, encryptedB64);
  return JSON.parse(json) as { name: string };
}

// === API keys ===

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mints an API key entirely in the browser.
 *
 * Both halves are generated here and only `authPart` plus the wrapped ARK are
 * sent to the server — `cryptoPart` exists solely inside the returned secret.
 * Losing that secret means the key can never decrypt again, which is the point:
 * the server is not able to reconstruct it on the operator's behalf.
 */
export async function prepareApiKey(ark: CryptoKey): Promise<{
  secret: string;
  authPart: string;
  wrappedARKByKey: string;
  wrappedARKIv: string;
}> {
  const authPart = toBase64Url(generateSalt(32));
  const cryptoPartBytes = generateSalt(32);
  const wrapped = await wrapKey(ark, await deriveApiKeyWrapKey(cryptoPartBytes));

  return {
    secret: `ddv4_${authPart}.${toBase64Url(cryptoPartBytes)}`,
    authPart,
    wrappedARKByKey: toBase64(new Uint8Array(wrapped.data)),
    wrappedARKIv: toBase64(wrapped.iv),
  };
}

export function packWrappedKey(data: ArrayBuffer, iv: Uint8Array): Uint8Array {
  const packed = new Uint8Array(iv.byteLength + data.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(data), iv.byteLength);
  return packed;
}

export function unpackWrappedKey(packed: Uint8Array): { data: ArrayBuffer; iv: Uint8Array } {
  const ivLength = 12;
  if (packed.byteLength <= ivLength) {
    throw new Error("Packed wrapped key is too short");
  }

  return {
    iv: packed.slice(0, ivLength),
    data: packed.buffer.slice(packed.byteOffset + ivLength, packed.byteOffset + packed.byteLength) as ArrayBuffer,
  };
}

export async function wrapKeyPacked(keyToWrap: CryptoKey, wrappingKey: CryptoKey): Promise<string> {
  const wrapped = await wrapKey(keyToWrap, wrappingKey);
  return toBase64(packWrappedKey(wrapped.data, wrapped.iv));
}

export async function unwrapKeyPacked(wrappedB64: string, unwrappingKey: CryptoKey, usages: KeyUsage[]): Promise<CryptoKey> {
  const { data, iv } = unpackWrappedKey(fromBase64(wrappedB64));
  return unwrapKey(data, unwrappingKey, iv, usages);
}

export async function prepareShareLink(rootFek: CryptoKey, fileId: string) {
  const linkSecret = generateSalt(32);
  const shareWrapKey = await deriveShareWrapKey(linkSecret);
  const authKey = await deriveShareAuthKey(linkSecret);
  const capabilityToken = await deriveShareCapabilityToken(authKey);
  const shareKey = await generateDomainKey();

  return {
    fileId,
    linkSecret: toBase64(linkSecret),
    capabilityToken: toBase64(capabilityToken),
    wrappedAKShare: await wrapKeyPacked(shareKey, shareWrapKey),
    wrappedFEK: await wrapKeyPacked(rootFek, shareKey),
  };
}

export async function encryptMeta(fek: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, fek, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), 12);
  return toBase64(combined);
}

export async function decryptMeta(fek: CryptoKey, ciphertext: string): Promise<string> {
  const bytes = fromBase64(ciphertext);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, fek, ct);
  return new TextDecoder().decode(pt);
}
