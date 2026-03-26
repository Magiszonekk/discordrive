// DiscorDrive v4 — HTTP API client for upload/download

import { config } from "@ddv4/config";
import { useAuthStore } from "../stores/auth.js";

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const UPLOAD_BASE_BACKOFF_MS = 1000;
const UPLOAD_TIMEOUT_MS = 120_000; // 120s per chunk attempt

// Direct backend URL bypasses Vite proxy so the browser uses HTTP/2 multiplexing.
// Falls back to relative path (production / no VITE_API_URL set).
const UPLOAD_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

// Multiple upload URLs — each URL creates a separate HTTP/2 connection,
// bypassing the single-TCP-connection bottleneck (~35 MB/s with one connection).
// Set VITE_UPLOAD_URLS=https://localhost:3000,https://localhost:3001,https://localhost:3002
const UPLOAD_URLS: string[] = (import.meta.env.VITE_UPLOAD_URLS as string | undefined)
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean) ?? [UPLOAD_BASE_URL];
let uploadUrlIndex = 0;

export async function uploadChunkToApi(
  fileId: string,
  chunkIndex: number,
  data: ArrayBuffer,
  signal?: AbortSignal,
): Promise<{ messageId: string; channelId: string }> {
  let lastError: Error | null = null;
  const maxRetries = config.uploadChunkRetries;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error("Upload aborted");
    }

    try {
      const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      const baseUrl = UPLOAD_URLS[uploadUrlIndex++ % UPLOAD_URLS.length];
      const response = await fetch(`${baseUrl}/api/upload/${fileId}/chunk/${chunkIndex}`, {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/octet-stream",
        },
        body: data,
        signal: combined,
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
    } catch (err) {
      // External abort (fail-fast from upload.ts)
      if (signal?.aborted) throw new Error("Upload aborted");

      // Timeout or network error → retry with backoff
      if (err instanceof DOMException || err instanceof TypeError) {
        const waitMs = UPLOAD_BASE_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }

      // Known non-retryable errors — re-throw
      throw err;
    }
  }

  throw lastError ?? new Error(`Chunk ${chunkIndex} failed after ${maxRetries} retries`);
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
