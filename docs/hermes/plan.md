# DiscorDrive Secure Files v2 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace the current plaintext-heavy DiscorDrive file model with the new secure files architecture from `docs/hermes/discordrive-gallery-compatible-threat-model.ts`, assuming all existing data may be deleted and no migration is needed.

**Architecture:** This is a destructive schema-and-flow rewrite. We will reset the database model, rebuild crypto around ARK + domain keys + one wrapped root FEK with HKDF subkeys, move file metadata and chunk manifests into encrypted blobs, and replace legacy share links with capability-token-based file-only shares. The backend will keep only minimum routing/authorization metadata plus Discord transport records.

**Tech Stack:** TypeScript monorepo, Prisma/PostgreSQL, GraphQL Yoga, Web Crypto API, hash-wasm Argon2id, Discord webhook/message blob transport, Vitest.

---

## Global implementation rules

- **No migration work.** Existing DB contents may be dropped. Prefer schema reset over compatibility shims.
- **TDD required.** Every production change starts with a failing test.
- **Do not leave repo in a half-RED state.** If interrupted, stabilize before stopping.
- **No plaintext filename/mimeType storage in server schema.** If any step needs temporary plaintext for debugging, remove it before final verification.
- **Server must not become chunk-order oracle.** The decrypted manifest is the source of truth.

---

## Phase 0 — Freeze target and remove ambiguity

### Task 0.1: Create the implementation checklist doc

**Objective:** Create a compact checklist derived from the spec so implementation can verify every mandatory invariant.

**Files:**
- Create: `docs/hermes/implementation-checklist.md`
- Source: `docs/hermes/discordrive-gallery-compatible-threat-model.ts`

**Step 1: Write the checklist**

Create a markdown checklist with sections:
- Crypto envelope
- Prisma schema
- API boundary
- Upload lifecycle
- Share flow
- Tests

Include explicit checkboxes for:
- `FileRecord.status`
- `primaryManifestBlobId nullable until ready`
- `wrappedFEK` only (not dual FEK)
- client-presented `blobId` fetch contract
- `shareType: 'file'`

**Step 2: Save file**

No test needed — documentation artifact.

**Step 3: Commit**

```bash
git add docs/hermes/implementation-checklist.md
git commit -m "docs: add secure files implementation checklist"
```

---

## Phase 1 — Replace the database schema completely

### Task 1.1: Rewrite Prisma schema to target model

**Objective:** Replace the legacy Prisma schema with the new secure-files entities, removing plaintext filename/mimeType/share-link structures.

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Test: `packages/database/src/__tests__/schema-shape.test.ts`

**Step 1: Write failing schema-shape test**

Create a test that loads Prisma DMMF or generated client metadata and asserts the new models/fields exist:
- `UserCryptoRecord`-equivalent persisted model (name can be `UserCrypto` or folded into `User` + crypto table, but fields must exist)
- `DomainKey`
- `File`
- `BlobTransport`
- `Folder`
- `Share`
- `GrantedAccess`
- `ShareWrappedObjectKey`

And asserts removed legacy fields are gone:
- `File.name`
- `File.mimeType`
- `File.encryptedFEK`
- `ShareLink.token`
- `ShareLink.wrappedFEK`

**Step 2: Run test to verify failure**

Run:
```bash
npm run test --workspace=@ddv4/database -- schema-shape
```
Expected: FAIL — old schema still present.

**Step 3: Rewrite `schema.prisma`**

Target model should include at least:
- `User`
- `UserCrypto`
- `DomainKey`
- `File`
- `Folder`
- `BlobTransport`
- `Share`
- `GrantedAccess`
- `ShareWrappedObjectKey`

Recommended `File` persisted shape:
```prisma
model File {
  id                    String   @id @default(cuid())
  ownerUserId           String
  parentFolderId        String?
  dedupeTokenB64        String?
  primaryManifestBlobId String?
  previewBlobId         String?
  wrappedFEK            Bytes
  wrappedFEKPreview     Bytes?
  status                FileStatus @default(UPLOADING)
  totalCiphertextBytes  BigInt
  chunkCount            Int
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  deletedAt             DateTime?
}
```

