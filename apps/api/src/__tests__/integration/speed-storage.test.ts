// DiscorDrive v4 — Storage Speed Test (integracja LOCAL)
// Uruchomienie:
//   cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/speed-storage.test.ts
//
// Mierzy throughput zapisu i odczytu blobów dla różnych rozmiarów,
// w tym transfer równoległy i duże pliki (stress test).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { clearDiscordBlobStore } from "../../storage/discord-blobs.js";
import {
  ensureBlobRootDir,
  writeCiphertextBlob,
  readCiphertextBlob,
  sha256Ciphertext,
} from "../../storage/local-blobs.js";

// --- Config ---
const SIZES = [
  { name: "1 KB",    bytes: 1 << 10 },
  { name: "10 KB",   bytes: 10 << 10 },
  { name: "100 KB",  bytes: 100 << 10 },
  { name: "1 MB",    bytes: 1 << 20 },
  { name: "5 MB",    bytes: 5 << 20 },
  { name: "10 MB",   bytes: 10 << 20 },
];
const ROUNDS = 3;
const LARGE_SIZES = [
  { name: "20 MB",  bytes: 20 << 20 },
  { name: "50 MB",  bytes: 50 << 20 },
];
const CONCURRENT = 5; // ile równoległych transferów

// --- Helpers ---
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatMBps(bytes: number, ms: number): string {
  if (ms <= 0) return "∞";
  const mbps = (bytes / (1024 * 1024)) / (ms / 1000);
  return mbps.toFixed(2);
}

function formatBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

// --- Setup ---
let blobRootDir: string;

beforeEach(async () => {
  blobRootDir = await mkdtemp(path.join(os.tmpdir(), "ddv4-speed-"));
  const previous = process.env.DDV4_BLOB_ROOT_DIR;
  process.env.DDV4_BLOB_ROOT_DIR = blobRootDir;
  await clearDiscordBlobStore();
  (globalThis as any).__ddv4_speed_blobRootDir = blobRootDir;
  (globalThis as any).__ddv4_speed_prevBlobRootDir = previous;
});

afterEach(async () => {
  const dir: string | undefined = (globalThis as any).__ddv4_speed_blobRootDir;
  const prev: string | undefined = (globalThis as any).__ddv4_speed_prevBlobRootDir;
  if (dir) await rm(dir, { recursive: true, force: true });
  if (prev !== undefined) {
    process.env.DDV4_BLOB_ROOT_DIR = prev;
  } else {
    delete process.env.DDV4_BLOB_ROOT_DIR;
  }
  delete (globalThis as any).__ddv4_speed_blobRootDir;
  delete (globalThis as any).__ddv4_speed_prevBlobRootDir;
  await clearDiscordBlobStore();
});

// --- Core: Upload speed ---
describe("storage speed — UPLOAD (LOCAL)", () => {
  const userId = "speed-test-upload";

  for (const size of SIZES) {
    it(`${size.name} (${ROUNDS} rundy)`, async () => {
      const runtimes: number[] = [];

      for (let r = 0; r < ROUNDS; r++) {
        const blobId = `up-${size.name.replace(/\s/g, "")}-${r}-${Date.now()}`;
        const data = randomBytes(size.bytes);

        await ensureBlobRootDir();
        const start = performance.now();
        const storagePath = await writeCiphertextBlob(userId, blobId, data);
        const elapsed = performance.now() - start;
        runtimes.push(elapsed);

        const stat = await import("node:fs/promises").then(fs => fs.stat(storagePath));
        expect(stat.size).toBe(size.bytes);
      }

      const min = Math.min(...runtimes);
      const max = Math.max(...runtimes);
      const avg = runtimes.reduce((a, b) => a + b, 0) / runtimes.length;

      console.log(
        `📤 UPLOAD  ${size.name.padEnd(8)} | ` +
        `min=${min.toFixed(1)}ms  avg=${avg.toFixed(1)}ms  max=${max.toFixed(1)}ms | ` +
        `${formatMBps(size.bytes, avg)} MB/s`,
      );
    });
  }
});

// --- Core: Download speed ---
describe("storage speed — DOWNLOAD (LOCAL)", () => {
  const userId = "speed-test-download";

  for (const size of SIZES) {
    it(`${size.name} (${ROUNDS} rundy)`, async () => {
      const runtimes: number[] = [];

      for (let r = 0; r < ROUNDS; r++) {
        const blobId = `dl-${size.name.replace(/\s/g, "")}-${r}-${Date.now()}`;
        const data = randomBytes(size.bytes);

        await ensureBlobRootDir();
        await writeCiphertextBlob(userId, blobId, data);

        const start = performance.now();
        const read = await readCiphertextBlob(userId, blobId);
        const elapsed = performance.now() - start;
        runtimes.push(elapsed);

        expect(read.length).toBe(size.bytes);
        expect(sha256Hex(read)).toBe(sha256Hex(data));
      }

      const min = Math.min(...runtimes);
      const max = Math.max(...runtimes);
      const avg = runtimes.reduce((a, b) => a + b, 0) / runtimes.length;

      console.log(
        `📥 DOWNLOAD ${size.name.padEnd(6)} | ` +
        `min=${min.toFixed(1)}ms  avg=${avg.toFixed(1)}ms  max=${max.toFixed(1)}ms | ` +
        `${formatMBps(size.bytes, avg)} MB/s`,
      );
    });
  }
});

