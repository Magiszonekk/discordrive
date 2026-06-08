import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

const BLOB_ROOT_ENV_VAR = "DDV4_BLOB_ROOT_DIR";
const DEFAULT_BLOB_ROOT_DIR = path.resolve(process.cwd(), "var", "blobs");
const INVALID_PATH_SEGMENT = /[\\/\0]/g;

function sanitizePathSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) {
    throw new Error("Blob path segment must not be empty");
  }

  return trimmed.replace(INVALID_PATH_SEGMENT, "_");
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function getBlobRootDir(): string {
  const configuredRoot = process.env[BLOB_ROOT_ENV_VAR];
  if (configuredRoot && configuredRoot.trim()) {
    return path.resolve(configuredRoot.trim());
  }

  return DEFAULT_BLOB_ROOT_DIR;
}

export function buildBlobPath(ownerUserId: string, blobId: string): string {
  const ownerDir = sanitizePathSegment(ownerUserId);
  const blobName = `${sanitizePathSegment(blobId)}.bin`;
  return path.join(getBlobRootDir(), ownerDir, blobName);
}

async function ensureBlobDirectory(ownerUserId: string): Promise<void> {
  await mkdir(path.dirname(buildBlobPath(ownerUserId, "placeholder")), { recursive: true });
}

export async function writeCiphertextBlob(
  ownerUserId: string,
  blobId: string,
  bytes: ArrayBuffer | ArrayBufferView,
): Promise<string> {
  const blobPath = buildBlobPath(ownerUserId, blobId);
  await mkdir(path.dirname(blobPath), { recursive: true });
  await writeFile(blobPath, toBytes(bytes));
  return blobPath;
}

export async function readCiphertextBlob(ownerUserId: string, blobId: string): Promise<Uint8Array> {
  const blobPath = buildBlobPath(ownerUserId, blobId);
  const data = await readFile(blobPath);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export async function statCiphertextBlob(ownerUserId: string, blobId: string) {
  const blobPath = buildBlobPath(ownerUserId, blobId);
  const blobStat = await stat(blobPath);

  return {
    path: blobPath,
    size: blobStat.size,
    mode: blobStat.mode,
    mtimeMs: blobStat.mtimeMs,
    ctimeMs: blobStat.ctimeMs,
    birthtimeMs: blobStat.birthtimeMs,
  };
}

export function sha256Ciphertext(bytes: ArrayBuffer | ArrayBufferView): string {
  return createHash("sha256").update(toBytes(bytes)).digest("hex");
}

export async function ensureBlobRootDir(): Promise<string> {
  const rootDir = getBlobRootDir();
  await mkdir(rootDir, { recursive: true });
  return rootDir;
}
