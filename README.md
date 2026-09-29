# DiscorDrive v4

Use Discord **or Telegram** as (almost) unlimited cloud storage. Files are split into chunks, encrypted with AES-GCM, and uploaded as message attachments through pluggable storage providers (`DISCORD`, `TELEGRAM`, `LOCAL`). Downloads are streamed back through the API (or directly in the browser via a Service Worker).

## Architecture

```
┌─────────────┐    GraphQL      ┌──────────────────────┐    Prisma     ┌──────────────┐
│   Frontend  │ ◄─────────────► │  API (Node.js http + │ ◄────────────► │  PostgreSQL  │
│  (React/SW) │                 │     GraphQL Yoga)    │                └──────────────┘
└─────────────┘                 │  :3000               │    cache       ┌──────────────┐
       │                        └──────┬───────────────┘ ◄────────────► │    Redis     │
       │  /sw-stream/:fileId           │                               └──────────────┘
       │  (Service Worker intercept)   │  provider pools (rate-budgeted)
       │                               ├──► WEBHOOK_1..N / BOT_1..N   (Discord channels)
       │                               ├──► TG_BOT_1..N               (Telegram chats)
       │                               └──► REPLICA_* pools           (async replication)
       └──────────────────────────────────► /api/blob/:blobId (REST binary transport)
```

The API is a plain `node:http` server (`apps/api/src/index.ts`) with a tiny custom
router (`matchRoute`) plus **GraphQL Yoga** at `/graphql`. Storage is behind a
pluggable provider layer — every provider sees only ciphertext, so adding or
switching providers never touches the crypto model.

### HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/graphql` | All metadata/auth operations (GraphQL) |
| PUT | `/api/blob/:blobId` | Upload one encrypted blob (ciphertext body) |
| GET | `/api/blob/:blobId` | Download one encrypted blob |
| GET | `/api/blob/:blobId/meta` | Blob descriptor (storageKind, Discord/Telegram handle, hash) |
| GET | `/api/share/blob/:blobId` | Download a shared blob (share capability token, no auth) |
| GET | `/api/plugin/:pluginName/...` | Plugin-provided routes |

### Upload pipeline

```
File (browser)
  │
  ├─ [client] initUpload GraphQL       — creates file record (encrypted name/mime, wrapped FEK)
  ├─ [client] deriveFileContentKey(rootFEK) → AES-GCM encrypt each 10 MiB chunk
  ├─ [client] PUT /api/blob/:blobId    — concurrent (default: 20)
  ├─ [API]    write to provider pool    — rotates across configured providers, respects rate limits
  ├─ [client] encrypt file manifest     — list of chunk → blobId, encrypted with root FEK
  └─ [client] commitManifest GraphQL    — manifest blob + per-chunk blobs; marks file READY
```

Uploads are resumable: `uploadStatus` returns the authoritative set of
uploaded chunk indices, and a 60-minute sweep purges uploads abandoned mid-flight.

### Download pipeline

```
GET /sw-stream/:fileId   (browser hits SW fetch intercept)
  │
  ├─ [SW] GET /api/blob/:manifestBlobId/meta → descriptor
  ├─ [SW] GET /api/blob/:manifestBlobId      → encrypted manifest → decrypt with root FEK
  ├─ [SW] GET /api/blob/:chunkBlobId         — concurrent prefetch (chunksAhead=3)
  └─ [SW] decrypt chunk (AES-GCM)            — bytes piped to video/audio element or saved
```

A plain (non-streaming) download uses the same blob protocol with `downloadFile()`
in `apps/frontend/src/lib/download.ts` (concurrency 20, per-chunk timeout 60 s, 2 retries).

### Chunk size

`chunkSize = 10 MiB − 28 bytes` (AES-GCM overhead: 12 B IV + 16 B auth tag).
Discord's non-boosted attachment limit is exactly 10 MiB; the 28 B overhead keeps
every encrypted chunk within that limit. On boosted servers `maxChunkSize` allows
25 MiB − 28 B. Telegram's Bot API caps at 50 MB, so the default chunk fits with
no changes.

### Rate limiting

- **Per-sender budgets** — each webhook/bot maps to its own Discord channel or
  Telegram chat, so rate limits are isolated per sender. The API picks whichever
  pool has the most free budget right now.
- **Per-IP API rate limit** — every request is checked against a per-client
  token bucket (`enforceRateLimit`) and rejected with `429 + Retry-After` when
  exhausted.
