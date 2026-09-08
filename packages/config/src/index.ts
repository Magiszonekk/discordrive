// DiscorDrive v4 — Browser-safe configuration constants
// This file MUST NOT contain process.env references — it's imported in the browser.

import type { AppMode } from "@ddv4/types";

export const config = {
  // Chunking
  // Plaintext chunk size — after AES-GCM encryption, each chunk grows by:
  //   12B (IV) + 16B (GCM auth tag) = 28B overhead
  // Discord enforces a 10 MiB (10 * 1024 * 1024 B) limit per file.
  // So max plaintext = 10 MiB - 28B to ensure encrypted chunk stays within limit.
  defaultChunkSize: 10 * 1024 * 1024 - 28, // 10 MiB minus AES-GCM overhead
  maxChunkSize: 25 * 1024 * 1024 - 28, // 25 MiB minus overhead (Nitro/boost only)

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
  defaultUploadConcurrency: 20,

  // Ceiling on bytes allowed in flight at once, across all upload workers.
  // Concurrency alone is not a safe knob: at 8 MiB a chunk, 20 workers pinned
  // ~1.5 GiB of live buffers and OOM'd the tab partway through a multi-GiB
  // upload. Upload code derives its worker count from this budget instead.
  //
  // 192 MiB is a deliberate middle ground, measured rather than guessed: it
  // yields 12 workers, which still exceeds the 8-webhook Discord pool (so the
  // fan-out that throughput work depends on is preserved) while keeping peak
  // live memory around 870 MiB instead of the ~1.5 GiB that crashed the tab.
  // Dropping to 96 MiB would halve memory again but throttle to 6 workers,
  // starving the webhook pool.
  uploadInFlightBudgetBytes: 192 * 1024 * 1024,

  // Discord rate limiting
  webhookRateLimitDefault: 120, // req/min starting point
  webhookRateLimitWindow: 60_000, // 1 minute window
  cloudflareErrorThreshold: 8_000, // stop before 10k/10min IP ban
  cloudflareWindowMs: 10 * 60 * 1000, // 10 minutes

  // Misc
  anonymousTTLDays: 30,
} as const;

export type { AppMode };
