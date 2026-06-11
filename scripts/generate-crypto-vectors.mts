// Generates cross-platform crypto test vectors from @ddv4/processing.
// These vectors are the compatibility contract for non-TS clients (the Kotlin
// mobile gallery app must reproduce every output byte-for-byte).
//
// Run: npx tsx scripts/generate-crypto-vectors.mts
// Output: packages/processing/test-vectors/crypto-vectors.json

import { writeFile, mkdir } from "node:fs/promises";
import { argon2id } from "hash-wasm";

const enc = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

async function hkdfSha256(ikm: Uint8Array, info: string, lengthBits = 256): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode(info) },
    key,
    lengthBits,
  );
  return new Uint8Array(bits);
}

async function aesGcmEncryptPacked(keyBytes: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource);
  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.byteLength);
  return packed;
}

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

// --- Deterministic inputs ---

const password = "correct horse battery staple — zażółć gęślą jaźń";
const salt = fromHex("000102030405060708090a0b0c0d0e0f");
// Small memory so the Kotlin test suite stays fast; one vector uses prod params.
const fastParams = { memoryKB: 8192, iterations: 2, parallelism: 1 };
const prodParams = { memoryKB: 19456, iterations: 2, parallelism: 1 };

const ikm = fromHex("101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f");
const aesKey = fromHex("303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f".slice(0, 64));
const iv = fromHex("a0a1a2a3a4a5a6a7a8a9aaab");
const chunkPlaintext = enc.encode("DiscorDrive chunk plaintext \u{1F512} bytes");
const keyToWrap = fromHex("505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f");
const linkSecret = fromHex("707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f");
const rootFek = fromHex("909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeaf");
const metadataJson = JSON.stringify({ fileName: "zdjęcie 🏖️.jpg", mimeType: "image/jpeg", plaintextSize: 12345 });

async function argonHash(params: { memoryKB: number; iterations: number; parallelism: number }): Promise<Uint8Array> {
  const out = await argon2id({
    password,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKB,
    hashLength: 32,
    outputType: "binary",
  });
  return new Uint8Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

const fastHash = await argonHash(fastParams);
const prodHash = await argonHash(prodParams);

const metadataKey = await hkdfSha256(rootFek, "ddv4-file-metadata-v1");
const contentKey = await hkdfSha256(rootFek, "ddv4-file-content-v1");
const shareAuthKey = await hkdfSha256(linkSecret, "ddv4-files-share-auth-v1");

const vectors = {
  description:
    "DiscorDrive v4 cross-platform crypto test vectors. Generated from @ddv4/processing (hash-wasm Argon2id + WebCrypto). Any client implementation MUST reproduce these byte-for-byte.",
  generatedAt: new Date().toISOString(),

  argon2id: [
    {
      name: "fast-params",
      password,
      saltB64: toBase64(salt),
      ...fastParams,
      hashLength: 32,
      hashB64: toBase64(fastHash),
    },
    {
      name: "prod-params",
      password,
      saltB64: toBase64(salt),
      ...prodParams,
      hashLength: 32,
      hashB64: toBase64(prodHash),
    },
  ],

  serverAuthProof: {
    note: "HKDF-SHA256(ikm=argon2 hash, salt=empty, info='ddv4-server-auth-v1', 32B)",
    argon2HashB64: toBase64(fastHash),
    proofB64: toBase64(await hkdfSha256(fastHash, "ddv4-server-auth-v1")),
  },

  hkdf: [
    { info: "ddv4-file-content-v1", ikmB64: toBase64(rootFek), okmB64: toBase64(contentKey) },
    { info: "ddv4-file-metadata-v1", ikmB64: toBase64(rootFek), okmB64: toBase64(metadataKey) },
    { info: "ddv4-files-share-wrap-v1", ikmB64: toBase64(linkSecret), okmB64: toBase64(await hkdfSha256(linkSecret, "ddv4-files-share-wrap-v1")) },
    { info: "ddv4-files-share-auth-v1", ikmB64: toBase64(linkSecret), okmB64: toBase64(shareAuthKey) },
    { info: "generic", ikmB64: toBase64(ikm), okmB64: toBase64(await hkdfSha256(ikm, "generic")) },
  ],

  shareCapabilityToken: {
    note: "HMAC-SHA256(key=HKDF(linkSecret,'ddv4-files-share-auth-v1'), msg='ddv4-files-share-token-v1')",
    linkSecretB64: toBase64(linkSecret),
    tokenB64: toBase64(await hmacSha256(shareAuthKey, "ddv4-files-share-token-v1")),
  },

  aesGcmChunk: {
    note: "packed = IV(12B) || ciphertext || GCM tag(16B); AES-256-GCM, no AAD",
    keyB64: toBase64(aesKey),
    ivB64: toBase64(iv),
    plaintextB64: toBase64(chunkPlaintext),
    packedB64: toBase64(await aesGcmEncryptPacked(aesKey, iv, chunkPlaintext)),
  },

  wrapKey: {
    note: "wrapKey = AES-GCM(rawKeyBytes); packWrappedKey = IV || wrapped (same packing as chunks)",
    wrappingKeyB64: toBase64(aesKey),
    keyToWrapB64: toBase64(keyToWrap),
    ivB64: toBase64(iv),
    packedB64: toBase64(await aesGcmEncryptPacked(aesKey, iv, keyToWrap)),
  },

  fileMetadata: {
    note: "encryptFileMetadataPlaintext: AES-GCM(JSON bytes) under HKDF(rootFek,'ddv4-file-metadata-v1'), packed IV||ct||tag",
    rootFekB64: toBase64(rootFek),
    ivB64: toBase64(iv),
    plaintextJson: metadataJson,
    packedB64: toBase64(await aesGcmEncryptPacked(metadataKey, iv, enc.encode(metadataJson))),
  },

  fileManifest: {
    note: "encryptFileManifestPlaintext: AES-GCM(JSON bytes) under HKDF(rootFek,'ddv4-file-content-v1')",
    rootFekB64: toBase64(rootFek),
    ivB64: toBase64(iv),
    plaintextJson: JSON.stringify({ chunkSizeBytes: 8388608, chunks: [{ index: 0, blobId: "f1:chunk:0", ciphertextSizeBytes: 100 }] }),
    packedB64: toBase64(
      await aesGcmEncryptPacked(
        contentKey,
        iv,
        enc.encode(JSON.stringify({ chunkSizeBytes: 8388608, chunks: [{ index: 0, blobId: "f1:chunk:0", ciphertextSizeBytes: 100 }] })),
      ),
    ),
  },
};

await mkdir(new URL("../packages/processing/test-vectors/", import.meta.url), { recursive: true });
const outPath = new URL("../packages/processing/test-vectors/crypto-vectors.json", import.meta.url);
await writeFile(outPath, JSON.stringify(vectors, null, 2) + "\n");
console.log(`Wrote ${outPath.pathname}`);
