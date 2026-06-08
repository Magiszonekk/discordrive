# Attempt Log — Secure Files v2 rewrite

## 2026-04-28 07:53
- Started implementation from `docs/hermes/plan.md`.
- Scope confirmed: destructive rewrite, no migration, existing data may be deleted.
- Initial focus: Phase 0 + Phase 1 (implementation checklist + Prisma schema replacement).

## 2026-04-28 08:23
- Completed Phase 0.1: added `docs/hermes/implementation-checklist.md`.
- Completed Phase 1.1 initial pass:
  - rewrote `packages/database/prisma/schema.prisma` to secure-files v2 models
  - added `packages/database/src/__tests__/schema-shape.test.ts`
  - updated `packages/database/package.json` with local test + `db:push:force`
- Verification:
  - `npm run test --workspace=@ddv4/database -- schema-shape` ✅
  - `npm run db:generate` ✅
  - `npm run db:push:force --workspace=@ddv4/database` ❌ failed with Prisma P1001 (`localhost:5432` unreachable)
- Current blocker: local Postgres is not running/reachable, so destructive schema apply cannot yet be verified.

## 2026-04-28 08:30
- Brought infra up with `docker compose -f infra/docker-compose.yml --env-file .env up -d`.
- Verified Postgres is healthy and listening on `0.0.0.0:5432`.
- Verified destructive schema apply now works:
  - `npm run db:push:force --workspace=@ddv4/database` ✅
- Ran workspace typecheck after schema replacement:
  - `npm run typecheck` ❌
- Current failure mode is expected downstream breakage from the destructive schema rewrite:
  - API resolvers, handlers, tests, and GraphQL schema still reference legacy fields/models (`passwordHash`, `kekSalt`, `wrapIv`, `encryptedMasterKey`, `shareLink`, `chunk`, `File.name`, `File.mimeType`, etc.).
- Next implementation step: rewrite consumers in API/types/frontend to the new secure-files contract instead of patching schema backward.

## 2026-04-28 08:39
- Completed Phase 2 core crypto pass in `packages/processing`:
  - added ARK/domain/root-FEK functions
  - added HKDF-derived content/metadata share helpers
  - added file metadata + manifest encryption helpers
  - exported new secure-files crypto API
- Added secure-files crypto tests in `packages/processing/src/__tests__/secure-files-crypto.test.ts`.
- Updated `packages/processing/package.json` exports for direct crypto import.
- Rewrote `packages/types/src/api.ts` and `packages/types/src/index.ts` to the new secure-files contract.
- Verification:
  - `npm run test --workspace=@ddv4/processing -- secure-files-crypto` ✅
  - `npm run test --workspace=@ddv4/processing` ✅
  - `npm run typecheck` ❌ (expected consumer breakage remains in API/frontend, now plus legacy auth/upload/share flows using removed type fields)
- Current state is stable for processing/types; next step is consumer rewrite in API auth/files/sharing/schema and frontend login/register/upload/share paths.

## 2026-04-28 08:50
- Began backend consumer rewrite:
  - rewrote `apps/api/src/middleware/auth.ts` for crypto-less system user bootstrap
  - rewrote `apps/api/src/resolvers/auth.ts` to store/read `UserCrypto`
  - rewrote `apps/api/src/resolvers/files.ts` around `wrappedFEK`, upload status, and manifest commit
  - rewrote `apps/api/src/resolvers/sharing.ts` to file-only capability shares
  - rewrote `apps/api/src/resolvers/folders.ts` to encrypted folder bodies
  - replaced GraphQL schema in `apps/api/src/schema.ts` with secure-files-oriented types/mutations/queries
  - added `apps/api/src/handlers/blob.ts`
  - rewired `apps/api/src/index.ts` to use `/api/blob/:blobId` and removed legacy route registrations from the live routing table
- Verification:
  - `npm run typecheck` still ❌
- Remaining breakage is now more concentrated:
  - dead legacy handlers/tests still compile (`handlers/download.ts`, `handlers/share.ts`, `handlers/upload.ts`, `handlers/thumbnail.ts`, `handlers/stats.ts`, health resolver/tests)
  - frontend still depends on legacy login/upload/share contracts
  - some plugin/event payload typings need follow-up
- Next step: remove or rewrite remaining legacy API handlers/tests, then switch frontend consumers.

## 2026-04-28 08:58
- Performed backend cleanup pass:
  - removed generated `.js/.d.ts` artifacts under `apps/api/src` that were polluting live TypeScript compilation
  - deleted obsolete legacy handler/test sources: old download/share/upload/stats/thumbnail handlers, health handler, and several stale API tests
  - normalized plugin event payloads in `apps/api/src/resolvers/files.ts` to expected legacy event names (`userId`, placeholder mime/size/sha256 values)
- Verification:
  - `npm run typecheck` still ❌, but backend failure count dropped significantly
- Remaining backend issues are now much smaller:
  - a few leftover API references / module-resolution issues
  - the bulk of remaining errors are frontend consumers still expecting old auth/upload/share contracts
- Next step: finish final backend cleanup, then rewrite frontend login/register/upload/share/store components.

## 2026-04-28 10:35
- Ran Phase A / runtime smoke validation against live local app stack.
- Environment notes:
  - `docker compose -f infra/docker-compose.yml --env-file .env ps` showed Postgres and Redis healthy; pgAdmin was restarting but not needed for smoke.
  - reset DB with `npm run db:push:force --workspace=@ddv4/database` ✅
  - existing API process already occupied port 3000; restarted clean local API server manually and launched frontend dev server.
  - frontend Vite auto-shifted from occupied 3001/3002 to `http://localhost:3003`.
- Browser smoke results:
  - register flow initially failed ❌ because frontend `Register.tsx` still sent legacy GraphQL argument `password` to `Mutation.register`.
  - fixed `apps/frontend/src/pages/Register.tsx` to stop sending unsupported `password` arg.
  - reran `npm run typecheck` ✅ after the fix.
  - reran browser registration on fresh credentials (`qa+smoke2@discordrive.local` / `smoketest2`) ✅
  - dashboard loaded after registration ✅
  - upload smoke via file-input injection of `ddv4-smoke.txt` succeeded ✅
  - uploaded row appeared in dashboard with Download + Share actions ✅
  - create share modal produced a real share URL with `#linkSecret` fragment ✅
  - opening the generated share URL loaded the public shared-file page correctly ✅
  - clicking Download on shared page produced no visible UI error and no console errors; browser tooling did not expose filesystem save confirmation, so final file-save confirmation remains partial/implicit ⚠️
  - owner Download button also produced no visible error, but same browser limitation means save confirmation is not directly observable ⚠️
- Current assessment:
  - register/login/upload/share-page routing are working end-to-end in browser smoke
  - share decrypt/download path is wired and does not throw visible client errors in smoke
  - final download artifact confirmation is still limited by browser-tool observability (no direct download-manager inspection)
- Next sensible follow-up if needed:
  - add explicit frontend toast/status for successful download trigger, or
  - add an automated E2E harness that can assert download file contents on disk.