Recommended enum:
```prisma
enum FileStatus {
  UPLOADING
  READY
  FAILED
}
```

**Step 4: Run Prisma generate**

Run:
```bash
npm run db:generate
```
Expected: PASS

**Step 5: Run test to verify pass**

Run:
```bash
npm run test --workspace=@ddv4/database -- schema-shape
```
Expected: PASS

**Step 6: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/src/__tests__/schema-shape.test.ts
git commit -m "feat: replace prisma schema with secure files model"
```

### Task 1.2: Add destructive reset workflow for local development

**Objective:** Since migration is not needed, add an explicit reset script that drops/recreates schema cleanly.

**Files:**
- Modify: `packages/database/package.json`
- Optional create: `scripts/reset-secure-files.ts`
- Test: none required if command is simple and verified manually

**Step 1: Add script**

Add one of:
```json
"db:reset": "dotenv -e ../../.env -- prisma migrate reset --force --skip-seed"
```
or
```json
"db:push:force": "dotenv -e ../../.env -- prisma db push --force-reset"
```

Prefer `db push --force-reset` if migrations are intentionally skipped.

**Step 2: Verify command**

Run:
```bash
npm run db:push:force --workspace=@ddv4/database
```
Expected: PASS — schema reset and reapplied.

**Step 3: Commit**

```bash
git add packages/database/package.json
git commit -m "chore: add destructive secure files db reset script"
```

---

## Phase 2 — Rebuild crypto around ARK + domain keys + root FEK

### Task 2.1: Add failing crypto tests for ARK/domain/root-FEK model

**Objective:** Lock the new crypto contract before implementation.

**Files:**
- Create: `packages/processing/src/__tests__/secure-files-crypto.test.ts`
- Modify later: `packages/processing/src/crypto.ts`
- Modify later: `packages/processing/src/index.ts`

**Step 1: Write failing tests**

Add tests for:
1. password KEK unwraps ARK successfully
2. ARK unwraps files domain key successfully
3. root FEK derives deterministic content + metadata subkeys via HKDF
4. content subkey != metadata subkey
5. share capability token derivation is deterministic
6. wrong key fails unwrap

Example shape:
```ts
it('derives distinct content and metadata keys from root FEK', async () => {
  const root = await generateRootFEK();
  const content = await deriveFileContentKey(root);
  const metadata = await deriveFileMetadataKey(root);
  expect(await exportKey(content)).not.toEqual(await exportKey(metadata));
});
```

**Step 2: Run test to verify failure**

Run:
```bash
npm run test --workspace=@ddv4/processing -- secure-files-crypto
```
Expected: FAIL — functions missing.

**Step 3: Implement minimal crypto API**

Add to `packages/processing/src/crypto.ts` and re-export from `index.ts`:
- `generateARK`
- `wrapARKWithPassword`
- `unwrapARKWithPassword`
- `generateDomainKey`
- `wrapDomainKey`
- `unwrapDomainKey`
- `generateRootFEK`
- `deriveFileContentKey`
- `deriveFileMetadataKey`
- `deriveShareWrapKey`
- `deriveShareAuthKey`
- `deriveShareCapabilityToken`
- `constantTimeEqual`

Use Web Crypto for AES-GCM and HKDF.

**Step 4: Run test to verify pass**

Run:
```bash
npm run test --workspace=@ddv4/processing -- secure-files-crypto
```
Expected: PASS

**Step 5: Run full processing tests**

Run:
```bash
npm run test --workspace=@ddv4/processing
```
Expected: PASS

**Step 6: Commit**

```bash
git add packages/processing/src/crypto.ts packages/processing/src/index.ts packages/processing/src/__tests__/secure-files-crypto.test.ts
git commit -m "feat: add secure files ark domain and root fek crypto"
```

### Task 2.2: Add manifest encryption helpers

**Objective:** Ensure manifests and metadata are encrypted using derived subkeys, not plaintext DB rows.

**Files:**
- Modify: `packages/processing/src/crypto.ts`
- Test: `packages/processing/src/__tests__/secure-files-crypto.test.ts`

**Step 1: Write failing tests**

Add tests for:
- encrypt/decrypt metadata payload with metadata subkey
- encrypt/decrypt manifest payload with content subkey (or manifest-specific derived subkey if you choose that refinement)
- serialized blob contains expected bytes and round-trips

**Step 2: Run test to verify failure**

Run the same targeted test command.
Expected: FAIL.

**Step 3: Implement**

Add helpers like:
- `encryptFileMetadataPlaintext`
- `decryptFileMetadataPlaintext`
- `encryptFileManifestPlaintext`
- `decryptFileManifestPlaintext`

**Step 4: Run targeted and full tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/processing/src/crypto.ts packages/processing/src/__tests__/secure-files-crypto.test.ts
git commit -m "feat: add secure files metadata and manifest encryption helpers"
```

