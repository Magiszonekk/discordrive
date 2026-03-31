# DiscorDrive v4

Use Discord webhooks as unlimited cloud storage. Files are split into chunks, encrypted with AES-GCM, and uploaded as Discord message attachments. Downloads are streamed back through the API (or directly in the browser via Service Worker).

## Architecture

```
┌─────────────┐    GraphQL     ┌─────────────┐    REST/binary   ┌──────────────┐
│   Frontend  │ ◄────────────► │   API (Hono)│ ◄──────────────► │   PostgreSQL │
│  (React/SW) │                │   :3000     │                   └──────────────┘
└─────────────┘                └──────┬──────┘
       │                              │  Discord Webhook API
       │  /sw-stream/:fileId          │  ┌─────────────────────────────────────┐
       │  (Service Worker intercept)  └──► WEBHOOK_1 (channel A) — rate bucket │
       │                                 │ WEBHOOK_2 (channel B) — rate bucket │
       └─────────────────────────────────► WEBHOOK_N (channel N) — rate bucket │
                                          └─────────────────────────────────────┘
```

### Upload pipeline

```
File (browser)
  │
  ├─ [SW] chunkFileStream()              — reads File object in 10 MiB slices, no full copy
  ├─ [SW] encryptChunk(AES-GCM)          — 12B IV + ciphertext + 16B auth tag per chunk
  ├─ [SW] POST /api/upload/:id/chunk/:n  — concurrent (default: 10)
  └─ [API] PUT to Discord webhook        — rotates across N webhooks, respects rate limits
```

### Download pipeline

```
GET /sw-stream/:fileId  (browser hits SW fetch intercept)
  │
  ├─ [SW] GET /api/download/:id/chunk/:n  — concurrent prefetch (chunksAhead=3)
  ├─ [API] GET discord message → fresh CDN URL → stream CDN → client
  └─ [SW] decryptChunk(AES-GCM)           — decrypted bytes piped to video/audio element
```

### Chunk size

`chunkSize = 10 MiB − 28 bytes` (AES-GCM overhead: 12B IV + 16B auth tag).
Discord attachment limit is exactly 10 MiB; the 28B overhead keeps every encrypted chunk within that limit.

### Rate limiting

Each webhook maps to a separate Discord channel — rate limits are per-channel.
The API rotates chunks across all configured webhooks and honours `retry-after` headers.
Upload retries: up to 5 attempts (5s base backoff on 429, 1s on other errors).
Download retries: up to 3 attempts (exponential backoff on 5xx / timeout).

---

## Setup

### 1. Environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `WEBHOOK_1..N` | Discord webhook URLs — one per channel for rate limit isolation |
| `JWT_SECRET` | Random secret for JWT signing |
| `APP_MODE` | `full` (users + auth) or `backend-only` (API key only, no login) |
| `API_KEY` | Required when `APP_MODE=backend-only` |
| `API_PORT` | Default `3000` |
| `FRONTEND_PORT` | Default `5173` |

### 2. Discord webhooks

1. Create a Discord server (or use existing).
2. For each webhook: **Server Settings → Integrations → Webhooks → New Webhook**.
3. **Each webhook must be on a separate channel** — rate limits are per-channel.
4. Copy the webhook URL into `WEBHOOK_1`, `WEBHOOK_2`, etc.

More webhooks = higher parallelism and upload throughput.

### 3. Database

```bash
# Start PostgreSQL via Docker
npm run infra:up

# Apply schema
npm run db:push
```

### 4. Install dependencies

```bash
npm install
```

---

## Running

```bash
# API server (port 3000)
npm run dev:api

# Frontend dev server (port 5173)
npm run dev:frontend
```

Open `http://localhost:5173`.

---

## Benchmark

### Crypto-only benchmark (no API, no Discord)

Tests local encrypt/decrypt throughput only:

```bash
npm run benchmark
```

### End-to-end benchmark

Tests the full pipeline: generate → encrypt → API upload → Discord → API download → decrypt → verify integrity.

