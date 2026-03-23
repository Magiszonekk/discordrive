# DiscorDrive v4

Self-hosted cloud storage that uses Discord webhooks as the file storage backend. Files are split into chunks, encrypted end-to-end with AES-256-GCM, and stored as Discord message attachments. Metadata lives in PostgreSQL.

**Designed for large-scale archival** — e.g. ~14 TB of MP4 files (~400 MB each, ~35k files) with infrequent access patterns.

---

## Requirements

- Node.js 20+
- Docker (for PostgreSQL + Redis via `infra/docker-compose.yml`)
- At least one Discord webhook URL

---

## Quick Start

```bash
# 1. Copy and fill in environment config
cp .env.example .env

# 2. Install dependencies
npm install

# 3. Start infrastructure (PostgreSQL, Redis)
npm run infra:up

# 4. Set up the database
npm run db:generate
npm run db:push

# 5. Start the API and frontend
npm run dev:api
npm run dev:frontend
```

- API: http://localhost:3000
- Frontend: http://localhost:5173

---

## Application Modes

DiscorDrive supports two modes controlled by the `APP_MODE` environment variable.

### `full` mode (default)

Full application with user accounts, JWT authentication, frontend UI, and folder organization.

```env
APP_MODE=full
JWT_SECRET=your-random-secret
```

- Users register and login via the frontend
- All requests authenticated with JWT Bearer tokens
- Folder hierarchy available
- E2E encryption keys derived from user's master password

### `backend-only` mode

API-only mode without user accounts. Designed for using DiscorDrive as a pure storage backend from your own scripts or tools.

```env
APP_MODE=backend-only
API_KEY=your-secret-api-key   # optional — if empty, API is open
```

**What changes:**
- No user registration/login — a system user is created automatically
- Authentication via `X-API-Key` header instead of JWT
- Folders are disabled (all files are flat)
- `me`, `register`, `login`, `changePassword` endpoints return errors
- Sharing still works (anonymous share links)
- Frontend is not needed

**Using the API in backend-only mode:**

```bash
# GraphQL — initUpload (API key in header)
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-secret-api-key" \
  -d '{"query": "mutation { initUpload(name: \"test.bin\", mimeType: \"application/octet-stream\", size: \"1048576\", chunkSize: 1048576, chunkCount: 1, encryptedFEK: \"...\", fekIv: \"...\") { fileId } }"}'

# Upload chunk
curl -X POST http://localhost:3000/api/upload/FILE_ID/chunk/0 \
  -H "X-API-Key: your-secret-api-key" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @chunk.enc

# Download chunk
curl http://localhost:3000/api/download/FILE_ID/chunk/0 \
  -H "X-API-Key: your-secret-api-key" \
  -o chunk.enc
```

If `API_KEY` is not set in `.env`, all requests are accepted without authentication.

### Mode comparison

| Feature | `full` | `backend-only` |
|---|---|---|
| User accounts | Yes | No (system user) |
| Authentication | JWT Bearer token | `X-API-Key` header |
| Frontend UI | Yes | Not needed |
| Folders | Yes | Disabled |
| File upload/download | Yes | Yes |
| Sharing | Yes | Yes |
| Encryption | E2E (user-derived keys) | Caller manages keys |

---

## Environment Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `WEBHOOK_1` … `WEBHOOK_50` | Discord webhook URLs (one per channel) |
| `JWT_SECRET` | Secret for JWT signing (full mode) |
| `APP_MODE` | `full` (default) or `backend-only` |
| `API_KEY` | API key for backend-only mode (optional) |
| `API_URL` | Public API URL (for CORS) |
| `FRONTEND_URL` | Public frontend URL (for CORS) |

> **Important:** Each webhook must be on a **separate Discord channel** for proper rate limit isolation. More webhooks = higher throughput (see Benchmark section).

---

## Benchmark

The benchmark tests the full **Generate → Upload → Download → Delete** pipeline against your configured Discord webhooks and prints timing and throughput stats.

### Running the benchmark

```bash
# Default: 25 MB test file
npm run benchmark

# Custom file size — accepts units
npm run benchmark -- 100        # 100 MB (default unit)
npm run benchmark -- 100MB      # 100 MB
npm run benchmark -- 2GB        # 2 GB
npm run benchmark -- 2.5GB      # 2.5 GB
npm run benchmark -- 500KB      # 500 KB

# Custom concurrency (second argument)
npm run benchmark -- 1GB 10     # 1 GB with 10 concurrent workers
```