---

## Phase 3 — Replace shared types and API contracts

### Task 3.1: Replace legacy API/domain types

**Objective:** Remove old plaintext file/share types and introduce secure-files request/response shapes.

**Files:**
- Modify: `packages/types/src/index.ts`
- Modify: `packages/types/src/api.ts`
- Test: `packages/types/src/__tests__/api-types.test.ts`

**Step 1: Write failing tests**

Test for presence of new shapes via compile-time smoke fixtures or runtime structural fixtures:
- registration/login response includes wrapped ARK/bootstrap info, not encryptedMasterKey legacy fields alone
- init upload request accepts encrypted metadata blob refs / wrappedFEK / sizes, not plaintext `name`, `mimeType`
- share create request uses capability-oriented fields

**Step 2: Run test/typecheck to verify failure**

Run:
```bash
npm run typecheck
```
Expected: FAIL — old types referenced across app.

**Step 3: Rewrite types**

Remove/replace legacy fields like:
- `InitUploadRequest.name`
- `InitUploadRequest.mimeType`
- `CreateShareRequest.wrappedFEK` (legacy semantics)

Introduce new types such as:
- `CreateAccountCryptoRequest`
- `InitSecureUploadRequest`
- `CommitManifestRequest`
- `CreateFileShareRequest`
- `BlobFetchAuthorizationResponse`

**Step 4: Run typecheck**

Expected: still FAIL in consuming code, but type package itself should be coherent. This is acceptable only if immediately followed by the consuming tasks in the same implementation session. Do not stop here in actual execution.

**Step 5: Commit after consumer stabilization (not yet)**

No standalone commit at this step if repo is broken; commit after Phase 5 consumer fixes.

---

## Phase 4 — Rebuild backend auth/bootstrap around ARK model

### Task 4.1: Replace auth resolver contract

**Objective:** Change register/login/change-password flows to persist/retrieve `UserCryptoRecord` shape instead of legacy KEK+wrapped-master-key fields directly on `User`.

**Files:**
- Modify: `apps/api/src/resolvers/auth.ts`
- Modify: `apps/api/src/schema.ts`
- Modify: `apps/api/src/middleware/auth.ts` if payload shape changes
- Test: `apps/api/src/__tests__/unit/auth-secure-files.test.ts`

**Step 1: Write failing tests**

Cover:
- register stores wrappedARKByPassword and argon2 params
- login returns crypto bootstrap record without exposing plaintext metadata fields unrelated to auth
- change password rewraps ARK, not every file FEK individually

**Step 2: Run test to verify failure**

Run:
```bash
npm run test --workspace=@ddv4/api -- auth-secure-files
```
Expected: FAIL.

**Step 3: Implement minimal resolver changes**

Rewrite register/login/change password to use new tables/fields.
Because data can be deleted, remove FEK rewrap batching from password change.

