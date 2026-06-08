# DiscordDrive Core v1 Closure Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Domknąć DiscordDrive jako stabilny secure-files/storage core dependency bez rozpoczynania prac nad osobnym produktem galerii.

**Architecture:** DiscordDrive Core v1 ma zostać ograniczony do warstwy auth + crypto bootstrap + secure file lifecycle + Discord-backed blob transport + file-only sharing. Gallery-compatible threat model pozostaje source of truth dla architektury bezpieczeństwa, ale bieżący scope wycina product UX galerii, AI tagging i experience layer. Repo po zakończeniu ma oferować spójny i przetestowany core, na którym inne projekty mogą bezpiecznie polegać.

**Tech Stack:** TypeScript monorepo, Prisma/PostgreSQL, GraphQL Yoga, Web Crypto API, Argon2id, Vitest, Discord blob transport.

---

## Scope definition

### In scope
- secure-files v2 crypto envelope
- auth bootstrap z ARK + domain keys
- secure file upload lifecycle (`UPLOADING -> READY/FAILED`)
- encrypted metadata + encrypted manifest flow
- manifest-driven blob fetch contract
- Discord-backed blob substrate
- file-only shares
- integration/smoke tests dla core flows
- dokumentacja kontraktu użycia jako core/dependency

### Out of scope
- gallery product UX
- albumy / smart albumy / gallery UI layer
- AI tagging/search UX
- osobne backup flows telefonu jako produkt
- folder shares

---

## Definition of done

DiscordDrive Core v1 uznajemy za domknięty, gdy wszystkie warunki są spełnione:
- konto można zarejestrować i zalogować z nowym bootstrapem crypto
- można zainicjalizować upload bez plaintext filename/mimeType w API
- można zapisać manifest i przejść do `READY`
- blob upload/fetch działają przez Discord substrate, nie tylko `LOCAL`
- owner download działa przez manifest-driven blob fetch
- file-only share działa bez serwerowych heurystyk typu `displayName=file.id` / inferowany MIME jako kontrakt publiczny
- backend nie staje się chunk-order oracle
- `npm run typecheck` przechodzi
- `npm test` przechodzi
- `npm run test:integration` przechodzi
- istnieje krótki dokument opisujący, jak inne projekty mają konsumować DiscordDrive Core v1

---

## Phase 0 — Zamrożenie scope Core v1

### Task 0.1: Spisać checklistę zgodności Core v1

**Objective:** Stworzyć jeden krótki dokument odróżniający "core gotowy jako dependency" od przyszłego scope galerii.

**Files:**
- Create: `docs/hermes/discordrive-core-v1-checklist.md`
- Source: `docs/hermes/discordrive-gallery-compatible-threat-model.ts`
- Source: `docs/hermes/phase-b-plan.md`

**Step 1: Write the checklist**

Dodaj sekcje:
- Scope in / out
- Security invariants
- Core flows
- Transport invariants
- Share invariants
- Verification commands

Checklista ma zawierać checkboxy dla:
- `BlobStorageKind` wspiera `DISCORD`
- `GET /blob/:blobId` przyjmuje blobId pochodzące z odszyfrowanego manifestu
- brak plaintext filename/mimeType w serwerowym modelu `File`
- file-only share contract nie polega na `displayName=file.id`
- gallery UX jest poza bieżącym zakresem

**Step 2: Save file**

Brak testu — artefakt dokumentacyjny.

**Step 3: Verify content manually**

Upewnij się, że dokument jest krótki, jednoznaczny i nadaje się jako referencja do dalszych tasków.

---

## Phase 1 — Dokończenie Discord blob substrate

### Task 1.1: Rozszerzyć schema/testy BlobTransport o Discord transport

**Objective:** Przestawić model danych z local-only blob substrate na substrate wspierający Discord jako docelowy transport.

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Modify: `packages/database/src/__tests__/schema-shape.test.ts`

**Step 1: Write failing schema test**

Dodaj oczekiwania, że schema zawiera:
- `BlobStorageKind.DISCORD`
- `discordMessageId`
- `discordChannelId`
- `webhookId` lub równoważne pole transportowe

Oraz że test nie zakłada już local-only shape jako finalnego celu.

