// DiscorDrive v4 — Browser-safe configuration constants
// This file MUST NOT contain process.env references — it's imported in the browser.

import type { AppMode } from "@ddv4/types";

export const config = {
  // Chunking
  defaultChunkSize: 10 * 1024 * 1024 - 256, // ~10 MB (room for AES-GCM encryption overhead within Discord's limit)
  maxChunkSize: 25 * 1024 * 1024, // 25 MB (Nitro/boost only)

  // Argon2id parameters
  argon2: {
    memory: 65536, // 64 MB
    iterations: 3,
    parallelism: 4,
    hashLength: 32, // 256-bit output
  },

  // Crypto constants
  ivLength: 12, // AES-GCM standard IV length
  saltLength: 16, // 128-bit salt

  // Upload concurrency
  defaultUploadConcurrency: 3,

  // Upload retry count (per chunk, on timeout/network error)
  uploadChunkRetries: 5,

  // Discord rate limiting
  webhookRateLimitDefault: 120, // req/min starting point
  webhookRateLimitWindow: 60_000, // 1 minute window
  cloudflareErrorThreshold: 8_000, // stop before 10k/10min IP ban
  cloudflareWindowMs: 10 * 60 * 1000, // 10 minutes

  // Misc
  anonymousTTLDays: 30,
} as const;

export type { AppMode };
