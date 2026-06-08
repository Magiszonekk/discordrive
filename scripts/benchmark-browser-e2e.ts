#!/usr/bin/env npx tsx
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { calculateChunkCount, chunkFileStream, hashBuffer, generateDomainKey } from "@ddv4/processing";
import type { FileChunkManifestPlaintext } from "@ddv4/types";
import {
  prepareFileUpload,
  buildEncryptedManifest,
  decryptManifest,
  encryptFileContentChunk,
  decryptFileContentChunk,
} from "../apps/frontend/src/lib/crypto.js";

const BASE_URL = process.env.DDC_TEST_URL ?? "http://localhost:3000";
const GRAPHQL = `${BASE_URL}/graphql`;
const CHUNK_SIZE = 8 * 1024 * 1024;
const CONCURRENCY = 4;
const TEST_FILE_SIZE_MB = parseInt(process.argv[2] ?? "360", 10);
const TEST_LOGIN = process.env.DDC_TEST_LOGIN ?? "Magiszonek";
const TEST_PASSWORD = process.env.DDC_TEST_PASSWORD ?? "speedtest123";

type BlobUploadResponse = {
  blobId: string;
  ciphertextSizeBytes: string;
  ciphertextHash?: string;
  storageKind: "LOCAL" | "DISCORD";
  storagePath: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
};

type UploadedBlobTransportInput = {
  blobId: string;
  storageKind: string;
  storagePath: string;
  ciphertextSizeBytes: string;
  ciphertextHash?: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
};

type AuthResponse = {
  token: string;
  user: {
    id: string;
    email: string;
    username?: string | null;
    crypto: {
      wrappedARKByPassword: string;
      wrappedARKByRecovery: string;
      argon2Params: {
        memoryKB: number;
        iterations: number;
        parallelism: number;
        saltB64: string;
      };
      lastPasswordChangeAt: string;
    };
  };
};

function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(2)} min`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)} s`;
  return `${ms.toFixed(0)} ms`;
}

function mbps(bytes: number, ms: number): number {
  return bytes / (1024 * 1024) / (ms / 1000);
}

function humanBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}, token?: string): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data!;
}

async function login(): Promise<AuthResponse> {
  const data = await gql<{ login: AuthResponse }>(
    `mutation($emailOrUsername: String!, $password: String!) {
      login(emailOrUsername: $emailOrUsername, password: $password) {
        token
        user {
          id
          email
          username
          crypto {
            wrappedARKByPassword
            wrappedARKByRecovery
            argon2Params { memoryKB iterations parallelism saltB64 }
            lastPasswordChangeAt
          }
        }
      }
    }`,
        { emailOrUsername: TEST_LOGIN, password: TEST_PASSWORD },
  );
  return data.login;
}