**Step 2: Run targeted test to verify failure**

Run:
```bash
npm run test --workspace=@ddv4/database -- schema-shape
```
Expected: FAIL.

**Step 3: Update schema**

Rozszerz `BlobTransport` tak, aby wspierał oba tryby:
- `LOCAL` dla dev/test
- `DISCORD` jako docelowy substrate

**Step 4: Regenerate Prisma client**

Run:
```bash
npm run db:generate
```
Expected: PASS.

**Step 5: Re-run targeted test**

Run:
```bash
npm run test --workspace=@ddv4/database -- schema-shape
```
Expected: PASS.

---

### Task 1.2: Dodać adapter Discord blob transport

**Objective:** Ukryć Discord-specific upload/fetch/stat logic za jednym adapterem.

**Files:**
- Create: `apps/api/src/storage/discord-blobs.ts`
- Modify: `apps/api/src/handlers/blob.ts`
- Modify: `apps/api/src/__tests__/integration/blob-upload.integration.test.ts`
- Modify or create: testy adaptera w `apps/api/src/__tests__/unit/`

**Step 1: Write failing tests**

Pokryj:
- upload ciphertext blob w trybie `DISCORD`
- odczyt/fetch ciphertext blob w trybie `DISCORD`
- metadata route zwraca Discord transport fields
- brak direct Discord calls poza adapterem

**Step 2: Run targeted tests to verify failure**

Run:
```bash
npm run test --workspace=@ddv4/api -- blob-upload
```
Expected: FAIL.

**Step 3: Implement minimal adapter**

Dodaj funkcje typu:
- `uploadCiphertextBlobToDiscord`
- `fetchCiphertextBlobFromDiscord`
- `statDiscordBlob`

Na początek mogą być oparte o mockowalną warstwę transportową, ale kontrakt modułu ma być finalny.

**Step 4: Route blob handler through adapter selection**

`handleBlobUpload`, `handleBlobContent`, `handleBlobMetadata` mają przechodzić przez wspólną warstwę wyboru substrate.

**Step 5: Re-run targeted tests**

Expected: PASS.

---

### Task 1.3: Dodać runtime config wyboru substrate

**Objective:** Jawnie sterować trybem `LOCAL|DISCORD` przez config zamiast przez zakodowane założenia.

**Files:**
- Modify: `packages/config/...`
- Modify: `apps/api/src/handlers/blob.ts`
- Modify: `.env.example` lub docs jeśli istnieją
- Test: odpowiednie testy jednostkowe/integracyjne

**Step 1: Write failing test**

Przetestuj, że runtime potrafi:
- wybrać `LOCAL`
- wybrać `DISCORD`
- sensownie failować przy niepoprawnej wartości

**Step 2: Run targeted test to verify failure**

Run odpowiedni zestaw testów API/config.
Expected: FAIL.

**Step 3: Implement minimal config switch**

Dodaj np. `BLOB_STORAGE_KIND=LOCAL|DISCORD`.

**Step 4: Re-run tests**

Expected: PASS.

---

## Phase 2 — Domknięcie secure file lifecycle

### Task 2.1: Zweryfikować i domknąć init-upload contract

**Objective:** Upewnić się, że init-upload w Core v1 przyjmuje tylko dane zgodne z secure-files v2 i nie wpuszcza plaintext metadata.

**Files:**
- Modify: `apps/api/src/resolvers/files.ts`
- Modify: `apps/api/src/schema.ts`
- Create or modify: `apps/api/src/__tests__/unit/files-init-upload.test.ts`

**Step 1: Write failing tests**

Pokryj:
- przyjmowany jest `wrappedFEK`, `chunkCount`, `totalCiphertextBytes`
- `primaryManifestBlobId` startuje jako `null`
- plaintext `name`/`mimeType` są odrzucane lub nie istnieją w API

**Step 2: Run targeted tests to verify failure**

Expected: FAIL.

**Step 3: Implement minimal resolver/schema alignment**

**Step 4: Re-run tests**

Expected: PASS.

---

### Task 2.2: Domknąć manifest commit jako readiness gate

**Objective:** Przejście pliku do `READY` ma zależeć od poprawnego manifest commit, zgodnie z threat model.