```bash
# Syntax
npm run benchmark:e2e -- [fileSize] [concurrency] [--stream]

# Examples
npm run benchmark:e2e                      # 25 MB, concurrency 3, batch mode
npm run benchmark:e2e -- 100               # 100 MB, concurrency 3
npm run benchmark:e2e -- 1GB 10            # 1 GB, concurrency 10
npm run benchmark:e2e -- 2GB 20 --stream   # 2 GB, concurrency 20, streaming mode
```

#### Arguments

| Argument | Default | Description |
|---|---|---|
| `fileSize` | `25` | File size in MB. Supports suffixes: `100`, `1GB`, `500MB` |
| `concurrency` | `3` | Number of parallel chunk uploads/downloads |
| `--stream` | off | Streaming mode: generate + encrypt + upload as one pipeline |

#### Modes

**Batch mode** (default):
1. Generate all chunks in RAM
2. Encrypt all chunks
3. Upload all chunks via API
4. Download all chunks via API
5. Decrypt + SHA-256 verify

Peak RAM ≈ `2 × fileSize` (plaintext + ciphertext buffers).

**Streaming mode** (`--stream`):
1. Generate → encrypt → upload as a single async pipeline (one chunk at a time)
2. Download all chunks via API
3. Decrypt + SHA-256 verify

Peak RAM ≈ `concurrency × chunkSize` (~100–200 MB regardless of file size). Same as the frontend SW pipeline.

#### Requirements

- API server must be running (`npm run dev:api`)
- `APP_MODE=backend-only` in `.env` is recommended (skips JWT auth)
- `API_KEY` must match `.env` if set

#### Sample output

```
═══════════════════════════════════════════
  DiscorDrive E2E Pipeline Benchmark
═══════════════════════════════════════════
  File size:    100.00 MB
  Chunk size:   10.00 MB
  Chunk count:  10
  Concurrency:  10
  Mode:         streaming (gen+enc+upload pipeline)
  API:          http://localhost:3000
  Auth:         API key
═══════════════════════════════════════════

Streaming pipeline (generate → encrypt → upload)...
  File ID: clx...
  Pipeline: 10/10 (100%) — 48.2 MB/s
  Pipeline complete: 2.07s (48.2 MB/s)

  Finalized.

Downloading through API (concurrency: 10)...
  Download: 10/10 (100%) — 51.3 MB/s
  Download complete: 1.95s (51.3 MB/s)

Decrypting and verifying integrity...
  Decrypt: 0.21s (476.2 MB/s)
  Integrity: ✓ PASS

  Pipeline throughput:  24.8 MB/s (gen+enc+upload→download→decrypt)
═══════════════════════════════════════════
```

**Pipeline throughput** = `totalBytes / (upload_ms + download_ms + decrypt_ms)`.
Upload and download run sequentially in the benchmark, so the bottleneck (usually upload at ~50 MB/s) dominates.

**Download is ~2× slower than raw Discord CDN** because the API acts as a proxy:
`client → API → Discord CDN → API → client`. CDN URLs are private and require a fresh Discord API call per chunk.

---

## How to use — Service Worker + API

### Upload via Service Worker

The SW receives a `File` object directly (no main-thread buffering), reads it in chunks, encrypts and uploads concurrently. Peak RAM = `concurrency × chunkSize` ≈ 100 MB at concurrency 10.

```typescript
import { uploadViaSW } from "./lib/swUpload";
import { generateFEK, generateMasterKey, wrapKey, toBase64 } from "@discordrive/processing";

// 1. Generate encryption key
const fek = await generateFEK();
const masterKey = await generateMasterKey();
const wrappedFek = await wrapKey(fek, masterKey);

// 2. Register file with API (GraphQL initUpload mutation)
const fileId = await initUpload({
  name: file.name,
  mimeType: file.type,
  size: file.size.toString(),
  chunkSize: 10485704,          // 10 MiB - 28B
  chunkCount: Math.ceil(file.size / 10485704),
  encryptedFEK: toBase64(wrappedFek.data),
  fekIv: toBase64(wrappedFek.iv),
});

// 3. Upload via SW — streaming, low RAM
const abort = new AbortController();

await uploadViaSW(file, fileId, fek, 10485704, (progress) => {
  console.log(`${progress.uploadedChunks}/${progress.totalChunks} chunks`);
}, abort.signal);

// Cancel anytime: abort.abort()

// 4. Finalize
await finalizeUpload({ fileId, sha256: await hashFile(file) });
```