### Arguments

| Argument | Position | Default | Description |
|---|---|---|---|
| `fileSize` | 1st | `25` (MB) | Size of the test file. Accepts: `100`, `100MB`, `2GB`, `500KB` |
| `concurrency` | 2nd | number of webhooks | Max parallel uploads/downloads |

### What it does

1. **Generate** — Creates random byte data split into chunks (default 10 MB each)
2. **Upload** — Uploads all chunks concurrently via webhooks with rate limit awareness
3. **Download** — Streams all chunks back concurrently from Discord CDN
4. **Delete** — Removes all uploaded Discord messages (cleanup)

### Example output

```
═══════════════════════════════════════════
  DiscorDrive Benchmark
═══════════════════════════════════════════
  File size:    9.77 GB
  Chunk size:   10.0 MB
  Chunk count:  1000
  Webhooks:     20
  Concurrency:  20
═══════════════════════════════════════════

Uploading 1000 chunks (concurrency: 20)...
  Upload: 1000/1000 (100%) — 59.19 MB/s
  Upload complete: 2.82min (59.19 MB/s)

Downloading 1000 chunks (concurrency: 20)...
  Download: 1000/1000 (100%) — 105.64 MB/s
  Download complete: 1.58min (105.64 MB/s)

Deleting 1000 messages (concurrency: 5)...
  Delete: 1000/1000 (100%) — 9.5 msgs/s
  Delete complete: 1.75min

═══════════════════════════════════════════
  RESULTS
═══════════════════════════════════════════
  Upload total              2.82min (59.19 MB/s)
  Download total            1.58min (105.64 MB/s)
  Delete total              1.75min
  ──────────────────────────────────────────
  Total                     6.15min
═══════════════════════════════════════════
```

### Requirements

- `.env` with at least `WEBHOOK_1` set
- Infrastructure running (`npm run infra:up`)

### Expected throughput

| Webhooks | Upload | Download |
|---|---|---|
| 1 | ~10–15 MB/s | ~15–20 MB/s |
| 5 | ~50–75 MB/s | ~75–100 MB/s |
| 20 | ~60 MB/s* | ~105 MB/s* |

*Actual throughput depends on your internet connection. With 20 webhooks the bottleneck is typically your upload/download bandwidth, not Discord.

Up to 50 webhooks are supported (`WEBHOOK_1` through `WEBHOOK_50`).

---

## npm Scripts

| Script | Description |
|---|---|
| `npm run dev:api` | Start the API server in watch mode (port 3000) |
| `npm run dev:frontend` | Start the Vite frontend dev server (port 5173) |
| `npm run infra:up` | Start PostgreSQL + Redis via Docker Compose |
| `npm run infra:down` | Stop infrastructure containers |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:push` | Sync Prisma schema to the database |
| `npm run benchmark` | Run the upload/download benchmark |
| `npm run build` | Build all workspaces |
| `npm run typecheck` | Run TypeScript type checking across the monorepo |

---

## Architecture

### Stack

- **Backend:** TypeScript, GraphQL Yoga, Node.js HTTP, Prisma, PostgreSQL, Redis
- **Frontend:** React 19, Vite, TypeScript
- **Storage:** Discord webhooks (raw HTTP, no Discord.js)
- **Encryption:** AES-256-GCM per chunk, keys derived with Argon2id

### Encryption key hierarchy

```
Master Password
  └─► Argon2id ──► KEK (Key Encryption Key)
        └─► decrypt ──► Master Key (in memory only)
              └─► per-file ──► File Encryption Key
                    └─► per-chunk ──► AES-256-GCM (IV prepended to chunk)
```

### Monorepo structure

```
ddv4/
├── apps/
│   ├── api/          # GraphQL + HTTP API server
│   └── frontend/     # React SPA
├── packages/
│   ├── config/       # Shared config (env vars, DB config)
│   ├── database/     # Prisma schema + client
│   ├── discord-client/ # Webhook uploader/downloader/deleter + rate limiter
│   ├── processing/   # Chunking, encryption, hashing
│   ├── redis/        # Redis client
│   └── types/        # Shared TypeScript types
├── infra/
│   └── docker-compose.yml  # PostgreSQL, pgAdmin, Redis
└── scripts/
    └── benchmark.ts  # Benchmark script
```