// --- Stress: Large files (20 MB, 50 MB) ---
describe("storage speed — LARGE FILES (stress test)", () => {
  const userId = "speed-test-large";
  const ROUNDS_LARGE = 2;

  for (const size of LARGE_SIZES) {
    it(`${size.name} upload (${ROUNDS_LARGE} rundy)`, { timeout: 60_000 }, async () => {
      const runtimes: number[] = [];

      for (let r = 0; r < ROUNDS_LARGE; r++) {
        const blobId = `large-up-${size.name.replace(/\s/g, "")}-${r}-${Date.now()}`;
        const data = randomBytes(size.bytes);

        await ensureBlobRootDir();
        const start = performance.now();
        const storagePath = await writeCiphertextBlob(userId, blobId, data);
        const elapsed = performance.now() - start;
        runtimes.push(elapsed);

        const stat = await import("node:fs/promises").then(fs => fs.stat(storagePath));
        expect(stat.size).toBe(size.bytes);
      }

      const avg = runtimes.reduce((a, b) => a + b, 0) / runtimes.length;
      console.log(
        `📤 LARGE UPLOAD  ${size.name.padEnd(8)} | avg=${avg.toFixed(1)}ms | ${formatMBps(size.bytes, avg)} MB/s`,
      );
    });

    it(`${size.name} download (${ROUNDS_LARGE} rundy)`, { timeout: 60_000 }, async () => {
      const runtimes: number[] = [];

      for (let r = 0; r < ROUNDS_LARGE; r++) {
        const blobId = `large-dl-${size.name.replace(/\s/g, "")}-${r}-${Date.now()}`;
        const data = randomBytes(size.bytes);

        await ensureBlobRootDir();
        await writeCiphertextBlob(userId, blobId, data);

        const start = performance.now();
        const read = await readCiphertextBlob(userId, blobId);
        const elapsed = performance.now() - start;
        runtimes.push(elapsed);

        expect(read.length).toBe(size.bytes);
        expect(sha256Hex(read)).toBe(sha256Hex(data));
      }

      const avg = runtimes.reduce((a, b) => a + b, 0) / runtimes.length;
      console.log(
        `📥 LARGE DOWNLOAD ${size.name.padEnd(6)} | avg=${avg.toFixed(1)}ms | ${formatMBps(size.bytes, avg)} MB/s`,
      );
    });
  }
});

// --- Concurrent transfer test ---
describe("storage speed — CONCURRENT (parallel transfers)", () => {
  const userId = "speed-test-concurrent";

  it(`${CONCURRENT} równoległe uploady (10 MB każdy)`, { timeout: 60_000 }, async () => {
    const blobIds: string[] = [];
    const dataArray: Uint8Array[] = [];

    for (let i = 0; i < CONCURRENT; i++) {
      blobIds.push(`concurrent-up-${i}-${Date.now()}`);
      dataArray.push(randomBytes(10 << 20)); // 10 MB each
    }

    await ensureBlobRootDir();
    const start = performance.now();

    await Promise.all(
      blobIds.map((blobId, i) => writeCiphertextBlob(userId, blobId, dataArray[i])),
    );

    const elapsed = performance.now() - start;
    const totalBytes = dataArray.reduce((sum, d) => sum + d.length, 0);

    console.log(
      `📤 CONCURRENT UPLOAD  ${CONCURRENT}×10 MB | total=${formatBytes(totalBytes)} in ${elapsed.toFixed(1)}ms | ${formatMBps(totalBytes, elapsed)} MB/s`,
    );
  });

  it(`${CONCURRENT} równoległe downloady (10 MB każdy)`, { timeout: 60_000 }, async () => {
    const blobIds: string[] = [];
    const dataArray: Uint8Array[] = [];

    for (let i = 0; i < CONCURRENT; i++) {
      const blobId = `concurrent-dl-${i}-${Date.now()}`;
      blobIds.push(blobId);
      const data = randomBytes(10 << 20);
      dataArray.push(data);
      await ensureBlobRootDir();
      await writeCiphertextBlob(userId, blobId, data);
    }

    const start = performance.now();

    const results = await Promise.all(
      blobIds.map((blobId, i) => readCiphertextBlob(userId, blobId)),
    );

    const elapsed = performance.now() - start;
    const totalBytes = results.reduce((sum, r) => sum + r.length, 0);

    // Weryfikacja integralności
    for (let i = 0; i < CONCURRENT; i++) {
      expect(sha256Hex(results[i])).toBe(sha256Hex(dataArray[i]));
    }

    console.log(
      `📥 CONCURRENT DOWNLOAD ${CONCURRENT}×10 MB | total=${formatBytes(totalBytes)} in ${elapsed.toFixed(1)}ms | ${formatMBps(totalBytes, elapsed)} MB/s`,
    );
  });
});