**SW message protocol** (low-level):

```typescript
// Main thread → SW
navigator.serviceWorker.controller.postMessage(
  {
    type: "UPLOAD_FILE",
    fileId: "...",
    file: fileObject,          // File — structured clone (lazy, no data copy)
    fekRaw: arrayBuffer,       // ArrayBuffer — transferred (zero-copy ownership)
    token: "Bearer eyJ...",
    chunkSize: 10485704,
    totalChunks: 42,
    concurrency: 10,
    maxRetries: 5,
  },
  [arrayBuffer],               // transfer list — fekRaw moves to SW
);

// SW → main thread (progress events)
navigator.serviceWorker.addEventListener("message", (event) => {
  const { type, fileId, uploadedChunks, bytesUploaded, totalChunks, error } = event.data;
  // type: "UPLOAD_PROGRESS" | "UPLOAD_DONE" | "UPLOAD_ERROR" | "UPLOAD_CANCELLED"
});

// Cancel
navigator.serviceWorker.controller.postMessage({ type: "CANCEL_UPLOAD", fileId });
```

---

### Stream video/audio via Service Worker

The SW intercepts `GET /sw-stream/:fileId`, fetches and decrypts chunks on demand, and responds with proper `206 Partial Content` — compatible with `<video>` and `<audio>` seek.

```typescript
import { registerStream, getStreamUrl, unregisterStream } from "./lib/videoStream";

// 1. Register the file with the SW (unwraps FEK, stores metadata)
await registerStream({
  fileId: "clx...",
  mimeType: "video/mp4",
  size: "104857600",           // file.size as string
  chunkSize: 10485704,
  chunkCount: 10,
  encryptedFEK: "base64...",
  fekIv: "base64...",
});

// 2. Point a video element at the SW stream URL
const videoEl = document.querySelector("video");
videoEl.src = getStreamUrl("clx...");  // → "/sw-stream/clx..."
videoEl.play();

// 3. Cleanup when done
await unregisterStream("clx...");
```

**SW message protocol** (low-level):

```typescript
// Register
navigator.serviceWorker.controller.postMessage({
  type: "REGISTER_STREAM",
  fileId: "clx...",
  token: "Bearer eyJ...",
  fekRaw: rawKeyArrayBuffer,   // await crypto.subtle.exportKey("raw", fek)
  chunkSize: 10485704,
  chunkCount: 10,
  totalSize: 104857600,
  mimeType: "video/mp4",
  chunksAhead: 3,              // chunks to prefetch ahead of playhead
  chunksBehind: 2,             // chunks to keep in cache behind playhead
});

// Unregister (frees memory)
navigator.serviceWorker.controller.postMessage({
  type: "UNREGISTER_STREAM",
  fileId: "clx...",
});
```

After `REGISTER_STREAM`, the browser fetches `/sw-stream/clx...` normally.
The SW intercepts it, calls `GET /api/download/:fileId/chunk/:n` with the auth token,
decrypts, and assembles the response — including `Range` header support for seeking.

---

### Direct API usage (backend-only / scripts)

```bash
# .env
APP_MODE=backend-only
API_KEY=my-secret-key

npm run dev:api
```

