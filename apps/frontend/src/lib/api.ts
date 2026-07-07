// DiscorDrive v4 — HTTP API client for secure files v2

import { useAuthStore } from "../stores/auth.js";

const API_BASE = "";

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface BlobUploadResponse {
  blobId: string;
  ciphertextSizeBytes: string;
  ciphertextHash?: string;
  storageKind: "LOCAL" | "DISCORD" | "TELEGRAM";
  storagePath: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
}

export interface BlobUploadRequestOptions {
  extraHeaders?: Record<string, string>;
  authToken?: string;
}

export class BlobUploadError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "BlobUploadError";
  }
}

function toUploadBody(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  return data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export async function uploadBlobToApi(
  blobId: string,
  data: ArrayBuffer | Uint8Array,
  options: BlobUploadRequestOptions = {},
): Promise<BlobUploadResponse> {
  const authHeaders = options.authToken
    ? { Authorization: `Bearer ${options.authToken}` }
    : getAuthHeaders();

  const response = await fetch(`${API_BASE}/api/blob/${blobId}`, {
    method: "PUT",
    headers: {
      ...authHeaders,
      "Content-Type": "application/octet-stream",
      ...(options.extraHeaders ?? {}),
    },
    body: toUploadBody(data),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Blob upload failed" }));
    throw new BlobUploadError((error as { error: string }).error, response.status);
  }

  return response.json() as Promise<BlobUploadResponse>;
}

export async function fetchBlobDescriptor(blobId: string): Promise<{
  blobId: string;
  ciphertextSizeBytes: string;
  ciphertextHash?: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
}> {
  const response = await fetch(`${API_BASE}/api/blob/${blobId}/meta`, {
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Blob metadata fetch failed: ${response.status}`);
  }

  return response.json() as Promise<{
    blobId: string;
    ciphertextSizeBytes: string;
    ciphertextHash?: string;
    discordMessageId?: string;
    discordChannelId?: string;
    webhookId?: string;
  }>;
}

export async function fetchBlobBody(blobId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(`${API_BASE}/api/blob/${blobId}`, {
    headers: getAuthHeaders(),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Blob body fetch failed: ${response.status}`);
  }

  return response.arrayBuffer();
}

export async function fetchBlobBodyShared(
  blobId: string,
  shareId: string,
  capabilityToken: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(`${API_BASE}/api/share/blob/${blobId}`, {
    headers: {
      "X-Share-Id": shareId,
      "X-Capability-Token": capabilityToken,
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Blob body fetch failed: ${response.status}`);
  }

  return response.arrayBuffer();
}
