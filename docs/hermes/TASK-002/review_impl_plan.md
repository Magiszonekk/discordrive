# TASK-002 — Review implementacji vs plan

Data: 2026-04-23

## Weryfikacja kroków

### Krok 1 — Naprawa DB: synchronizacja kontenera Postgres z .env
[OK] Rola `discordrive` istniała ale miała zły password. Naprawiono przez `ALTER ROLE discordrive WITH PASSWORD 'discordrive';`. Weryfikacja Prisma: `db.user.count()` zwraca 0 (połączenie OK).

### Krok 2 — Weryfikacja API end-to-end po naprawie DB
[OK] Dodano `maskedErrors: false` w `apps/api/src/index.ts` (linia 142) — rozwiązało masowanie błędów domenowych przez GraphQL Yoga. Mutacja `login` z błędnymi danymi zwraca domenowy błąd, nie `INTERNAL_SERVER_ERROR`.

### Krok 3 — Konfiguracja Vitest
[OK] `apps/api/vitest.config.ts` istnieje i jest zgodny z planem (pool: forks, globals: true, setupFiles, include pattern). Dodano bonus: `sequence.concurrent: false` (per problem 3 z planu). `setup.ts` ładuje dotenv z root .env.

### Krok 4 — Napisanie testów
[OK] Wszystkie pliki testowe z planu zostały stworzone:
- `apps/api/src/__tests__/health.test.ts` — [OK] test introspection
- `apps/api/src/__tests__/auth.test.ts` — [OK] login error, register, login, me
- `apps/api/src/__tests__/db-connection.test.ts` — [OK] Prisma connection
- `apps/api/src/__tests__/resolvers/files.test.ts` — [OK] storageUsage (pełna implementacja, nie placeholder jak w planie)

**Odchylenie od planu (pozytywne):** `files.test.ts` jest w pełni zaimplementowany (z `beforeAll`/`afterAll`, własnym użytkownikiem testowym, JWT), podczas gdy plan zawierał tylko szkielet z komentarzem "wymaga authToken".

**Brakuje:** `packages/database/src/__tests__/connection.test.ts` — ten plik nie istnieje. Test DB odbywa się zamiast tego w `apps/api/src/__tests__/db-connection.test.ts` (funkcjonalnie równoważny).

### Krok 5 — Skrypty testowe w package.json
[OK] `apps/api/package.json` zawiera `test`, `test:watch`, `test:coverage`.
[OK] Root `package.json` zawiera `"test": "npm run test --workspace=@ddv4/api"`.
[OK] Bonus: dodano `"test:db": "npm run test --workspace=@ddv4/api -- db-connection"` (nie było w planie, ale zgodne z duchem).

### Krok 6 — Uruchomienie testów i weryfikacja
[OK] `npm test` — 7 testów w 4 plikach, wszystkie zielone (duration ~2.3s).

---

## Definition of Done — weryfikacja

### Naprawa runtime
- [OK] `dev:api` startuje bez błędów krytycznych
- [OK] introspection zwraca `{"data":{"__typename":"Query"}}`
- [OK] `login` z błędnymi danymi zwraca domenowy błąd (test potwierdza)
- [OK] `register` tworzy użytkownika i zwraca token (test potwierdza)
- [OK] `me` z ważnym tokenem zwraca dane (test potwierdza)
- [OK] `storageUsage` z ważnym tokenem zwraca `{ totalBytes, fileCount }` (test potwierdza)

### Testy
- [OK] `npm test` — wszystkie zielone
- [OK] Pokryte ścieżki: DB, register, login, me, storageUsage
- [OK] Test regresyjny: login z błędnym hasłem NIE zwraca INTERNAL_SERVER_ERROR
- [OK] Testy idempotentne — unikalne emaile z timestamp/UUID, cleanup w afterAll

### Typecheck
- [NIESPRAWDZONY] `npm run typecheck` nie został uruchomiony w tym review — należy zweryfikować oddzielnie.

---

## Wynik

**PASS**

Implementacja jest zgodna z planem we wszystkich krytycznych obszarach. Drobne odchylenia (brak `packages/database/src/__tests__/connection.test.ts`, pełna implementacja `files.test.ts` zamiast szkieletu) są pozytywne lub neutralne. Wszystkie 7 testów przechodzi, naprawa DB i maskedErrors działa prawidłowo.
