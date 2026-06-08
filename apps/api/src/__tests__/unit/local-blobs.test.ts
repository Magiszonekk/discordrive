import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const ENV_VAR = "DDV4_BLOB_ROOT_DIR";

async function withTempBlobRoot<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ddv4-blobs-"));
  const previous = process.env[ENV_VAR];
  process.env[ENV_VAR] = rootDir;

  try {
    return await fn(rootDir);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = previous;
    }
    await rm(rootDir, { recursive: true, force: true });
  }
}

describe("local blob storage helpers", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("writes, reads, stats, and hashes ciphertext blobs", async () => {
    await withTempBlobRoot(async (rootDir) => {
      const { buildBlobPath, ensureBlobRootDir, getBlobRootDir, readCiphertextBlob, sha256Ciphertext, statCiphertextBlob, writeCiphertextBlob } =
        await import("../../storage/local-blobs.js");

      expect(getBlobRootDir()).toBe(path.resolve(rootDir));
      await expect(ensureBlobRootDir()).resolves.toBe(path.resolve(rootDir));

      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const expectedHash = "74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0";

      expect(sha256Ciphertext(bytes)).toBe(expectedHash);

      const blobPath = await writeCiphertextBlob("user-123", "blob-456", bytes);
      expect(blobPath).toBe(buildBlobPath("user-123", "blob-456"));

      const roundTrip = await readCiphertextBlob("user-123", "blob-456");
      expect(Array.from(roundTrip)).toEqual(Array.from(bytes));

      const blobStat = await statCiphertextBlob("user-123", "blob-456");
      expect(blobStat.path).toBe(blobPath);
      expect(blobStat.size).toBe(bytes.byteLength);
      expect(blobStat.mtimeMs).toBeGreaterThan(0);
    });
  });
});
