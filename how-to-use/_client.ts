// DiscorDrive v4 — Shared helpers for how-to-use scripts
// Reads DISCORDRIVE_URL, API_KEY, MASTER_KEY from environment / .env

import "dotenv/config";
import { generateMasterKey, exportKey, importKey, toBase64, fromBase64 } from "@ddv4/processing";

export const BASE = process.env.DISCORDRIVE_URL ?? "http://localhost:3000";
const API_KEY = process.env.API_KEY ?? "";

function authHeaders(): Record<string, string> {
  return API_KEY ? { "X-API-Key": API_KEY } : {};
}

// ── GraphQL ──────────────────────────────────────────────────────────────────

export async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${BASE}/graphql`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`GraphQL error: ${json.errors[0].message}`);
  return json.data!;
}

// ── REST chunk endpoints ─────────────────────────────────────────────────────

export async function uploadChunk(
  fileId: string,
  index: number,
  encrypted: ArrayBuffer,
): Promise<void> {
  const res = await fetch(`${BASE}/api/upload/${fileId}/chunk/${index}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/octet-stream" },
    body: encrypted,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Upload failed" })) as { error: string };
    throw new Error(`Upload chunk ${index} failed: ${err.error}`);
  }
}

export async function downloadChunk(fileId: string, index: number): Promise<ArrayBuffer> {
  const res = await fetch(`${BASE}/api/download/${fileId}/chunk/${index}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Download chunk ${index} failed: ${res.status}`);
  return res.arrayBuffer();
}

// ── Master Key ───────────────────────────────────────────────────────────────

/**
 * Load Master Key from MASTER_KEY env var (base64 raw AES-GCM key).
 * If not set, generates a new one, prints it, and exits with instructions.
 */
export async function getMasterKey(): Promise<CryptoKey> {
  const raw = process.env.MASTER_KEY;

  if (!raw) {
    const key = await generateMasterKey();
    const exported = await exportKey(key);
    const b64 = toBase64(exported);
    console.error("\n  MASTER_KEY is not set. Generated a new one:\n");
    console.error(`  MASTER_KEY=${b64}\n`);
    console.error("  Add it to your .env file and re-run the script.\n");
    console.error("  Keep it safe — it is the only way to decrypt your files.\n");
    process.exit(1);
  }

  const bytes = fromBase64(raw);
  // Buffer.buffer may be a shared ArrayBuffer in Node.js — slice to get an independent copy
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return importKey(buf, ["wrapKey", "unwrapKey"]);
}

// ── Worker pool ──────────────────────────────────────────────────────────────

/**
 * Run tasks with bounded concurrency.
 * tasks: array of async functions to execute.
 */
export async function runPool(tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}
