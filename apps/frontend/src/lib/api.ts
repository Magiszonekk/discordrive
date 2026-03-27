// DiscorDrive v4 — HTTP API client for upload/download

import { useAuthStore } from "../stores/auth.js";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function uploadChunkToApi(
  fileId: string,
  chunkIndex: number,
  data: ArrayBuffer,
): Promise<{ messageId: string; channelId: string }> {
  const response = await fetch(`${API_BASE}/api/upload/${fileId}/chunk/${chunkIndex}`, {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/octet-stream",
    },
    body: data,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Upload failed" }));
    throw new Error((error as { error: string }).error);
  }

  return response.json() as Promise<{ messageId: string; channelId: string }>;
}

export async function downloadChunkFromApi(
  fileId: string,
  chunkIndex: number,
): Promise<ArrayBuffer> {
  const response = await fetch(`${API_BASE}/api/download/${fileId}/chunk/${chunkIndex}`, {
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
  const response = await fetch(`${API_BASE}/api/share/${token}/chunk/${chunkIndex}`);

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  return response.arrayBuffer();
}

export async function getShareInfo(token: string) {
  const response = await fetch(`${API_BASE}/api/share/${token}/info`);
  if (!response.ok) return null;
  return response.json();
}

export async function verifySharePassword(
  token: string,
  password: string,
): Promise<boolean> {
  const response = await fetch(`${API_BASE}/api/share/${token}/verify-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) return false;
  const result = (await response.json()) as { valid: boolean };
  return result.valid;
}
