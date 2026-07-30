// DiscorDrive v4 — API client for scripts and integrations.
//
// Authenticates with a per-user API key, so uploads land in that user's drive and
// show up in the web app immediately. The web app can stay signed in at the same
// time — the two credentials are independent.
//
// The server stores ciphertext only. This client does every encryption and
// decryption step locally, exactly as the browser does.
//
//   DDV4_URL      http://localhost:3400 by default
//   DDV4_API_KEY  the full ddv4_<authPart>.<cryptoPart> secret from Settings → API Keys

import "dotenv/config";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  deriveApiKeyWrapKey,
  generateRootFEK,
  wrapKey,
  unwrapKey,
  encryptChunk,
  decryptChunk,
  deriveFileContentKey,
  encryptFileManifestPlaintext,
  decryptFileManifestPlaintext,
  toBase64,
  fromBase64,
} from "@ddv4/processing";

export const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

const BASE = process.env.DDV4_URL ?? "http://localhost:3400";
const FULL_SECRET = process.env.DDV4_API_KEY ?? "";

if (!FULL_SECRET) {
  throw new Error("DDV4_API_KEY is not set. Create one in Settings → API Keys.");
}

// Split once, here. Only authPart is ever put on the wire; cryptoPart stays in
// this process and is the sole means of opening the ARK the server holds for us.
const [authPart, cryptoPart] = (() => {
  const body = FULL_SECRET.startsWith("ddv4_") ? FULL_SECRET.slice("ddv4_".length) : "";
  const parts = body.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("DDV4_API_KEY is malformed — expected ddv4_<authPart>.<cryptoPart>");
  }
  return parts;
})();

const API_KEY_HEADER = `ddv4_${authPart}`;

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

// --- transport ---------------------------------------------------------------

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${BASE}/graphql`, {
    method: "POST",
    headers: { "X-API-Key": API_KEY_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  if (!res.ok) throw new Error(`GraphQL request failed: ${res.status}`);
  return json.data!;
}

export async function putBlob(
  blobId: string,
  ciphertext: Uint8Array,
): Promise<{
  blobId: string;
  storageKind: "LOCAL" | "DISCORD" | "TELEGRAM";
  storagePath: string;
  ciphertextSizeBytes: string;
  ciphertextHash?: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
}> {
  const res = await fetch(`${BASE}/api/blob/${blobId}`, {
    method: "PUT",
    headers: { "X-API-Key": API_KEY_HEADER, "Content-Type": "application/octet-stream" },
    body: ciphertext as unknown as BodyInit,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: "Blob upload failed" }))) as { error: string };
    throw new Error(`PUT ${blobId} failed (${res.status}): ${err.error}`);
  }
  return res.json() as Promise<never>;
}

export async function getBlob(blobId: string): Promise<Uint8Array> {
  const res = await fetch(`${BASE}/api/blob/${blobId}`, {
    headers: { "X-API-Key": API_KEY_HEADER },
  });
  if (!res.ok) throw new Error(`GET ${blobId} failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// --- keys --------------------------------------------------------------------

const ARK_MATERIAL = `
  query ApiKeyMaterial {
    apiKeyMaterial { wrappedARKByKey wrappedARKIv }
  }
`;

let cachedArk: CryptoKey | null = null;

/**
 * Fetches this key's wrapped ARK and opens it with cryptoPart.
 *
 * The server hands out the ciphertext to anyone holding the authPart, which is
 * safe: without cryptoPart — which it has never seen — the bytes are inert.
 */
export async function getArk(): Promise<CryptoKey> {
  if (cachedArk) return cachedArk;

  const { apiKeyMaterial } = await gql<{
    apiKeyMaterial: { wrappedARKByKey: string; wrappedARKIv: string };
  }>(ARK_MATERIAL);

  const wrapKeyForApi = await deriveApiKeyWrapKey(fromBase64Url(cryptoPart));
  const wrapped = fromBase64(apiKeyMaterial.wrappedARKByKey);
  cachedArk = await unwrapKey(
    wrapped.buffer.slice(wrapped.byteOffset, wrapped.byteOffset + wrapped.byteLength) as ArrayBuffer,
    wrapKeyForApi,
    fromBase64(apiKeyMaterial.wrappedARKIv),
    ["wrapKey", "unwrapKey"],
  );
  return cachedArk;
}