- **Cloudflare guard** — uploads pause before hitting Discord's ~10k requests /
  10 min IP ban (`cloudflareErrorThreshold`).
- Upload retries: up to 5 attempts (5 s base backoff on 429, 1 s on other errors).
  Download retries: up to 2–3 attempts (exponential backoff on 5xx / timeout).

---

## Storage providers, striping & replication

Discord is not the only backend. Blobs are stored through pluggable **providers**
(`LOCAL` disk, `DISCORD` attachments, `TELEGRAM` documents), and every provider
sees only ciphertext — switching or adding one never touches the crypto model.

### Data model

Each logical blob (`BlobTransport`) has one or more **placements**
(`BlobPlacement`) — one row per physical copy at one provider, tagged with a
role (`PRIMARY` | `REPLICA`) and status (`ACTIVE`, `PENDING`, `MISSING`,
`MODIFIED`, `DELETING`). This one table expresses every layout:

| Layout | Placements per blob |
|---|---|
| Single provider | 1 × PRIMARY |
| Striping (speed) | 1 × PRIMARY, chunks spread across providers |
| Mirror (durability) | 1 × PRIMARY + N × REPLICA |
| More copies | add another REPLICA — no code change |

### Choosing providers (striping)

`STORAGE_PRIMARY_PROVIDERS` (comma list) selects which providers receive new
uploads. With more than one, each chunk goes to whichever pool has the most
free rate-limit budget right now, so a saturated or 429-blocked provider sheds
load to the others and throughput adds up. A single value (or the
`BLOB_STORAGE_KIND` fallback) is plain single-provider mode.

Telegram note: the vanilla Bot API caps uploads at 50 MB and downloads at
20 MB, so the standard 10 MiB chunk fits with no client changes. One Telegram
bot maps to one private channel (like a webhook→channel on Discord); scale
throughput by adding bots. `file_id` is a stable download handle, so no CDN-URL
refresh is needed.

### Replication (durability against losing an account)

`STORAGE_REPLICA_PROVIDERS` turns on asynchronous mirroring onto **dedicated
`REPLICA_*` sender pools** — physically separate webhooks/bots/accounts (e.g. a
second Discord server or a different Telegram bot) reserved for copies. Because
their rate-limit budgets are separate, replication runs continuously without
competing with primary uploads.

- Uploads never wait on replication. The response returns after the primary
  write; a durable `PENDING` placement is enqueued and an opportunistic
  write-through copies the in-memory ciphertext to replicas immediately. If that
  fails or the process dies, the background worker retries from any surviving
  copy (with exponential backoff).
- Reads fail over automatically: a dead PRIMARY copy is served from a REPLICA,
  the bad copy is parked `MISSING`, and the worker rebuilds it (self-heal).
- Deletes propagate to every copy — including `PENDING` ones, so a purge can't
  be resurrected by the replication queue.
- `replicationStatus` (GraphQL) exposes queue depth, replication lag, and
  per-pool placement counts for the HealthCheck page.

Losing the primary Discord account then means: point a new instance at the
`REPLICA_*` pool (as its primary) and every replicated file is still readable.

### Migration

The placement table is added by `prisma db push`; run
`npx tsx scripts/backfill-blob-placements.ts` once to create a PRIMARY placement
for every pre-existing blob (idempotent, safe to re-run). Reads fall back to the
legacy `BlobTransport` columns until the backfill completes, so ordering is not
critical. **Back up the database before migrating production.**

Telegram transport can be smoke-tested against a real bot with
`TG_BOT_1=… TG_BOT_1_CHAT=… npx tsx scripts/telegram-smoke.ts`.

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
| `JWT_SECRET` | Random secret for JWT signing |
| `JWT_EXPIRES_IN` | JWT lifetime (default `7d`) |
| `APP_MODE` | `full` (users + auth) or `backend-only` (API key only, no login) |
| `API_KEY` | Required when `APP_MODE=backend-only` |
| `API_PORT` / `FRONTEND_PORT` | Defaults `3000` / `5173` |
| `STORAGE_PRIMARY_PROVIDERS` | Comma list of providers for new uploads (e.g. `DISCORD,TELEGRAM`) |
| `BLOB_STORAGE_KIND` | Single-provider fallback (`LOCAL` \| `DISCORD` \| `TELEGRAM`), used when the above is unset |
| `STORAGE_REPLICA_PROVIDERS` | Providers to asynchronously replicate onto (empty = off) |
| `REPLICATION_CONCURRENCY` | In-process replication worker parallelism (default 2) |
| `DDV_PLUGINS` | Comma list of plugin package names to load |

