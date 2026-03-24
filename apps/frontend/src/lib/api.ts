// DiscorDrive v4 — HTTP API client for upload/download

import { useAuthStore } from "../stores/auth.js";

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const UPLOAD_MAX_RETRIES = 5;
const UPLOAD_BASE_BACKOFF_MS = 1000;

export async function uploadChunkToApi(
  fileId: string,
  chunkIndex: number,
  data: ArrayBuffer,
): Promise<{ messageId: string; channelId: string }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    const response = await fetch(`/api/upload/${fileId}/chunk/${chunkIndex}`, {
      method: "POST",
      headers: {
        ...getAuthHeaders(),
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });

    if (response.ok) {
      return response.json() as Promise<{ messageId: string; channelId: string }>;
    }

    // Non-retryable errors
    if (response.status === 401 || response.status === 403) {
      throw new Error("Authentication failed");
    }
    if (response.status === 404) {
      throw new Error("File not found or not in uploading state");
    }
    if (response.status === 409) {
      // Chunk already uploaded (idempotent — previous attempt succeeded but response was lost)
      return { messageId: "", channelId: "" };
    }
    if (response.status === 413) {
      throw new Error("Chunk too large");
    }

    // Retryable: 429
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter
        ? parseFloat(retryAfter) * 1000
        : UPLOAD_BASE_BACKOFF_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      lastError = new Error("Rate limited (429)");
      continue;
    }

    // Retryable: 5xx
    if (response.status >= 500) {
      const waitMs = UPLOAD_BASE_BACKOFF_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const errorBody = await response.json().catch(() => ({ error: "Server error" }));
      lastError = new Error((errorBody as { error: string }).error);
      continue;
    }

    // Unknown error — don't retry
    const errorBody = await response.json().catch(() => ({ error: "Upload failed" }));
    throw new Error((errorBody as { error: string }).error);
  }

  throw lastError ?? new Error(`Chunk ${chunkIndex} failed after ${UPLOAD_MAX_RETRIES} retries`);
}

export async function downloadChunkFromApi(
  fileId: string,
  chunkIndex: number,
): Promise<ArrayBuffer> {
  const response = await fetch(`/api/download/${fileId}/chunk/${chunkIndex}`, {
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  return response.arrayBuffer();
}

export async function downloadSharedChunk(
  token: string,
  chunkIndex: number,
): Promise<ArrayBuffer> {
  const response = await fetch(`/api/share/${token}/chunk/${chunkIndex}`);

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  return response.arrayBuffer();
}

export async function getShareInfo(token: string) {
  const response = await fetch(`/api/share/${token}/info`);
  if (!response.ok) return null;
  return response.json();
}

export async function verifySharePassword(
  token: string,
  password: string,
): Promise<boolean> {
  const response = await fetch(`/api/share/${token}/verify-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) return false;
  const result = (await response.json()) as { valid: boolean };
  return result.valid;
}
