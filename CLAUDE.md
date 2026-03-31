# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**DiscorDrive v4** — an encrypted cloud storage system that uses Discord webhooks as the storage backend. Files are split into 10 MiB chunks, encrypted client-side with AES-GCM, and uploaded as Discord message attachments. Zero-knowledge architecture: the server never sees plaintext keys or file content.

## Commands

```bash
# Development
npm run dev:api           # Start API server in watch mode (port 3000)
npm run dev:frontend      # Start frontend dev server (port 5173)
npm run build             # Build all workspaces
npm run typecheck         # TypeScript type checking (no separate test suite)

# Database
npm run db:generate       # Generate Prisma client after schema changes
npm run db:push           # Apply schema to database (dev)

# Infrastructure
npm run infra:up          # Start Docker stack (PostgreSQL, pgAdmin, Redis)
npm run infra:down        # Stop Docker stack

# Benchmarking
npm run benchmark         # Local crypto-only throughput test
npm run benchmark:e2e -- [fileSize] [concurrency] [--stream]
```

There is no dedicated test runner — type correctness is verified via `npm run typecheck`.

## Monorepo Structure

```
apps/
  api/          — Hono HTTP server (GraphQL + REST endpoints)
  frontend/     — React + Vite SPA with Service Worker
packages/
  config/       — Shared constants (chunk size, concurrency, crypto params)
  types/        — TypeScript domain types (User, File, Chunk, Folder, ShareLink, enums)
  database/     — Prisma ORM + schema
  discord-client/ — Webhook upload/download/delete with rate limiting + retries
  processing/   — AES-GCM crypto, chunking, SHA-256 hashing (browser + Node)
  stream-engine/ — Upload/download pipeline orchestration (concurrent, encrypted)
  redis/        — Redis client wrapper (optional)
  plugin-sdk/   — Plugin system for extending GraphQL schema
```

Workspace packages use the `@discordrive/*` namespace.

## Architecture: Upload Pipeline

1. Frontend generates a FEK (File Encryption Key), wraps it with the Master Key
2. `initUpload()` GraphQL mutation registers the file in DB
3. File is handed off to the **Service Worker** (`apps/frontend/src/sw/stream-sw.ts`) via `postMessage()` with zero-copy ArrayBuffer transfer
4. SW streams chunks via `chunkFileStream()` → encrypts each with AES-GCM → uploads concurrently to `POST /api/upload/:fileId/chunk/:index`
5. API handler routes to the least-loaded Discord webhook via `WebhookRateLimiter`
6. Discord stores each chunk as a message attachment; metadata (messageId, channelId, webhookId) is saved to the `Chunk` DB table
7. `finalizeUpload()` mutation stores SHA-256 hash and marks file READY

## Architecture: Download / Video Streaming

1. Frontend fetches `encryptedFEK + fekIv` from DB, decrypts FEK with Master Key
2. Service Worker intercepts fetch to `/sw-stream/:fileId` and stores the FEK
3. Browser opens a `<video>` pointing to `/sw-stream/:fileId`
4. SW intercepts range requests → calls `GET /api/download/:fileId/chunk/:n`
5. API fetches fresh Discord CDN URL for the chunk → streams bytes to SW
6. SW decrypts each chunk and assembles into a ReadableStream with proper 206 Partial Content support

## Key Management Hierarchy

```
password + kekSalt → Argon2id → KEK
KEK → unwrap → Master Key (in-memory only, Zustand store)
Master Key → wrap → FEK (per-file, stored in DB as encryptedFEK)
FEK → encrypt/decrypt → individual 10 MiB chunks
Share links: FEK wrapped with Share Key embedded in the URL
```

- Argon2id params: 64 MB memory, 3 iterations, parallelism 4
- AES-GCM 256-bit with 12-byte random IV per chunk
- Master Key lives only in memory — cleared on page refresh

## Two App Modes

Controlled by `APP_MODE` env var:
- **`full`** — complete app with user accounts, auth, frontend, folders
- **`backend-only`** — API-only with `X-API-Key` header authentication (no user accounts); designed for scripts and automation

## Critical Files to Know

| File | Purpose |
|------|---------|
| `apps/api/src/index.ts` | Server entry, routing |
| `apps/api/src/schema.ts` | GraphQL schema + resolvers wiring |
| `apps/api/src/handlers/upload.ts` | Receives encrypted chunks, sends to Discord |
| `apps/api/src/handlers/download.ts` | Fetches Discord CDN chunks, streams to client |
| `apps/api/src/middleware/auth.ts` | JWT / API key verification |
| `apps/frontend/src/sw/stream-sw.ts` | Service Worker — upload, download, video |
| `apps/frontend/src/lib/crypto.ts` | Client-side key generation + wrapping |
| `packages/discord-client/src/rate-limiter.ts` | Per-webhook Discord rate limiting |
| `packages/discord-client/src/uploader.ts` | Chunk upload with 5-attempt retry |
| `packages/discord-client/src/downloader.ts` | Chunk fetch with 3-attempt retry + CDN cache |
| `packages/processing/src/crypto.ts` | AES-GCM encrypt/decrypt, shared browser+Node |
| `packages/database/prisma/schema.prisma` | DB schema (User, File, Chunk, Folder, ShareLink, Setting) |

## Chunk Sizing

- Plaintext chunk: 10 MiB − 28 bytes (to stay within Discord's 10 MiB limit after encryption)
- Encryption overhead: 12 bytes IV + 16 bytes GCM auth tag = 28 bytes
- Result: each encrypted chunk is exactly 10 MiB

## Environment Setup

Copy `.env.example` to `.env`. Required variables:
- `DATABASE_URL` — PostgreSQL connection string
- `WEBHOOK_1`…`WEBHOOK_N` — Discord webhook URLs (one per channel; more = better throughput)
- `JWT_SECRET` — random string
- `APP_MODE` — `full` or `backend-only`
- `API_KEY` — required when `APP_MODE=backend-only`

Run `npm run infra:up` before `npm run db:push` to ensure the database is available.

## Plugin System

`apps/api/src/plugin-registry.ts` loads plugins that extend the GraphQL schema. Plugins use `@discordrive/plugin-sdk` and can add new types, queries, and mutations.
