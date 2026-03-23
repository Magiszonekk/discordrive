// DiscorDrive v4 — Crypto orchestrator (wraps @ddv4/processing)

import {
  deriveKEK,
  generateMasterKey,
  generateFEK,
  wrapKey,
  unwrapKey,
  generateSalt,
  toBase64,
  fromBase64,
} from "@ddv4/processing";

export async function registerCrypto(password: string) {
  const salt = generateSalt();
  const kek = await deriveKEK(password, salt);
  const masterKey = await generateMasterKey();
  const wrapped = await wrapKey(masterKey, kek);

  return {
    kekSalt: toBase64(salt),
    wrapIv: toBase64(wrapped.iv),
    encryptedMasterKey: toBase64(wrapped.data),
    masterKey,
  };
}

export async function loginCrypto(
  password: string,
  kekSalt: string,
  wrapIv: string,
  encryptedMasterKey: string,
): Promise<CryptoKey> {
  const salt = fromBase64(kekSalt);
  const kek = await deriveKEK(password, salt);
  const iv = fromBase64(wrapIv);
  const wrapped = fromBase64(encryptedMasterKey);

  return unwrapKey(wrapped.buffer as ArrayBuffer, kek, iv, ["wrapKey", "unwrapKey"]);
}

export async function prepareFileUpload(masterKey: CryptoKey) {
  const fek = await generateFEK();
  const wrapped = await wrapKey(fek, masterKey);

  return {
    fek,
    encryptedFEK: toBase64(wrapped.data),
    fekIv: toBase64(wrapped.iv),
  };
}

export async function unwrapFEK(
  masterKey: CryptoKey,
  encryptedFEK: string,
  fekIv: string,
): Promise<CryptoKey> {
  const wrapped = fromBase64(encryptedFEK);
  const iv = fromBase64(fekIv);
  return unwrapKey(wrapped.buffer as ArrayBuffer, masterKey, iv, ["encrypt", "decrypt"]);
}

export async function prepareShareLink(fek: CryptoKey) {
  const shareKeyRaw = generateSalt(32); // 256-bit share key
  const shareKey = await crypto.subtle.importKey(
    "raw",
    shareKeyRaw.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    true,
    ["wrapKey", "unwrapKey"],
  );

  const wrapped = await wrapKey(fek, shareKey);

  return {
    shareKey: toBase64(shareKeyRaw),
    wrappedFEK: toBase64(wrapped.data),
    wrapIv: toBase64(wrapped.iv),
  };
}

export async function unwrapSharedFEK(
  shareKeyBase64: string,
  wrappedFEK: string,
  wrapIv: string,
): Promise<CryptoKey> {
  const shareKeyRaw = fromBase64(shareKeyBase64);
  const shareKey = await crypto.subtle.importKey(
    "raw",
    shareKeyRaw.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["unwrapKey"],
  );

  const wrapped = fromBase64(wrappedFEK);
  const iv = fromBase64(wrapIv);
  return unwrapKey(wrapped.buffer as ArrayBuffer, shareKey, iv, ["encrypt", "decrypt"]);
}
