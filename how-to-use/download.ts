#!/usr/bin/env npx tsx
// DiscorDrive v4 — Download and decrypt a file from DiscorDrive storage
//
// Usage:
//   npx tsx how-to-use/download.ts <fileId> <encryptedFEK> <fekIv> [output-path]
//
// Required env vars (see .env):
//   DISCORDRIVE_URL=http://localhost:3000
//   API_KEY=your-api-key
//   MASTER_KEY=<base64>

import { createWriteStream, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fromBase64, unwrapKey, decryptChunk } from "@ddv4/processing";
import { gql, downloadChunk, getMasterKey, runPool, BASE } from "./_client.js";

const [fileId, encryptedFEK, fekIv, outputArg] = process.argv.slice(2);

if (!fileId || !encryptedFEK || !fekIv) {
  console.error("Usage: npx tsx how-to-use/download.ts <fileId> <encryptedFEK> <fekIv> [output-path]");
  process.exit(1);
}

const GET_FILE = `
  query($fileId: ID!) {
    file(fileId: $fileId) {
      name
      mimeType
      size
      chunkCount
      sha256
    }
  }
`;

const CONCURRENCY = 10;

async function main() {
  const masterKey = await getMasterKey();

  // Fetch file metadata from API
  const { file } = await gql<{
    file: {
      name: string;
      mimeType: string;
      size: string;
      chunkCount: number;
      sha256: string | null;
    } | null;
  }>(GET_FILE, { fileId });

  if (!file) {
    console.error(`File not found: ${fileId}`);
    process.exit(1);
  }

  const outputPath = outputArg ?? file.name;
  const { chunkCount, sha256 } = file;

  console.log(`\nDownloading: ${file.name}`);
  console.log(`  Size:    ${(Number(file.size) / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Chunks:  ${chunkCount}`);
  console.log(`  Output:  ${outputPath}`);
  console.log(`  API:     ${BASE}\n`);

  // Unwrap the FEK using the Master Key
  const wrappedBytes = fromBase64(encryptedFEK);
  const wrappedBuf = wrappedBytes.buffer.slice(
    wrappedBytes.byteOffset,
    wrappedBytes.byteOffset + wrappedBytes.byteLength,
  ) as ArrayBuffer;
  const ivBytes = fromBase64(fekIv);

  const fek = await unwrapKey(wrappedBuf, masterKey, ivBytes, ["decrypt"]);

  // Download and decrypt all chunks concurrently, store in order
  const plainChunks = new Array<ArrayBuffer>(chunkCount);
  let downloaded = 0;

  const tasks = Array.from({ length: chunkCount }, (_, i) => async () => {
    const encrypted = await downloadChunk(fileId, i);
    plainChunks[i] = await decryptChunk(encrypted, fek);
    downloaded++;
    process.stdout.write(`\r  Downloading: ${downloaded}/${chunkCount} chunks`);
  });

  await runPool(tasks, CONCURRENCY);
  process.stdout.write("\n");

  // Write decrypted chunks to output file
  const out = createWriteStream(outputPath);
  for (const chunk of plainChunks) {
    await new Promise<void>((resolve, reject) => {
      const ok = out.write(Buffer.from(chunk));
      if (ok) resolve();
      else out.once("drain", resolve);
      out.once("error", reject);
    });
  }
  await new Promise<void>((resolve, reject) => {
    out.end();
    out.once("finish", resolve);
    out.once("error", reject);
  });

  // Verify SHA-256 integrity (if server has it)
  if (sha256) {
    const hasher = createHash("sha256");
    const rs = createReadStream(outputPath);
    for await (const chunk of rs) hasher.update(chunk);
    const actual = hasher.digest("hex");
    const ok = actual === sha256;
    console.log(`\n  Integrity: ${ok ? "✓ PASS" : "✗ FAIL — file may be corrupted"}`);
    if (!ok) process.exit(1);
  } else {
    console.log("\n  Integrity: skipped (no sha256 on record)");
  }

  console.log(`  Saved to:  ${outputPath}\n`);
}

main().catch((err) => {
  console.error("\nDownload failed:", err.message);
  process.exit(1);
});