```typescript
const BASE = "http://localhost:3000";
const H = { "X-API-Key": "my-secret-key", "Content-Type": "application/json" };
const gql = (query: string, variables = {}) =>
  fetch(`${BASE}/graphql`, { method: "POST", headers: H, body: JSON.stringify({ query, variables }) })
    .then(r => r.json()).then((j: any) => j.data);

// Init upload
const { initUpload: { fileId } } = await gql(`
  mutation($name:String!,$mimeType:String!,$size:String!,
           $chunkSize:Int!,$chunkCount:Int!,$encryptedFEK:String!,$fekIv:String!) {
    initUpload(name:$name,mimeType:$mimeType,size:$size,
               chunkSize:$chunkSize,chunkCount:$chunkCount,
               encryptedFEK:$encryptedFEK,fekIv:$fekIv) { fileId }
  }`,
  { name: "file.bin", mimeType: "application/octet-stream", size: "10485704",
    chunkSize: 10485704, chunkCount: 1, encryptedFEK: "<base64>", fekIv: "<base64>" });

// Upload chunk (raw AES-GCM encrypted bytes)
await fetch(`${BASE}/api/upload/${fileId}/chunk/0`, {
  method: "POST",
  headers: { "X-API-Key": "my-secret-key", "Content-Type": "application/octet-stream" },
  body: encryptedChunkBuffer,
});

// Finalize
await gql(
  `mutation { finalizeUpload(fileId: "${fileId}", sha256: "${sha256hex}") { success missingChunks } }`
);

// Download chunk (returns encrypted bytes — decrypt with AES-GCM using the FEK)
const chunk = await fetch(`${BASE}/api/download/${fileId}/chunk/0`,
  { headers: { "X-API-Key": "my-secret-key" } }
).then(r => r.arrayBuffer());

// Delete
await gql(`mutation { deleteFile(fileId: "${fileId}") }`);
```

---

## Key Management

DiscorDrive uses a zero-knowledge architecture — the server stores only encrypted key material and never sees any plaintext key or file content.

### Keys

| Key | Algorithm | Purpose | Where it lives |
|---|---|---|---|
| KEK (Key Encryption Key) | Argon2id → AES-GCM | Wraps the Master Key | Never stored — derived from password on login |
| Master Key (MK) | AES-GCM 256-bit | Wraps per-file FEKs | Encrypted in DB (`User.encryptedMasterKey`) |
| FEK (File Encryption Key) | AES-GCM 256-bit | Encrypts file chunks | Encrypted in DB (`File.encryptedFEK`) |
| Share Key | AES-GCM 256-bit | Wraps FEK for public shares | Never stored — embedded in share URL |

### Key hierarchy

```
password + kekSalt
     │
     │  Argon2id (64 MB, 3 iterations, parallelism 4)
     ▼
    KEK  ──AES-GCM wrap──►  encryptedMasterKey  ← DB: User.encryptedMasterKey
                             + wrapIv            ← DB: User.wrapIv
                             + kekSalt           ← DB: User.kekSalt
     │
     │  unwrap on login (client only)
     ▼
 Master Key  ──AES-GCM wrap──►  encryptedFEK  ← DB: File.encryptedFEK
  (memory)                       + fekIv       ← DB: File.fekIv
     │
     │  unwrap on download (client only)
     ▼
   FEK  ──AES-GCM──►  [12B IV | ciphertext | 16B GCM tag]  ← Discord attachment
  (memory)             one unique IV per chunk
```

### Lifecycle

**Registration** — [`registerCrypto()`](apps/frontend/src/lib/crypto.ts)
1. Client generates random 16-byte `kekSalt`
2. Client derives KEK from password + salt via Argon2id
3. Client generates a fresh 256-bit Master Key
4. Client wraps Master Key with KEK (AES-GCM, random IV)
5. Client sends `kekSalt`, `wrapIv`, `encryptedMasterKey` to server — KEK and Master Key never leave the client

**Login** — [`loginCrypto()`](apps/frontend/src/lib/crypto.ts)
1. Server verifies password against its own Argon2id hash, returns encrypted key material
2. Client re-derives KEK from password + stored `kekSalt`
3. Client unwraps Master Key using KEK
4. Master Key stored in Zustand store (memory only — not persisted, cleared on page refresh)