#### Discord senders

| Variable | Description |
|---|---|
| `WEBHOOK_1..50` | Discord webhook URLs — one per channel for rate limit isolation |
| `BOT_1..20` + `BOT_1..20_CHANNEL` | Optional Discord bots (need `READ_MESSAGE_HISTORY` to serve downloads) |
| `BOT_UPLOADS_ENABLED` | `1` to use bots for uploads too |
| `RELAY_BASE_URL` / `RELAY_WEBHOOK_IDS` | Optional relay sender pool (external relay API + webhook ids) |

#### Telegram senders

| Variable | Description |
|---|---|
| `TG_BOT_1..20` | Telegram bot tokens (`123456:ABC-…`) |
| `TG_BOT_1..20_CHAT` | Private channel/group chat id the bot can post to (e.g. `-1001234567890`) |

#### Replica sender pools (only with `STORAGE_REPLICA_PROVIDERS`)

`REPLICA_WEBHOOK_1..50`, `REPLICA_BOT_n` + `REPLICA_BOT_n_CHANNEL`,
`REPLICA_TG_BOT_n` + `REPLICA_TG_BOT_n_CHAT`.

### 2. Discord webhooks

1. Create a Discord server (or use existing).
2. For each webhook: **Server Settings → Integrations → Webhooks → New Webhook**.
3. **Each webhook must be on a separate channel** — rate limits are per-channel.
4. Copy the webhook URL into `WEBHOOK_1`, `WEBHOOK_2`, etc.

More webhooks = higher parallelism and upload throughput.

### 3. Telegram bot (optional)

Discord is not required — you can run Telegram-only storage, or mix both.