function packWrappedKey(data: ArrayBuffer, iv: Uint8Array): Uint8Array {
  const packed = new Uint8Array(iv.byteLength + data.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(data), iv.byteLength);
  return packed;
}

function unpackWrappedKey(packed: Uint8Array): { data: ArrayBuffer; iv: Uint8Array } {
  const ivLength = 12;
  if (packed.byteLength <= ivLength) throw new Error("Packed wrapped key is too short");
  return {
    iv: packed.slice(0, ivLength),
    data: packed.buffer.slice(packed.byteOffset + ivLength, packed.byteOffset + packed.byteLength) as ArrayBuffer,
  };
}

// --- upload ------------------------------------------------------------------

const INIT_UPLOAD = `
  mutation InitUpload($parentFolderId: ID, $encryptedName: String, $encryptedMimeType: String,
                      $wrappedFEK: String!, $totalCiphertextBytes: String!, $chunkCount: Int!) {
    initUpload(parentFolderId: $parentFolderId, encryptedName: $encryptedName,
               encryptedMimeType: $encryptedMimeType, wrappedFEK: $wrappedFEK,
               totalCiphertextBytes: $totalCiphertextBytes, chunkCount: $chunkCount) {
      fileId
      status
    }
  }
`;

const COMMIT_MANIFEST = `
  mutation CommitManifest($fileId: ID!, $manifestBlobId: String!, $totalCiphertextBytes: String!,
                          $chunkCount: Int!, $blobs: [UploadedBlobTransportInput!]!) {
    commitManifest(fileId: $fileId, manifestBlobId: $manifestBlobId,
                   totalCiphertextBytes: $totalCiphertextBytes, chunkCount: $chunkCount, blobs: $blobs) {
      success
    }
  }
`;

// Byte-for-byte identical to the browser's encryptMeta: AES-GCM under the rootFek
// itself with a 12-byte IV prefix. Anything else and the web app shows the file
// with an unreadable name.
async function encryptMeta(rootFek: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, rootFek, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), 12);
  return toBase64(combined);
}

async function decryptMeta(rootFek: CryptoKey, ciphertextB64: string): Promise<string> {
  const bytes = fromBase64(ciphertextB64);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    rootFek,
    bytes.slice(12),
  );
  return new TextDecoder().decode(pt);
}

/** Uploads a local file into the API key's account. Returns the new file id. */
export async function uploadFile(path: string, parentFolderId: string | null = null): Promise<string> {
  const ark = await getArk();
  const info = await stat(path);
  const fileName = basename(path);
  const chunkCount = Math.max(1, Math.ceil(info.size / CHUNK_SIZE_BYTES));

  const rootFek = await generateRootFEK();
  const wrapped = await wrapKey(rootFek, ark);
  const contentKey = await deriveFileContentKey(rootFek);

  const { initUpload } = await gql<{ initUpload: { fileId: string } }>(INIT_UPLOAD, {
    parentFolderId,
    encryptedName: await encryptMeta(rootFek, fileName),
    encryptedMimeType: await encryptMeta(rootFek, "application/octet-stream"),
    wrappedFEK: toBase64(packWrappedKey(wrapped.data, wrapped.iv)),
    totalCiphertextBytes: String(info.size),
    chunkCount,
  });

  const fileId = initUpload.fileId;
  const blobs: Awaited<ReturnType<typeof putBlob>>[] = [];
  const manifestChunks: Array<{ index: number; blobId: string; ciphertextSizeBytes: number }> = [];

  // Sequential on purpose: a script competing with the browser for the same
  // sender pool gains little from concurrency and risks tripping rate limits.
  let index = 0;
  let buffered: Buffer[] = [];
  let bufferedBytes = 0;

  const flush = async () => {
    if (bufferedBytes === 0) return;
    const plaintext = Buffer.concat(buffered, bufferedBytes);
    buffered = [];
    bufferedBytes = 0;

    const ciphertext = new Uint8Array(
      await encryptChunk(
        plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer,
        contentKey,
      ),
    );
    const blobId = `${fileId}:chunk:${index}`;
    const result = await putBlob(blobId, ciphertext);
    blobs.push(result);
    manifestChunks.push({ index, blobId, ciphertextSizeBytes: ciphertext.byteLength });
    process.stdout.write(`\r  chunk ${index + 1}/${chunkCount}`);
    index += 1;
  };

  for await (const piece of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    const buf = piece as Buffer;
    buffered.push(buf);
    bufferedBytes += buf.byteLength;
    if (bufferedBytes >= CHUNK_SIZE_BYTES) await flush();
  }
  await flush();
  process.stdout.write("\n");

  const manifest = { schemaVersion: 1, chunkSizeBytes: CHUNK_SIZE_BYTES, chunks: manifestChunks };
  const encryptedManifest = await encryptFileManifestPlaintext(manifest, rootFek);
  const manifestBlobId = `${fileId}:manifest`;
  blobs.push(await putBlob(manifestBlobId, encryptedManifest));

  const { commitManifest } = await gql<{ commitManifest: { success: boolean } }>(COMMIT_MANIFEST, {
    fileId,
    manifestBlobId,
    totalCiphertextBytes: String(info.size),
    chunkCount,
    blobs: blobs.map((b) => ({
      blobId: b.blobId,
      storageKind: b.storageKind,
      storagePath: b.storagePath,
      ciphertextSizeBytes: b.ciphertextSizeBytes,
      ciphertextHash: b.ciphertextHash,
      discordMessageId: b.discordMessageId,
      discordChannelId: b.discordChannelId,
      webhookId: b.webhookId,
    })),
  });

  if (!commitManifest.success) throw new Error("commitManifest returned success: false");
  return fileId;
}