async function uploadBlob(blobId: string, data: ArrayBuffer, token: string, extraHeaders: Record<string, string> = {}): Promise<BlobUploadResponse> {
  const res = await fetch(`${BASE_URL}/api/blob/${blobId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      ...extraHeaders,
    },
    body: data,
  });
  if (!res.ok) {
    throw new Error(`Blob upload failed ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<BlobUploadResponse>;
}

async function fetchBlob(blobId: string, token: string): Promise<ArrayBuffer> {
  const res = await fetch(`${BASE_URL}/api/blob/${blobId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Blob fetch failed ${res.status}: ${await res.text()}`);
  return res.arrayBuffer();
}

async function main() {
  const fileSize = TEST_FILE_SIZE_MB * 1024 * 1024;
  console.log(`\n=== DiscordDrive browser-like E2E benchmark ===`);
  console.log(`Server:      ${BASE_URL}`);
  console.log(`File size:   ${humanBytes(fileSize)}`);
  console.log(`Chunk size:  ${humanBytes(CHUNK_SIZE)}`);
  console.log(`Concurrency: ${CONCURRENCY}`);

  const auth = await login();
  const token = auth.token;
  const filesKey = await generateDomainKey();

  console.log(`\n1) Generating test payload...`);
  const genStart = performance.now();
  const payload = randomBytes(fileSize);
  const payloadBuffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  const originalHash = await hashBuffer(payloadBuffer);
  const chunkCount = calculateChunkCount(fileSize, CHUNK_SIZE);
  const file = new File([payload], `browser-like-${Date.now()}.bin`, { type: "application/octet-stream" });
  const genMs = performance.now() - genStart;
  console.log(`   generated in ${fmtMs(genMs)}, sha256=${originalHash.slice(0, 24)}..., chunks=${chunkCount}`);

  console.log(`\n2) Frontend crypto prepare + initUpload...`);
  const prepStart = performance.now();
  const prepared = await prepareFileUpload(filesKey, {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    plaintextSizeBytes: file.size,
  });
  const init = await gql<{ initUpload: { fileId: string; status: string } }>(
    `mutation($parentFolderId: ID, $name: String, $mimeType: String, $wrappedFEK: String!, $totalCiphertextBytes: String!, $chunkCount: Int!) {
      initUpload(parentFolderId: $parentFolderId, name: $name, mimeType: $mimeType, wrappedFEK: $wrappedFEK, totalCiphertextBytes: $totalCiphertextBytes, chunkCount: $chunkCount) {
        fileId
        status
      }
    }`,
    {
      parentFolderId: null,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      wrappedFEK: prepared.wrappedFEK,
      totalCiphertextBytes: String(file.size),
      chunkCount,
    },
    token,
  );
  const fileId = init.initUpload.fileId;
  const prepMs = performance.now() - prepStart;
  console.log(`   fileId=${fileId} in ${fmtMs(prepMs)}`);

  console.log(`\n3) Browser-like chunked encrypt+upload...`);
  const plaintextChunks: Array<{ index: number; data: Uint8Array }> = [];
  for await (const chunk of chunkFileStream(file, CHUNK_SIZE)) plaintextChunks.push(chunk);

  const manifest: FileChunkManifestPlaintext = {
    schemaVersion: 1,
    chunkSizeBytes: CHUNK_SIZE,
    chunks: [],
  };

  const uploadedBlobRecords: UploadedBlobTransportInput[] = [];
  const chunkEncryptTimes: number[] = [];
  const chunkRequestTimes: number[] = [];
  const uploadStart = performance.now();
  let uploadedBytes = 0;

  const uploadOneChunk = async (chunk: { index: number; data: Uint8Array }) => {
    const chunkBuffer = chunk.data.buffer.slice(chunk.data.byteOffset, chunk.data.byteOffset + chunk.data.byteLength) as ArrayBuffer;
    const encryptStart = performance.now();
    const ciphertext = await encryptFileContentChunk(prepared.rootFek, chunkBuffer);
    const encryptMs = performance.now() - encryptStart;
    const ciphertextBuffer = ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer;
    const blobId = `${fileId}:chunk:${chunk.index}`;
    const requestStart = performance.now();
    const result = await uploadBlob(blobId, ciphertextBuffer, token, {
      "X-Upload-Id": `bench-${Date.now()}`,
      "X-Chunk-Index": String(chunk.index),
      "X-Chunk-Count": String(chunkCount),
      "X-Client-Timestamp": new Date().toISOString(),
    });
    const requestMs = performance.now() - requestStart;

    manifest.chunks.push({
      index: chunk.index,
      blobId,
      ciphertextSizeBytes: ciphertext.byteLength,
    });
    uploadedBlobRecords.push({
      blobId: result.blobId,
      ciphertextSizeBytes: result.ciphertextSizeBytes,
      ciphertextHash: result.ciphertextHash,
      storageKind: result.storageKind,
      storagePath: result.storagePath,
      discordMessageId: result.discordMessageId,
      discordChannelId: result.discordChannelId,
      webhookId: result.webhookId,
    });
    uploadedBytes += chunk.data.byteLength;
    chunkEncryptTimes.push(encryptMs);
    chunkRequestTimes.push(requestMs);
  };

  for (let i = 0; i < plaintextChunks.length; i += CONCURRENCY) {
    const batch = plaintextChunks.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(uploadOneChunk));
    const elapsed = performance.now() - uploadStart;
    const done = Math.min(i + CONCURRENCY, plaintextChunks.length);
    process.stdout.write(`\r   chunks ${done}/${plaintextChunks.length} (${((done / plaintextChunks.length) * 100).toFixed(0)}%) @ ${mbps(uploadedBytes, elapsed).toFixed(2)} MB/s   `);
  }
  process.stdout.write("\n");
  const uploadMs = performance.now() - uploadStart;
  console.log(`   upload complete in ${fmtMs(uploadMs)} @ ${mbps(file.size, uploadMs).toFixed(2)} MB/s`);

  console.log(`\n4) Manifest upload + commitManifest(blobs)...`);
  const commitStart = performance.now();
  const encryptedManifest = await buildEncryptedManifest(prepared.rootFek, manifest);
  const manifestBlobId = `${fileId}:manifest`;
  const manifestBuffer = encryptedManifest.buffer.slice(encryptedManifest.byteOffset, encryptedManifest.byteOffset + encryptedManifest.byteLength) as ArrayBuffer;
  const manifestResult = await uploadBlob(manifestBlobId, manifestBuffer, token, {
    "X-Upload-Id": `bench-${Date.now()}`,
    "X-Chunk-Index": "manifest",
    "X-Chunk-Count": String(chunkCount),
    "X-Client-Timestamp": new Date().toISOString(),
  });
  uploadedBlobRecords.push({
    blobId: manifestResult.blobId,
    ciphertextSizeBytes: manifestResult.ciphertextSizeBytes,
    ciphertextHash: manifestResult.ciphertextHash,
    storageKind: manifestResult.storageKind,
    storagePath: manifestResult.storagePath,
    discordMessageId: manifestResult.discordMessageId,
    discordChannelId: manifestResult.discordChannelId,
    webhookId: manifestResult.webhookId,
  });

  await gql<{ commitManifest: { success: boolean } }>(
    `mutation($fileId: ID!, $manifestBlobId: String!, $totalCiphertextBytes: String!, $chunkCount: Int!, $blobs: [UploadedBlobTransportInput!]!) {
      commitManifest(fileId: $fileId, manifestBlobId: $manifestBlobId, totalCiphertextBytes: $totalCiphertextBytes, chunkCount: $chunkCount, blobs: $blobs) {
        success
      }
    }`,
    {
      fileId,
      manifestBlobId,
      totalCiphertextBytes: String(file.size),
      chunkCount,
      blobs: uploadedBlobRecords,
    },
    token,
  );
  const commitMs = performance.now() - commitStart;
  console.log(`   commit complete in ${fmtMs(commitMs)}`);

  console.log(`\n5) Browser-like download + decrypt + verify...`);
  const dlStart = performance.now();
  const manifestCipher = await fetchBlob(manifestBlobId, token);
  const manifestPlain = await decryptManifest(prepared.rootFek, Buffer.from(manifestCipher).toString("base64"));
  const downloadedChunks: Uint8Array[] = [];
  for (const chunkMeta of [...manifestPlain.chunks].sort((a, b) => a.index - b.index)) {
    const ciphertext = new Uint8Array(await fetchBlob(chunkMeta.blobId, token));
    const plaintext = await decryptFileContentChunk(prepared.rootFek, ciphertext);
    downloadedChunks.push(new Uint8Array(plaintext));
  }
  const totalDownloaded = downloadedChunks.reduce((sum, c) => sum + c.byteLength, 0);
  const reassembled = new Uint8Array(totalDownloaded);
  let offset = 0;
  for (const chunk of downloadedChunks) {
    reassembled.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const downloadHash = await hashBuffer(reassembled.buffer.slice(reassembled.byteOffset, reassembled.byteOffset + reassembled.byteLength) as ArrayBuffer);
  const dlMs = performance.now() - dlStart;
  const hashOk = downloadHash === originalHash;
  console.log(`   download+decrypt in ${fmtMs(dlMs)} @ ${mbps(totalDownloaded, dlMs).toFixed(2)} MB/s`);
  console.log(`   hash verify: ${hashOk ? "PASS" : "FAIL"}`);
  if (!hashOk) throw new Error(`Hash mismatch: ${downloadHash} != ${originalHash}`);

  console.log(`\n6) Cleanup...`);
  const deleteStart = performance.now();
  await gql(`mutation($fileId: ID!) { deleteFile(fileId: $fileId) }`, { fileId }, token);
  const deleteMs = performance.now() - deleteStart;
  console.log(`   deleted in ${fmtMs(deleteMs)}`);

  const totalUploadPathMs = prepMs + uploadMs + commitMs;
  console.log(`\n=== SUMMARY ===`);
  console.log(`prep+init:               ${fmtMs(prepMs)}`);
  console.log(`browser-like upload:     ${fmtMs(uploadMs)} @ ${mbps(file.size, uploadMs).toFixed(2)} MB/s`);
  console.log(`manifest+commit:         ${fmtMs(commitMs)}`);
  console.log(`UPLOAD PATH TOTAL:       ${fmtMs(totalUploadPathMs)} @ ${mbps(file.size, totalUploadPathMs).toFixed(2)} MB/s`);
  console.log(`download+decrypt+verify: ${fmtMs(dlMs)} @ ${mbps(file.size, dlMs).toFixed(2)} MB/s`);
  console.log(`delete:                  ${fmtMs(deleteMs)}`);
  console.log(`chunk encrypt avg:       ${(chunkEncryptTimes.reduce((a, b) => a + b, 0) / chunkEncryptTimes.length).toFixed(2)} ms`);
  console.log(`chunk request avg:       ${(chunkRequestTimes.reduce((a, b) => a + b, 0) / chunkRequestTimes.length).toFixed(2)} ms`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