**Step 4: Run targeted tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/resolvers/auth.ts apps/api/src/schema.ts apps/api/src/__tests__/unit/auth-secure-files.test.ts
git commit -m "feat: switch auth bootstrap to ark model"
```

---

## Phase 5 — Rebuild upload pipeline around encrypted metadata + manifest

### Task 5.1: Replace init-upload API with secure upload session

**Objective:** Init upload should create a `File` in `UPLOADING` state without plaintext filename/mimeType and without manifest blob yet.

**Files:**
- Modify: `apps/api/src/resolvers/files.ts`
- Modify: `apps/api/src/schema.ts`
- Test: `apps/api/src/__tests__/unit/files-init-upload.test.ts`

**Step 1: Write failing tests**

Cover:
- init upload stores `status='UPLOADING'`
- `primaryManifestBlobId=null`
- `wrappedFEK` persisted
- plaintext filename/mimeType are not accepted by API

**Step 2: Run test to verify failure**

Run targeted Vitest command.
Expected: FAIL.

**Step 3: Implement minimal resolver**

Input should contain:
- wrappedFEK
- totalCiphertextBytes
- chunkCount
- optional dedupe token
- parentFolderId

Do not accept plaintext file metadata fields.

**Step 4: Run targeted tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/resolvers/files.ts apps/api/src/schema.ts apps/api/src/__tests__/unit/files-init-upload.test.ts
git commit -m "feat: add secure init upload lifecycle"
```

### Task 5.2: Add manifest commit step

**Objective:** Make upload completion depend on encrypted manifest blob creation and transition file to READY.

**Files:**
- Modify: `apps/api/src/resolvers/files.ts`
- Modify: `apps/api/src/schema.ts`
- Test: `apps/api/src/__tests__/unit/files-commit-manifest.test.ts`

**Step 1: Write failing tests**

Cover:
- commit manifest sets `primaryManifestBlobId`
- transitions file `UPLOADING -> READY`
- rejects commit if manifest blob mapping missing
- rejects commit for already-ready file

**Step 2: Run test to verify failure**

Expected: FAIL.

**Step 3: Implement minimal resolver**

Add a mutation like:
- `commitFileManifest(fileId, manifestBlobId, totalCiphertextBytes, chunkCount)`

This mutation is the readiness gate.

**Step 4: Run targeted tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/resolvers/files.ts apps/api/src/schema.ts apps/api/src/__tests__/unit/files-commit-manifest.test.ts
git commit -m "feat: finalize secure upload via manifest commit"
```

### Task 5.3: Rebuild blob transport persistence

**Objective:** Store Discord blob mappings as `BlobTransportRecord` rows only.

**Files:**
- Modify: `apps/api/src/resolvers/files.ts`
- Modify: `packages/discord-client` as needed
- Test: `apps/api/src/__tests__/unit/blob-transport.test.ts`

**Step 1: Write failing tests**

Cover:
- uploaded blob row stores `blobId`, Discord message ID, webhook ID, hash, size
- no per-file chunk list endpoint is exposed here

**Step 2: Run test to verify failure**

Expected: FAIL.

**Step 3: Implement**

Move chunk persistence semantics from `Chunk`-style file-indexed rows to blob transport rows keyed by `blobId`.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/resolvers/files.ts apps/api/src/__tests__/unit/blob-transport.test.ts packages/discord-client
 git commit -m "feat: persist discord blobs as transport records"
```

---

## Phase 6 — Enforce manifest-driven blob fetch boundary

### Task 6.1: Add blob fetch endpoint contract test

**Objective:** Ensure backend accepts client-presented `blobId` and does not enumerate chunks by file.

**Files:**
- Create/modify: `apps/api/src/routes/blob.ts` or equivalent handler location
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/__tests__/integration/blob-fetch.test.ts`

**Step 1: Write failing integration test**

Cover:
- authenticated owner can fetch authorization/download path by `blobId`
- unauthorized user cannot fetch another user's `blobId`
- no `GET /file/:fileId/chunks` route exists

**Step 2: Run test to verify failure**

Run:
```bash
npm run test:integration --workspace=@ddv4/api
```
Expected: FAIL.

**Step 3: Implement minimal route**

Implement route shape such as:
- `GET /api/blob/:blobId`

Behavior:
- authorize requester by ownership or active share access
- load `BlobTransportRecord`
- proxy/fetch ciphertext from Discord

**Step 4: Run targeted integration tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/index.ts apps/api/src/routes/blob.ts apps/api/src/__tests__/integration/blob-fetch.test.ts
git commit -m "feat: add manifest-driven blob fetch endpoint"
```