1. Talk to [@BotFather](https://t.me/BotFather) and create a bot → copy the token.
2. Create a **private** channel (or group) and add the bot to it.
3. The bot must be an **admin** of the chat so it can delete its own messages on purge.
4. Get the chat id (starts with `-100…`; e.g. forward a message to
   [@userinfobot](https://t.me/userinfobot) or use `getUpdates`).
5. Set `TG_BOT_1=<token>` and `TG_BOT_1_CHAT=<chat id>` in `.env`.

More bots = more throughput. One bot = one private chat, like webhook→channel.

### 4. Database

```bash
# Start PostgreSQL via Docker
npm run infra:up

# Apply schema
npm run db:push
```

### 5. Install dependencies

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

Tests the full pipeline: generate → encrypt → API upload → provider → API download → decrypt → verify integrity.

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

**Download is ~2× slower than raw provider CDN** because the API acts as a proxy:
`client → API → provider → API → client`. Attachment URLs are private and require
a fresh provider API call per chunk.

---

## How to use — the blob API

### Upload (full flow)

```typescript
import { prepareFileUpload, encryptFileContentChunk, buildEncryptedManifest } from "./lib/crypto";
import { uploadBlobToApi } from "./lib/api";
import { gqlRequest } from "./lib/graphql";

// 1. Generate a per-file root FEK and encrypt the metadata client-side
const { rootFek, wrappedFEK, encryptedName, encryptedMimeType } =
  await prepareFileUpload(filesKey, { fileName: file.name, mimeType: file.type, plaintextSizeBytes: file.size });

// 2. Register the file (GraphQL initUpload)
const { initUpload } = await gqlRequest<{ initUpload: { fileId: string } }>(`
  mutation($encryptedName:String,$encryptedMimeType:String,$wrappedFEK:String!,$totalCiphertextBytes:String!,$chunkCount:Int!) {
    initUpload(encryptedName:$encryptedName,encryptedMimeType:$encryptedMimeType,wrappedFEK:$wrappedFEK,
               totalCiphertextBytes:$totalCiphertextBytes,chunkCount:$chunkCount) { fileId }
  }`,
  { encryptedName, encryptedMimeType, wrappedFEK, totalCiphertextBytes, chunkCount });
const fileId = initUpload.fileId;

// 3. Encrypt and upload each chunk to its own blob
const blobs: UploadedBlobTransportInput[] = [];
for (let i = 0; i < chunkCount; i++) {
  const ciphertext = await encryptFileContentChunk(rootFek, plaintextChunk); // AES-GCM
  const resp = await uploadBlobToApi(`${fileId}:chunk:${i}`, ciphertext);    // PUT /api/blob/:blobId
  blobs.push({ blobId: resp.blobId, storageKind: resp.storageKind, storagePath: resp.storagePath,
               ciphertextSizeBytes: resp.ciphertextSizeBytes });
}

// 4. Encrypt a manifest (chunk → blobId map) and commit
const manifestBlobId = `${fileId}:manifest`;
await uploadBlobToApi(manifestBlobId, await buildEncryptedManifest(rootFek, manifest));
await gqlRequest(`mutation($fileId:ID!,$manifestBlobId:String!,$totalCiphertextBytes:String!,$chunkCount:Int!,$blobs:[UploadedBlobTransportInput!]!) {
  commitManifest(fileId:$fileId,manifestBlobId:$manifestBlobId,totalCiphertextBytes:$totalCiphertextBytes,chunkCount:$chunkCount,blobs:$blobs) { success }
}`, { fileId, manifestBlobId, totalCiphertextBytes, chunkCount, blobs });
```

### Stream video/audio via Service Worker

The SW intercepts `GET /sw-stream/:fileId`, fetches and decrypts blobs on demand,
and responds with proper `206 Partial Content` — compatible with `<video>` and `<audio>` seek.

```typescript
import { registerStream, getStreamUrl, unregisterStream } from "./lib/videoStream";

// 1. Register the file with the SW (unwraps the FEK, fetches + decrypts the manifest)
await registerStream({
  fileId: "clx...",
  mimeType: "video/mp4",
  size: "104857600",
  chunkSize: 10485704,
  chunkCount: 10,
  wrappedFEK: "base64...",
  manifestBlobId: "clx...:manifest",
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
// Register — the SW derives the content key from fekRaw and fetches blobs by id
navigator.serviceWorker.controller.postMessage({
  type: "REGISTER_STREAM",
  fileId: "clx...",
  token: "Bearer eyJ...",
  fekRaw: rawKeyArrayBuffer,     // derived content key (await crypto.subtle.exportKey("raw", contentKey))
  blobIds: ["clx...:chunk:0", "clx...:chunk:1", "…"],   // from the decrypted manifest
  chunkSize: 10485704,
  chunkCount: 10,
  totalSize: 104857600,
  mimeType: "video/mp4",
  chunksAhead: 3,                // chunks to prefetch ahead of playhead
  chunksBehind: 1,               // chunks to keep in cache behind playhead
});

// Unregister (frees memory)
navigator.serviceWorker.controller.postMessage({ type: "UNREGISTER_STREAM", fileId: "clx..." });
```

After `REGISTER_STREAM`, the browser fetches `/sw-stream/clx...` normally.
The SW intercepts it, calls `GET /api/blob/:blobId` per chunk with the auth token,
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
  mutation($wrappedFEK:String!,$totalCiphertextBytes:String!,$chunkCount:Int!) {
    initUpload(wrappedFEK:$wrappedFEK,totalCiphertextBytes:$totalCiphertextBytes,chunkCount:$chunkCount) {
      fileId
    }
  }`,
  { wrappedFEK: "<base64>", totalCiphertextBytes: "10485704", chunkCount: 1 });

// Upload one encrypted chunk blob — the response carries the placement info
const placed = await fetch(`${BASE}/api/blob/${fileId}:chunk:0`, {
  method: "PUT",
  headers: { "X-API-Key": "my-secret-key", "Content-Type": "application/octet-stream" },
  body: encryptedChunkBuffer,   // AES-GCM ciphertext
}).then(r => r.json());         // { blobId, ciphertextSizeBytes, storageKind, storagePath, ... }

// Upload the encrypted manifest and commit
await fetch(`${BASE}/api/blob/${fileId}:manifest`, {
  method: "PUT",
  headers: { "X-API-Key": "my-secret-key", "Content-Type": "application/octet-stream" },
  body: encryptedManifestBuffer,
});

await gql(
  `mutation($fileId:ID!,$manifestBlobId:String!,$totalCiphertextBytes:String!,$chunkCount:Int!,$blobs:[UploadedBlobTransportInput!]!) {
    commitManifest(fileId:$fileId,manifestBlobId:$manifestBlobId,totalCiphertextBytes:$totalCiphertextBytes,chunkCount:$chunkCount,blobs:$blobs) { success }
  }`,
  { fileId, manifestBlobId: `${fileId}:manifest`, totalCiphertextBytes: "10485704", chunkCount: 1,
    blobs: [{ blobId: placed.blobId, storageKind: placed.storageKind, storagePath: placed.storagePath,
              ciphertextSizeBytes: placed.ciphertextSizeBytes }] });

// Download a blob (returns encrypted bytes — decrypt with the content key)
const chunk = await fetch(`${BASE}/api/blob/${fileId}:chunk:0`,
  { headers: { "X-API-Key": "my-secret-key" } }
).then(r => r.arrayBuffer());

// Delete
await gql(`mutation { deleteFile(fileId: "${fileId}") }`);
```

---

## Key Management

DiscorDrive is zero-knowledge end to end. The server stores only wrapped key
material and a password-derived auth proof; it never sees a plaintext key,
password, or file byte. All key derivation and wrapping happens in the browser
(`apps/frontend/src/lib/crypto.ts` + `packages/processing`).

### Keys

| Key | Algorithm | Purpose | Where it lives |
|---|---|---|---|
| ARK (Account Root Key) | AES-GCM 256-bit | Root of the user's identity — wraps the Files Key | Wrapped by password in DB (`wrappedARKByPassword`); plaintext only in memory |
| Files Key (domain key) | AES-GCM 256-bit | Wraps every file's Root FEK and every folder key | Wrapped by ARK in DB (`wrappedFilesKey`) |
| Root FEK (per file) | AES-GCM 256-bit | Encrypts file metadata + manifest, derives per-chunk content keys | Wrapped by Files Key in DB (`wrappedFEK`) |
| Content Key (per chunk) | AES-GCM 256-bit | Encrypts one chunk's plaintext | Derived from Root FEK, never stored |
| Share Key | AES-GCM 256-bit | Wraps the Root FEK for public shares | Never stored — share link derives it from a secret embedded in the URL |
| API Key | — | Authenticates scripts without a password | Server stores only the authPart hash + a wrapped ARK |

### Key hierarchy

```
password + salt
     │
     │  Argon2id (single run — memoryKB 19456, iterations 2, parallelism 1)
     ▼
  arkWrapKey ──────► serverAuthProof   (hash stored server-side; server never sees the password)
     │
     │  AES-GCM wrap
     ▼
   ARK ──AES-GCM wrap──► wrappedFilesKey  ← DB: UserCrypto
  (memory)
     │
     │  unwrap on login (client only)
     ▼
 Files Key ──AES-GCM wrap──► wrappedFEK  ← DB: File
  (memory)
     │
     │  unwrap per file (client only)
     ▼
  Root FEK ──derive──► contentKey ──AES-GCM──► [12B IV | ciphertext | 16B tag]
  (memory)                                        one unique IV per chunk
```

### Lifecycle

**Registration** — [`registerCrypto()`](apps/frontend/src/lib/crypto.ts)
1. Client generates a random salt + a fresh ARK, Files Key and Root FEK.
2. A single Argon2id run derives both the ARK-wrapping key **and** the server auth proof.
3. Client wraps the ARK with the password-derived key (`wrappedARKByPassword`)
   and the Files Key with the ARK (`wrappedFilesKey`).
4. Client sends the wrapped material + auth proof hash to the server — ARK,
   Files Key and password never leave the client.

**Login** — challenge-based, no password over the wire
1. Client fetches `getLoginChallenge` (the user's Argon2id params + salt).
2. Client derives `arkWrapKey` + `serverAuthProof` locally, unwraps the ARK.
3. Client sends only `serverAuthProof`; the server compares its hash
   (`timing-safe equal`). No password, no raw key is transmitted.
4. Named device logins create a **revocable session**: a long-lived refresh token
   (stored hashed) + a 1 h JWT bound to the session via the `sid` claim.

**File upload** — [`prepareFileUpload()`](apps/frontend/src/lib/crypto.ts)
1. Client generates a fresh Root FEK per file and encrypts name/mimeType with it.
2. Client wraps the Root FEK with the Files Key (`wrappedFEK`) and sends it via `initUpload`.
3. Each chunk is encrypted with a content key derived from the Root FEK
   (`deriveFileContentKey`); the manifest is encrypted with the Root FEK and uploaded.
4. `commitManifest` records the manifest blob + per-chunk blob ids.

**File download** — [`downloadFile()`](apps/frontend/src/lib/download.ts)
1. Client unwraps the Root FEK with the Files Key.
2. Client fetches + decrypts the manifest, then each chunk blob; decrypts with the
   derived content key.

**API keys** — [`prepareApiKey()`](apps/frontend/src/lib/crypto.ts)
1. Client mints a two-half secret: `authPart` (server-authenticates) + `cryptoPart`
   (never leaves the client).
2. Server stores only the `authPart` hash and an ARK wrapped by a key derived
   from `cryptoPart` (`wrappedARKByKey`) — it can never reconstruct the key.
3. The full secret `ddv4_<authPart>.<cryptoPart>` is shown once; losing it means
   the key can never decrypt again (by design).
4. Revoking a key clears the wrapped ARK — cutting off decryption, not just auth.

**Share links** — [`prepareShareLink()`](apps/frontend/src/lib/crypto.ts)
1. Client derives wrap/auth keys + a capability token from a random link secret.
2. A fresh Share Key wraps the Root FEK; the capability token goes in the URL.
3. Recipient unwraps the Share Key from the link secret → unwraps the FEK →
   `GET /api/share/blob/:blobId` (capability token, no login).
4. Optionally password-protected (Argon2id hash stored in DB).

**Password change** — [`changePassword` mutation](apps/api/src/resolvers/auth.ts)
1. Client proves the current password (`currentServerAuthProof`), re-derives the
   ARK wrap key and re-wraps the ARK under the new password.
2. Server updates the wrapped ARK + new auth proof in a single transaction.

### What the server never sees

- Raw password (only the Argon2id-derived auth proof, stored hashed)
- ARK, Files Key, Root FEK or any content key in plaintext
- File content in plaintext — every byte stored on any provider is AES-GCM encrypted

### Client-side persistence

| Data | Storage | Cleared on |
|---|---|---|
| JWT / refresh token | `localStorage` / session storage | Manual logout / session revocation |
| `wrappedARKByPassword`, `wrappedFilesKey`, `argon2Params` | `localStorage` | Manual logout |
| ARK + Files Key (`CryptoKey`) | Memory (Zustand) | Page refresh / lock |
| Root FEK / content keys | Memory (SW) | Upload/download complete |

Page refresh clears the ARK — the user must re-enter their password to unlock
("Unlock" flow re-derives the wrap key and unwraps the ARK without a network
round-trip).

### Algorithms

| Component | Algorithm | Parameters |
|---|---|---|
| Login material derivation | Argon2id | Defaults: 19456 KiB memory, 2 iterations, parallelism 1, 256-bit output (per-user params stored with the account) |
| Key wrapping (ARK, Files Key, FEK, Share) | AES-GCM | 256-bit key, 12-byte random IV per wrap operation |
| Chunk encryption | AES-GCM | 256-bit content key, 12-byte random IV prepended to each chunk |
| Server auth proof | SHA-256 | Hash of the derived proof, compared with `timingSafeEqual` |
| File integrity | SHA-256 | Hash of original plaintext, stored after upload, verified after download |

---

## Package structure

```
apps/
  api/            — Node.js http server + GraphQL Yoga (GraphQL + REST blob endpoints)
  frontend/       — React app + Vite + Service Worker (streaming, upload/download)
  mobile/         — Mobile app

packages/
  config/         — Shared config (chunk size, concurrency defaults; browser-safe constants)
  database/       — Prisma schema + client
  discord-client/ — Discord webhook/bot upload/download/delete with rate limiting + retry
  telegram-client/— Telegram Bot API client (file_id upload/download/delete)
  processing/     — AES-GCM encrypt/decrypt, key derivation, chunk streaming, manifest crypto
  stream-engine/  — UploadEngine + DownloadEngine (browser and Node.js compatible)
  redis/          — Cache layer
  plugin-sdk/     — Plugin API (route dispatch + GraphQL extension hooks)
  types/          — Shared types across packages and apps

plugins/
  gallery/        — Example plugin (loaded via DDV_PLUGINS)

scripts/
  benchmark.ts      — Local crypto-only benchmark
  benchmark-e2e.ts  — Full E2E pipeline benchmark (batch + streaming modes)
  bench-utils.ts    — Shared formatting/timing helpers
  backfill-blob-placements.ts — Create PRIMARY placements for legacy blobs
  telegram-smoke.ts — Smoke-test Telegram transport against a real bot

infra/
  docker-compose.yml — PostgreSQL + pgAdmin + Redis
```
