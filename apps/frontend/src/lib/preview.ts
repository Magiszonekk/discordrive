import { fetchBlobBody } from "./api.js";
import { decryptManifest, decryptFileContentChunk, unwrapRootFek, toBase64, fromBase64 } from "./crypto.js";
import { classifyPreviewKind, type PreviewKind } from "./media.js";
import { useAuthStore } from "../stores/auth.js";

export interface OwnerPreviewOptions {
  fileName: string;
  mimeType: string;
  manifestBlobId: string;
  wrappedFEK: string;
}

export interface SharedPreviewOptions {
  fileName: string;
  mimeType: string;
  manifestBlobId: string;
  rootFek: CryptoKey;
}

export interface PreviewResult {
  fileName: string;
  mimeType: string;
  previewKind: PreviewKind;
  bytes: number;
  objectUrl: string;
}

async function reconstructBlob(rootFek: CryptoKey, manifestBlobId: string, mimeType: string) {
  const manifestBody = await fetchBlobBody(manifestBlobId);
  const manifest = await decryptManifest(rootFek, toBase64(new Uint8Array(manifestBody)));

  const chunks: Uint8Array[] = [];
  for (const chunk of manifest.chunks) {
    const chunkBody = await fetchBlobBody(chunk.blobId);
    const plaintext = await decryptFileContentChunk(rootFek, new Uint8Array(chunkBody));
    chunks.push(new Uint8Array(plaintext));
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const blob = new Blob([merged], { type: mimeType });
  return { blob, bytes: total };
}

export async function createOwnerPreview(options: OwnerPreviewOptions): Promise<PreviewResult> {
  const filesKey = useAuthStore.getState().filesKey;
  if (!filesKey) throw new Error("Not authenticated");

  const rootFek = await unwrapRootFek(filesKey, options.wrappedFEK);
  const { blob, bytes } = await reconstructBlob(rootFek, options.manifestBlobId, options.mimeType);

  return {
    fileName: options.fileName,
    mimeType: options.mimeType,
    previewKind: classifyPreviewKind(options.mimeType),
    bytes,
    objectUrl: URL.createObjectURL(blob),
  };
}

export async function createSharedPreview(options: SharedPreviewOptions): Promise<PreviewResult> {
  const { blob, bytes } = await reconstructBlob(options.rootFek, options.manifestBlobId, options.mimeType);
  return {
    fileName: options.fileName,
    mimeType: options.mimeType,
    previewKind: classifyPreviewKind(options.mimeType),
    bytes,
    objectUrl: URL.createObjectURL(blob),
  };
}

export function revokePreview(preview: Pick<PreviewResult, "objectUrl"> | null | undefined) {
  if (!preview?.objectUrl) return;
  URL.revokeObjectURL(preview.objectUrl);
}