**Files:**
- Modify: `apps/api/src/resolvers/files.ts`
- Modify: `apps/api/src/schema.ts`
- Create or modify: `apps/api/src/__tests__/unit/files-commit-manifest.test.ts`

**Step 1: Write failing tests**

Pokryj:
- commit ustawia `primaryManifestBlobId`
- `UPLOADING -> READY`
- brak możliwości commit dla już `READY`
- brak możliwości udawania gotowości bez manifest blob mapping

**Step 2: Run targeted tests to verify failure**

Expected: FAIL.

**Step 3: Implement minimal commit flow**

**Step 4: Re-run tests**

Expected: PASS.

---

## Phase 3 — Oczyszczenie share contract pod dependency/core

### Task 3.1: Usunąć tymczasowe share heurystyki z publicznego kontraktu

**Objective:** Publiczny contract share access ma opierać się na capability + wrapped object keys + blob references, a nie na serwerowych heurystykach display/mime.

**Files:**
- Modify: `apps/api/src/resolvers/sharing.ts` lub aktualny odpowiednik
- Modify: `apps/api/src/schema.ts`
- Modify: `apps/api/src/__tests__/integration/share-access.integration.test.ts`

**Step 1: Write failing tests**

Zmień oczekiwania tak, aby publiczny contract:
- nie wymagał `displayName` wyprowadzanego z `file.id`
- nie wymagał inferowanego `mimeType` jako części core contract
- zwracał tylko pola potrzebne do odszyfrowania i pobrania obiektu przez klienta

**Step 2: Run targeted test to verify failure**

Expected: FAIL.

**Step 3: Implement minimal contract cleanup**

**Step 4: Re-run tests**

Expected: PASS.

---

### Task 3.2: Dodać test integralności file-only share invariants

**Objective:** Share flow ma być jednoznacznie file-only i nie może odrosnąć w stronę starego modelu.

**Files:**
- Modify: `apps/api/src/__tests__/integration/share-access.integration.test.ts`
- Optional modify: `apps/api/src/resolvers/sharing.ts`

**Step 1: Write failing tests**

Pokryj:
- `shareType === file`
- brak folder-share semantics
- revoked/expired share zwraca brak dostępu
- capability mismatch zwraca brak dostępu

**Step 2: Run targeted tests**

Expected: FAIL lub częściowy FAIL.

**Step 3: Implement minimal fixes**

**Step 4: Re-run tests**

Expected: PASS.

---

## Phase 4 — Integracja i kontrakt dependency

### Task 4.1: Dodać smoke/integration flow Core v1

**Objective:** Udowodnić end-to-end, że core jest gotowy jako dependency.

**Files:**
- Modify/create: `apps/api/src/__tests__/integration/...`
- Modify/create: `scripts/...` jeśli repo ma smoke scripts
- Update: `docs/hermes/attempt_log.md` lub task artifact

**Step 1: Write failing integration scenario**

Scenariusz:
1. register
2. login
3. init upload
4. upload blob
5. commit manifest
6. owner fetch blob by manifest-provided blobId
7. create share
8. access share with capability token

**Step 2: Run integration tests to verify failure**

Run:
```bash
npm run test:integration
```
Expected: FAIL.

**Step 3: Implement minimal missing glue**

**Step 4: Re-run integration tests**

Expected: PASS.

---

### Task 4.2: Spisać dokument użycia DiscordDrive jako dependency/core

**Objective:** Dać innym projektom prosty kontrakt użycia.

**Files:**
- Create: `docs/hermes/discordrive-core-v1-consumption.md`

**Step 1: Write document**

Dokument ma zawierać:
- czym jest DiscordDrive Core v1
- co gwarantuje
- czego nie gwarantuje
- jak inne projekty mają go konsumować (API-first / service-first)
- które elementy są poza zakresem (gallery UX)

**Step 2: Save file**

No test needed.

---

## Final verification

Po wykonaniu planu uruchom obowiązkowo:

```bash
npm run typecheck
npm test
npm run test:integration
```

Jeżeli w repo istnieje osobny smoke command dla download/share, uruchom również jego.

Ostatecznie wynik musi potwierdzić, że DiscordDrive jest domknięty jako Core v1, a nie jako produkt galerii.