---

## Phase 7 — Rebuild shares around capability token model

### Task 7.1: Replace legacy share schema/API with file-only capability shares

**Objective:** Remove legacy `ShareLink` semantics and implement `ShareRecord + GrantedAccess + ShareWrappedObjectKey` for file-only shares.

**Files:**
- Modify: `apps/api/src/resolvers/sharing.ts`
- Modify: `apps/api/src/schema.ts`
- Test: `apps/api/src/__tests__/unit/sharing-secure-files.test.ts`

**Step 1: Write failing tests**

Cover:
- create share stores `shareType='file'`
- stores `capabilityToken`
- stores `wrappedAKShare`
- stores file-only wrapped object keys
- no folder-share path exists

**Step 2: Run test to verify failure**

Expected: FAIL.

**Step 3: Implement minimal resolver/API**

Input should include:
- fileId
- capabilityToken
- wrappedAKShare
- wrappedFEK / wrappedFEKPreview for share scope
- policy flags

Do not implement folder sharing.

**Step 4: Run targeted tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/resolvers/sharing.ts apps/api/src/schema.ts apps/api/src/__tests__/unit/sharing-secure-files.test.ts
git commit -m "feat: replace legacy shares with capability file shares"
```

### Task 7.2: Add share access verification endpoint

**Objective:** Enforce capabilityToken-based release of wrapped share material.

**Files:**
- Modify: `apps/api/src/resolvers/sharing.ts`
- Test: `apps/api/src/__tests__/integration/share-access.test.ts`

**Step 1: Write failing tests**

Cover:
- correct capability token returns wrapped share material
- wrong capability token returns forbidden
- expired/revoked share denied
- `maxViews` increments and blocks future fetches after threshold

**Step 2: Run integration tests to verify failure**

Expected: FAIL.

**Step 3: Implement minimal endpoint/resolver**

Server must compare presented token with stored capabilityToken using constant-time compare.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/resolvers/sharing.ts apps/api/src/__tests__/integration/share-access.test.ts
git commit -m "feat: enforce capability token share access"
```

---

## Phase 8 — Rebuild frontend crypto and upload flow

### Task 8.1: Replace legacy frontend account crypto

**Objective:** Frontend should generate/unwrap ARK, derive files domain key, and stop using legacy master-key-only helpers.

**Files:**
- Modify: `apps/frontend/src/lib/crypto.ts`
- Modify related auth/upload call sites in `apps/frontend/src/**`
- Test: `apps/frontend/src/lib/__tests__/crypto.test.ts`

**Step 1: Write failing tests**

Cover:
- create account crypto bootstrap returns wrappedARKByPassword + params
- login bootstrap unwraps ARK and files domain key
- root FEK subkeys derive correctly

**Step 2: Run frontend/unit tests or typecheck to verify failure**

Use available frontend test command if present; otherwise add Vitest frontend tests or use workspace typecheck after introducing tests.

**Step 3: Implement minimal code**

Replace legacy functions:
- `registerCrypto`
- `loginCrypto`
- `prepareFileUpload`
- `prepareShareLink`

