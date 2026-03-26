#!/usr/bin/env npx tsx
// DiscorDrive v4 — Upload a local file to DiscorDrive storage
//
// Usage:
//   npx tsx how-to-use/upload.ts <path/to/file>
//
// Required env vars (see .env):
//   DISCORDRIVE_URL=http://localhost:3000
//   API_KEY=your-api-key
//   MASTER_KEY=<base64>   ← generated on first run if missing

import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { config } from "@ddv4/config";
import { generateFEK, wrapKey, encryptChunk, toBase64 } from "@ddv4/processing";
import { gql, uploadChunk, getMasterKey, runPool, BASE } from "./_client.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npx tsx how-to-use/upload.ts <path/to/file>");
  process.exit(1);
}

const CONCURRENCY = 10;

const INIT_UPLOAD = `
  mutation(
    $name: String!, $mimeType: String!, $size: String!,
    $chunkSize: Int!, $chunkCount: Int!,
    $encryptedFEK: String!, $fekIv: String!
  ) {
    initUpload(
      name: $name, mimeType: $mimeType, size: $size,
      chunkSize: $chunkSize, chunkCount: $chunkCount,
      encryptedFEK: $encryptedFEK, fekIv: $fekIv
    ) { fileId }
  }
`;

const FINALIZE_UPLOAD = `
  mutation($fileId: ID!, $sha256: String!) {
    finalizeUpload(fileId: $fileId, sha256: $sha256) {
      success
      missingChunks
    }
  }
`;

const MIME_MAP: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

async function main() {
  const masterKey = await getMasterKey();

  // Generate a fresh FEK for this file, wrap it with the Master Key
  const fek = await generateFEK();
  const wrapped = await wrapKey(fek, masterKey);
  const encryptedFEK = toBase64(wrapped.data);
  const fekIv = toBase64(wrapped.iv);

  // File metadata
  const info = await stat(filePath);
  const totalBytes = info.size;
  const chunkSize = config.defaultChunkSize;
  const chunkCount = Math.ceil(totalBytes / chunkSize);
  const name = basename(filePath);
  const mimeType = MIME_MAP[extname(name).toLowerCase()] ?? "application/octet-stream";

  console.log(`\nUploading: ${name}`);
  console.log(`  Size:       ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Chunks:     ${chunkCount} × ${(chunkSize / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`  API:        ${BASE}\n`);

  // Hash the plaintext file before uploading (streaming — no extra RAM)
  const hasher = createHash("sha256");
  const readStream = createReadStream(filePath);
  for await (const chunk of readStream) hasher.update(chunk);
  const sha256 = hasher.digest("hex");

  // Init upload — register the file in the database
  const { initUpload } = await gql<{ initUpload: { fileId: string } }>(INIT_UPLOAD, {
    name, mimeType,
    size: totalBytes.toString(),
    chunkSize, chunkCount,
    encryptedFEK, fekIv,
  });
  const fileId = initUpload.fileId;
  console.log(`  File ID:    ${fileId}`);

  // Encrypt and upload chunks concurrently
  const fd = await open(filePath, "r");
  let uploaded = 0;

  const tasks = Array.from({ length: chunkCount }, (_, i) => async () => {
    const offset = i * chunkSize;
    const size = Math.min(chunkSize, totalBytes - offset);

    const buf = Buffer.allocUnsafe(size);
    await fd.read(buf, 0, size, offset);

    // Buffer.buffer may be a shared ArrayBuffer — slice to get an owned copy
    const plain = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const encrypted = await encryptChunk(plain, fek);

    await uploadChunk(fileId, i, encrypted);
    uploaded++;
    process.stdout.write(`\r  Uploading:  ${uploaded}/${chunkCount} chunks`);
  });

  await runPool(tasks, CONCURRENCY);
  await fd.close();
  process.stdout.write("\n");

  // Finalize — server verifies all chunks are present
  const { finalizeUpload } = await gql<{
    finalizeUpload: { success: boolean; missingChunks?: number[] };
  }>(FINALIZE_UPLOAD, { fileId, sha256 });

  if (!finalizeUpload.success) {
    console.error(`\n  FAILED: missing chunks: ${finalizeUpload.missingChunks?.join(", ")}`);
    process.exit(1);
  }

  console.log(`\n  Done.\n`);
  console.log("  ┌─────────────────────────────────────────────────────────┐");
  console.log(`  │  fileId:       ${fileId}`);
  console.log(`  │  encryptedFEK: ${encryptedFEK.slice(0, 40)}...`);
  console.log(`  │  fekIv:        ${fekIv}`);
  console.log("  │");
  console.log("  │  Save these — you need them to download or share the file.");
  console.log("  └─────────────────────────────────────────────────────────┘\n");
  console.log(`  Full encryptedFEK: ${encryptedFEK}`);
  console.log(`  Full fekIv:        ${fekIv}\n`);
}

main().catch((err) => {
  console.error("\nUpload failed:", err.message);
  process.exit(1);
});
