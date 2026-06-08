# TASK-003 Attempt Log

## 2026-04-23 — Etap 0-1: Reorganizacja testów API

### Co zrobiono
1. Stworzono katalogi `src/__tests__/smoke/` i `src/__tests__/integration/`
2. Przeniesiono `health.test.ts` → `smoke/graphql-health.test.ts` (bez zmian treści)
3. Przeniesiono `auth.test.ts` → `integration/auth.integration.test.ts` (bez zmian treści)
4. Przeniesiono `resolvers/files.test.ts` → `integration/storage.integration.test.ts` (bez zmian treści)
5. Usunięto `db-connection.test.ts`
6. Zaktualizowano `vitest.config.ts` — domyślny `npm test` uruchamia tylko `smoke/**` i `unit/**`
7. Dodano `vitest.integration.config.ts` — uruchamia tylko `integration/**`
8. Dodano skrypt `test:integration` w `package.json`

### Wyniki weryfikacji
- `npm test` (fast path: smoke+unit): **1 passed** — `graphql-health.test.ts` ✓
- `npm run test:integration`: wymaga działającego serwera API (localhost:3000) i bazy danych; nie uruchamiano w tym cyklu (środowisko integracyjne niedostępne w tej sesji)

### Pliki zmodyfikowane
- `apps/api/vitest.config.ts` — zmieniono `include` na smoke+unit
- `apps/api/vitest.integration.config.ts` — nowy plik dla testów integracyjnych
- `apps/api/package.json` — dodano skrypt `test:integration`
- `apps/api/src/__tests__/smoke/graphql-health.test.ts` — nowy plik (z health.test.ts)
- `apps/api/src/__tests__/integration/auth.integration.test.ts` — nowy plik (z auth.test.ts)
- `apps/api/src/__tests__/integration/storage.integration.test.ts` — nowy plik (z resolvers/files.test.ts)
- Usunięto: `apps/api/src/__tests__/db-connection.test.ts`

### Uwagi
- Stare pliki `health.test.ts`, `auth.test.ts`, `resolvers/files.test.ts` pozostają na miejscu (nie usunięto — można usunąć ręcznie po weryfikacji lub w kolejnym etapie)
- Testy integracyjne wymagają uruchomionego API + DB; odpalaj przez `npm run test:integration` w środowisku z `infra:up`

---

## Attempt: Etap 2-3 — Unit testy packages/processing + API auth middleware
**Data:** 2026-04-23

### Zakres
Etap 2-3 TASK-003: unit testy dla `packages/processing` (chunker/hash/crypto) oraz auth middleware w `apps/api`.

### Co zrobiono
1. **packages/processing** — dodano vitest config (`vitest.config.ts`) + skrypty `test`/`test:watch` + devDependency vitest w `package.json`.
2. Nowe pliki testowe:
   - `packages/processing/src/__tests__/chunker.test.ts` — 8 testów (calculateChunkCount + chunkFileStream)
   - `packages/processing/src/__tests__/hash.test.ts` — 4 testy (hashBuffer + hashStream ze known SHA-256 vectors)
   - `packages/processing/src/__tests__/crypto.test.ts` — 8 testów (toBase64/fromBase64, generateSalt/randomBytes, encrypt/decrypt round-trip)
3. **apps/api** — `src/__tests__/unit/auth-middleware.test.ts` — 5 testów dla `extractToken` (happy path, brak headera, non-Bearer, edge case pusty token, JWT z kropkami).

### Wyniki testów
- `@ddv4/processing`: **20/20 pass** (3 pliki: chunker, hash, crypto)
- `@ddv4/api` unit: **5/5 pass** (auth-middleware)
- Łącznie: **25 testów, 0 failures**

### Uwagi
- Web Crypto API działa natywnie na Node 22 — brak potrzeby polyfilli.
- `crypto.ts` używa global `crypto.subtle` + `btoa`/`atob` — działa w environment: node bez żadnych poprawek.
- `extractToken` ujawnił edge case: `"Bearer "` (sam prefix bez tokenu) zwraca `null` przez warunki runtime (headers.get może zwrócić null lub pusty string w zależności od implementacji Request).

---

## 2026-04-23 — Etap 4-5: Fast/heavy test split + dokumentacja E2E

### Co zrobiono
1. Zaktualizowano root `package.json`:
   - `npm test` uruchamia teraz fast path dla `@ddv4/api` oraz `@ddv4/processing`
   - dodano root `npm run test:integration` delegujący do `@ddv4/api`
   - usunięto stary `test:db`, bo osobny test połączenia DB został wycofany z planu
2. Utworzono `docs/hermes/TASK-003/e2e-plan.md` z propozycją wdrożenia Playwright oraz listą scenariuszy P0/P1.
3. Zweryfikowano fast path lokalnie.

### Wyniki weryfikacji
- `npm test`: **PASS**
  - `@ddv4/api`: **6/6 pass**
  - `@ddv4/processing`: **20/20 pass**
- `npm run test:integration`: nadal wymaga żywego API + DB, nieuruchamiane w tym cyklu

### Pliki zmodyfikowane
- `package.json`
- `docs/hermes/TASK-003/e2e-plan.md`

### Uwagi
- Fast gate jest teraz zgodny z kierunkiem z koncepcji: smoke + unit bez ciężkich integracji.
- `attempt_log.md` z Etapu 0-1 zawiera informację, że stare test files mogły pozostać — obecny stan repo trzeba traktować jako źródło prawdy, bo aktywny zestaw testów jest już zorganizowany w `smoke/`, `unit/`, `integration/`.

---

## 2026-04-23 — Etap 4 domknięty: workflow CI

### Co zrobiono
1. Dodano `.github/workflows/ci.yml`.
2. Zdefiniowano job `fast-gate` uruchamiający `npm ci`, `npm run typecheck`, `npm run build` oraz `npm test`.
3. Zdefiniowano job `integration`, który:
   - przygotowuje lokalne `.env` dla CI,
   - uruchamia `postgres` i `redis` przez `infra/docker-compose.yml`,
   - wykonuje `npm run db:push`,
   - startuje API,
   - czeka na gotowość endpointu GraphQL,
   - uruchamia `npm run test:integration`.
4. Dodano cleanup API i infrastruktury w `always()`.

### Wyniki weryfikacji
- `npm test`: **PASS**
- `npm run typecheck`: **PASS**
- `npm run build`: **PASS**

### Pliki zmodyfikowane
- `.github/workflows/ci.yml`
- `docs/hermes/TASK-003/review_impl_plan.md`
- `docs/hermes/TASK-003/attempt_log.md`
- `docs/hermes/tasks.md`

### Uwagi
- Workflow domyka ostatni brak wskazany wcześniej w `review_impl_plan.md`.
- Runtime integration w samym GitHub Actions nie był tutaj odpalany lokalnie; lokalnie zweryfikowano pełny fast gate oraz spójność definicji workflow.
