# Phase B — Discord blob substrate plan

**Goal:** Replace the temporary local blob substrate from Phase A with the real Discord-backed ciphertext transport, while preserving the secure-files-v2 crypto/runtime contract already proven on local storage.

**Non-goals:**
- No rollback to plaintext metadata.
- No change to manifest-driven download semantics.
- No change to capability-token share design.
- No migration compatibility layer for old DiscorDrive v1 data.

---

## Definition of Phase B

Phase B starts where Phase A ended:
- upload/download/share already work against local ciphertext blobs,
- frontend already uses manifest-driven fetch + decrypt,
- backend already treats `blobId` as transport lookup, not plaintext source of truth.

Phase B changes only the **blob substrate**:
- from `BlobTransport.storageKind = LOCAL` + filesystem path
- to Discord-backed transport records and fetch/upload adapters.

---

## Success criteria

Phase B is done when all of the following are true:
- ciphertext chunk blobs and manifest blobs are uploaded to Discord transport, not local disk
- `BlobTransport` records store Discord transport coordinates and health state
- owner upload/download still work without changing the secure-files cryptographic envelope
- share download still works through the same capability-token + manifest chain
- transport retries / rate-limit handling are built in
- integrity/health checks can detect missing or modified blobs
- `npm run typecheck` passes
- `npm test` passes
- dedicated Discord-substrate smoke/E2E passes

---

## Task 1 — Expand BlobTransport for Discord substrate

**Objective:** Replace the temporary local-only shape with a transport model that can represent Discord-backed blobs cleanly.

**Files:**
- `packages/database/prisma/schema.prisma`
- `packages/types/src/index.ts`
- `packages/types/src/api.ts`
- `packages/database/src/__tests__/schema-shape.test.ts`

**Changes:**
- Extend `BlobStorageKind` from `LOCAL` to at least:
  - `LOCAL`
  - `DISCORD`
- Add Discord transport fields to `BlobTransport`, e.g.:
  - `discordChannelId`
  - `discordMessageId`
  - `discordAttachmentUrl`
  - optional `webhookSlot`
- Keep generic integrity fields:
  - `ciphertextSizeBytes`
  - `ciphertextHash`
  - `healthStatus`
  - `healthCheckedAt`
- Preserve ability to keep `LOCAL` for dev/test if desired.

**Verification:**
- `npm run db:generate`
- `npm run test --workspace=@ddv4/database -- schema-shape`

---

## Task 2 — Add Discord blob adapter in API

**Objective:** Create a dedicated transport adapter for Discord upload/download operations.

**Files:**
- create `apps/api/src/storage/discord-blobs.ts`
- modify `apps/api/src/handlers/blob.ts`
- modify `apps/api/src/index.ts` if routing or config branching is needed

**Changes:**
- Add helpers like:
  - `uploadCiphertextBlobToDiscord(...)`
  - `fetchCiphertextBlobFromDiscord(...)`
  - `statDiscordBlob(...)`
- Wrap Discord webhook/message logic behind one adapter boundary.
- Keep local adapter intact for fallback/dev mode.

**Verification:**
- adapter unit tests or mocked transport tests
- no direct Discord calls outside adapter module

---

## Task 3 — Add transport selection/config

**Objective:** Make runtime substrate explicit and configurable.

**Files:**
- `packages/config/...`
- `apps/api/src/handlers/blob.ts`
- `.env.example` or docs

**Changes:**
- Add config like:
  - `BLOB_STORAGE_KIND=LOCAL|DISCORD`
- Route upload/download/metadata operations through the selected adapter.
- Default dev mode may remain `LOCAL`; production target becomes `DISCORD`.

**Verification:**
- smoke both config branches

---

## Task 4 — Implement Discord upload path

**Objective:** `PUT /api/blob/:blobId` should store ciphertext on Discord when Discord mode is enabled.

**Files:**
- `apps/api/src/handlers/blob.ts`
- `apps/api/src/storage/discord-blobs.ts`
- tests under `apps/api/src/__tests__/integration/...`

**Changes:**
- Upload raw ciphertext bytes as Discord attachment(s)
- Persist resulting transport metadata in `BlobTransport`
- Preserve existing hash/size accounting
- Keep API response contract unchanged for frontend

**Verification:**
- upload route integration test
- DB record contains Discord transport metadata

---

## Task 5 — Implement Discord fetch path

**Objective:** `GET /api/blob/:blobId` and `/meta` should resolve ciphertext from Discord transport records.

**Files:**
- `apps/api/src/handlers/blob.ts`
- `apps/api/src/storage/discord-blobs.ts`
- tests under `apps/api/src/__tests__/integration/...`

**Changes:**
- Resolve `blobId` to Discord record
- Fetch raw ciphertext bytes from Discord attachment URL / message source
- Return exact ciphertext body unchanged
- `/meta` exposes transport metadata without leaking plaintext semantics

**Verification:**
- round-trip test: upload via Discord adapter -> fetch body -> bytes identical

---

## Task 6 — Add rate-limit, retry, and backoff handling

**Objective:** Make Discord transport production-safe.

**Files:**
- `apps/api/src/storage/discord-blobs.ts`
- optional queue/retry helpers
- tests

**Changes:**
- Handle 429 responses explicitly
- Add retry/backoff policy
- Support webhook/channel slot rotation if configured
- Surface stable failure modes to API callers

**Verification:**
- mocked retry tests
- no silent partial success

---

## Task 7 — Health checks and blob integrity audit

**Objective:** Detect missing or altered Discord blobs and expose health state.

**Files:**
- `apps/api/src/storage/discord-blobs.ts`
- optional audit script/cron
- `BlobTransport` updater logic

**Changes:**
- Re-fetch blob headers/body when auditing
- compare size/hash against recorded metadata
- set `healthStatus` to `healthy | missing | modified`
- stamp `healthCheckedAt`

**Verification:**
- audit test with simulated missing/modified blob

---

## Task 8 — Preserve Phase A frontend contract unchanged

**Objective:** Frontend should not care whether substrate is local or Discord.

**Files:**
- usually none or minimal frontend docs/tests

**Changes:**
- Keep existing frontend assumptions intact:
  - upload raw ciphertext blob
  - fetch blob body by `blobId`
  - decrypt manifest/chunks locally
- If any frontend change is needed, it should only improve UX/observability, not alter crypto contract.

**Verification:**
- owner upload/download still pass with no conceptual flow changes
- share flow still passes

---

## Task 9 — Discord-substrate smoke and E2E validation

**Objective:** Prove the same secure-files-v2 runtime works on Discord substrate.

**Files:**
- integration tests
- E2E smoke script(s)
- `docs/hermes/attempt_log.md`

**Validation flow:**
1. register
2. login
3. upload small text file
4. owner download and assert content
5. create share
6. open share in fresh browser/session
7. shared download and assert content
8. run blob health audit

**Required commands:**
- `npm run typecheck`
- `npm test`
- dedicated Discord-substrate smoke/E2E command

---

## Architectural notes

- The confidentiality boundary does **not** move in Phase B.
- Discord remains an untrusted ciphertext blob substrate.
- The server still must not become a plaintext metadata oracle or chunk-order oracle.
- The manifest remains the source of truth for chunk ordering and blob membership.
- Share capability semantics remain unchanged; only blob transport changes.

---

## Recommended execution order

1. BlobTransport schema expansion
2. Discord adapter
3. config switch
4. upload path
5. fetch path
6. retry/rate-limit hardening
7. health audit
8. end-to-end validation