**File upload** — [`prepareFileUpload()`](apps/frontend/src/lib/crypto.ts)
1. Client generates a fresh 256-bit FEK per file
2. Client wraps FEK with Master Key, sends `encryptedFEK` + `fekIv` to server via `initUpload`
3. Raw FEK transferred to Service Worker (zero-copy `ArrayBuffer` transfer)
4. SW encrypts each chunk: `AES-GCM(fek, randomIV, plainChunk)` → `[12B IV | ciphertext]`
5. FEK discarded from SW memory after upload

**File download** — [`unwrapFEK()`](apps/frontend/src/lib/crypto.ts)
1. Client fetches `encryptedFEK` + `fekIv` from file metadata
2. Client unwraps FEK using Master Key
3. FEK sent to SW for on-demand chunk decryption during streaming

**Share links** — [`prepareShareLink()`](apps/frontend/src/lib/crypto.ts)
1. Client unwraps FEK using Master Key
2. Client generates a random 256-bit Share Key
3. Client wraps FEK with Share Key, stores `wrappedFEK` + `wrapIv` in DB
4. Share Key embedded in the public link — never stored server-side
5. Recipient uses Share Key from URL → `unwrapSharedFEK()` → decrypt chunks
6. Optionally: share link can be password-protected (Argon2id hash stored in DB)

**Password change** — [`changePassword` mutation](apps/api/src/resolvers/auth.ts)
1. Client verifies old password, derives old KEK, unwraps Master Key
2. Client derives new KEK from new password + new salt
3. Client re-wraps Master Key with new KEK
4. Client unwraps all file FEKs with Master Key, re-wraps them (same MK — only MK wrapping changes)
5. Server applies all updates in a single DB transaction

### What the server never sees

- Raw password (only Argon2id hash used for authentication)
- KEK
- Master Key
- Any FEK in plaintext
- File content in plaintext — every byte stored on Discord is AES-GCM encrypted

### Client-side persistence

| Data | Storage | Cleared on |
|---|---|---|
| JWT token | `localStorage` | Manual logout |
| `kekSalt`, `wrapIv`, `encryptedMasterKey` | `localStorage` | Manual logout |
| Master Key (`CryptoKey`) | Memory (Zustand) | Page refresh |
| FEK (`CryptoKey`) | SW memory | Upload/download complete |

Page refresh clears the Master Key — the user must re-enter their password to unlock ("Unlock" flow re-derives KEK and unwraps MK without a network round-trip).

### Algorithms

| Component | Algorithm | Parameters |
|---|---|---|
| KEK derivation | Argon2id | 64 MB memory, 3 iterations, parallelism 4, 256-bit output |
| Key wrapping (MK, FEK, Share) | AES-GCM | 256-bit key, 12-byte random IV per wrap operation |
| Chunk encryption | AES-GCM | 256-bit FEK, 12-byte random IV prepended to each chunk |
| Auth password hashing | Argon2id | Server-side only, independent salt — not used for key derivation |
| File integrity | SHA-256 | Hash of original plaintext, stored after upload, verified after download |

---

## Package structure

```
apps/
  api/            — Hono API server (GraphQL + REST chunk endpoints)
  frontend/       — React app + Vite + Service Worker

packages/
  config/         — Shared config (chunk size, concurrency defaults)
  database/       — Prisma schema + client
  discord-client/ — Webhook upload/download/delete with rate limiting + retry
  processing/     — AES-GCM encrypt/decrypt, key derivation, chunk streaming
  stream-engine/  — UploadEngine + DownloadEngine (browser and Node.js compatible)

scripts/
  benchmark.ts      — Local crypto-only benchmark
  benchmark-e2e.ts  — Full E2E pipeline benchmark (batch + streaming modes)
  bench-utils.ts    — Shared formatting/timing helpers

infra/
  docker-compose.yml — PostgreSQL + pgAdmin
```