with secure-files equivalents.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/frontend/src/lib/crypto.ts apps/frontend/src/lib/__tests__/crypto.test.ts
git commit -m "feat: switch frontend crypto to ark domain and root fek model"
```

### Task 8.2: Rebuild upload UI flow around encrypted metadata + manifest

**Objective:** Upload should encrypt metadata locally, upload ciphertext blobs, then commit manifest.

**Files:**
- Modify relevant upload hooks/components in `apps/frontend/src/**`
- Test: frontend upload flow test or API smoke if no frontend harness exists

**Step 1: Write failing test or smoke scenario**

Cover:
- plaintext filename never sent in init upload request
- metadata blob encrypted locally
- manifest built locally and committed at end

**Step 2: Run to verify failure**

Expected: FAIL.

**Step 3: Implement minimal flow**

Sequence:
1. derive FEK_root
2. derive content/metadata subkeys
3. encrypt metadata payload
4. upload encrypted metadata/blob transport entries
5. upload encrypted chunks
6. upload encrypted manifest
7. commit manifest blob ID

**Step 4: Run tests/smoke**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/frontend/src
 git commit -m "feat: rebuild upload flow around encrypted metadata and manifest"
```

### Task 8.3: Rebuild share creation + download UI flow

**Objective:** Frontend should produce linkSecret-derived capability token flow and consume manifest-driven blob fetches.

**Files:**
- Modify share-related frontend modules in `apps/frontend/src/**`
- Test: share smoke/API integration scenario

**Step 1: Write failing test/scenario**

Cover:
- create share derives `K_wrap`, `K_auth`, capability token, wrappedAKShare
- recipient parses link fragment and fetches wrapped material
- recipient downloads by manifest blobIds, not file chunk enumeration

**Step 2: Run to verify failure**

Expected: FAIL.

**Step 3: Implement minimal flow**

**Step 4: Run tests/smoke**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/frontend/src
 git commit -m "feat: rebuild share flow around capability tokens and manifest blob fetch"
```

---

## Phase 9 — Remove legacy codepaths and stabilize

### Task 9.1: Delete obsolete legacy share/file schema code

**Objective:** Remove code paths that preserve the old plaintext-heavy model so the repo has one architecture, not two.

**Files:**
- Modify/delete legacy code in:
  - `apps/api/src/resolvers/files.ts`
  - `apps/api/src/resolvers/sharing.ts`
  - `packages/types/src/api.ts`
  - `packages/types/src/index.ts`
  - frontend upload/share helpers
- Test: full workspace typecheck + tests

**Step 1: Remove dead code**

Delete references to:
- plaintext `name` / `mimeType` upload path
- legacy `ShareLink`
- legacy `encryptedMasterKey`-only assumptions
- old chunk-index enumeration download path

**Step 2: Run full verification**

Run:
```bash
npm run typecheck
npm test
npm run test:integration
```
Expected: all PASS.

**Step 3: Commit**

```bash
git add apps packages
 git commit -m "refactor: remove legacy plaintext-heavy file storage paths"
```

---

## Final verification checklist

Before declaring done, run in order:

```bash
npm run db:push:force --workspace=@ddv4/database
npm run db:generate
npm run typecheck
npm test
npm run test:integration
```

Expected:
- DB reset succeeds
- Prisma client generates
- Typecheck passes
- API unit/smoke tests pass
- processing tests pass
- integration tests pass

Manual smoke checks:
- register new user
- login
- upload file with encrypted metadata
- verify DB has no plaintext filename/mimeType
- download file through manifest + blobId path
- create share link
- open share link in fresh client/session
- confirm file-only share works
- revoke share and verify new access is denied

---

## Definition of done

The task is complete only when all of the following are true:

1. Legacy plaintext-heavy file/share schema is gone.
2. Database can be reset destructively without migration logic.
3. ARK + domain keys + wrapped root FEK model is implemented.
4. Metadata and chunk manifest are encrypted blobs, not plaintext DB fields.
5. Backend fetches ciphertext by client-presented `blobId`, not file chunk enumeration.
6. Share flow is capability-token-based and file-only.
7. Frontend upload/download/share flows use the new architecture end-to-end.
8. `npm run typecheck`, `npm test`, and `npm run test:integration` all pass.
9. Docs remain aligned with the implemented behavior.

---

## Notes for execution

- Because migration is explicitly unnecessary, prefer deletion over compatibility layers.
- If a task temporarily breaks downstream consumers (especially type package rewrites), continue immediately until the repo is stabilized before stopping.
- If a decision must be made during implementation, prefer the simpler v1-safe choice already encoded in the spec: file-only shares, one wrapped root FEK, manifest-driven blob fetch.