// --- download ----------------------------------------------------------------

const FILE_QUERY = `
  query File($fileId: ID!) {
    file(fileId: $fileId) { id wrappedFEK primaryManifestBlobId chunkCount status }
  }
`;

/** Streams a file back out, decrypting chunk by chunk. */
export async function downloadFile(fileId: string, write: (chunk: Uint8Array) => void): Promise<void> {
  const ark = await getArk();
  const { file } = await gql<{
    file: { wrappedFEK: string; primaryManifestBlobId: string | null; status: string } | null;
  }>(FILE_QUERY, { fileId });

  if (!file) throw new Error("File not found");
  if (file.status !== "READY") throw new Error(`File is ${file.status}, not READY`);
  if (!file.primaryManifestBlobId) throw new Error("File has no manifest");

  const { data, iv } = unpackWrappedKey(fromBase64(file.wrappedFEK));
  const rootFek = await unwrapKey(data, ark, iv, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
  const contentKey = await deriveFileContentKey(rootFek);

  const manifest = await decryptFileManifestPlaintext<{
    chunks: Array<{ index: number; blobId: string }>;
  }>(await getBlob(file.primaryManifestBlobId), rootFek);

  const ordered = [...manifest.chunks].sort((a, b) => a.index - b.index);
  for (const chunk of ordered) {
    const ciphertext = await getBlob(chunk.blobId);
    const buffer = ciphertext.buffer.slice(
      ciphertext.byteOffset,
      ciphertext.byteOffset + ciphertext.byteLength,
    ) as ArrayBuffer;
    write(new Uint8Array(await decryptChunk(buffer, contentKey)));
    process.stdout.write(`\r  chunk ${chunk.index + 1}/${ordered.length}`);
  }
  process.stdout.write("\n");
}

// --- list --------------------------------------------------------------------

const FILES_QUERY = `
  query Files($parentFolderId: ID) {
    files(parentFolderId: $parentFolderId) {
      id encryptedName wrappedFEK totalCiphertextBytes status createdAt
    }
  }
`;

/** Lists files with names decrypted locally. */
export async function listFiles(parentFolderId: string | null = null) {
  const ark = await getArk();
  const { files } = await gql<{
    files: Array<{
      id: string;
      encryptedName: string | null;
      wrappedFEK: string;
      totalCiphertextBytes: string;
      status: string;
      createdAt: string;
    }>;
  }>(FILES_QUERY, { parentFolderId });

  return Promise.all(
    files.map(async (f) => {
      let name = "(no name)";
      if (f.encryptedName) {
        try {
          const { data, iv } = unpackWrappedKey(fromBase64(f.wrappedFEK));
          const rootFek = await unwrapKey(data, ark, iv, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
          name = await decryptMeta(rootFek, f.encryptedName);
        } catch {
          name = "(undecryptable)";
        }
      }
      return { id: f.id, name, size: Number(f.totalCiphertextBytes), status: f.status, createdAt: f.createdAt };
    }),
  );
}
