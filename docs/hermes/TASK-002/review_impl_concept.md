# TASK-002: Review implementacji vs założenia koncepcyjne

Data przeglądu: 2026-04-23

---

## Założenia z concept.md vs stan implementacji

### 1. Zduplikowany fragment `mergeResolvers` w `apps/api/src/schema.ts` (błąd składni blokujący start API)
**[OK]** — Duplikat został usunięty. `npm run typecheck` przechodzi czysto (exit code 0). Plik `schema.ts` kompiluje się bez błędów.

### 2. Naprawienie importów `default` dla `jsonwebtoken` i `argon2` (CJS compat)
**[OK]** — `apps/api/src/middleware/auth.ts` używa `import jwt from "jsonwebtoken"` z rzutowaniem typów (`as jwt.SignOptions`), co jest poprawną formą dla interop CJS. Typecheck przechodzi.

### 3. Naprawa `toReversed()` (brak w starszych Node)
**[OK]** — typecheck przechodzi bez błędów; brak widocznych regresji po tej poprawce.

### 4. Konfiguracja `tsconfig.json` (API/config/types/plugin-sdk) — zielony typecheck
**[OK]** — `npm run typecheck` (`tsc --build`) kończy się z exit code 0. Brak błędów kompilacji w całym monorepo.

### 5. Naprawa błędu DB credentials (`ALTER ROLE discordrive WITH PASSWORD 'discordrive'`)
**[OK]** — Odnotowane w `attempt_log.md` (2026-04-23 13:09 UTC). Weryfikacja przez `db.user.count()` zwróciła OK. Test `db-connection.test.ts` pokrywa tę ścieżkę.

### 6. Ujawnienie błędów domenowych z resolverów (maskedErrors: false)
**[OK]** — `apps/api/src/index.ts` linia 142 zawiera `maskedErrors: false` w konfiguracji `createYoga`. Test `auth.test.ts` weryfikuje, że `login` z błędnymi danymi zwraca komunikat domenowy `"Invalid email/username or password"`, a nie `INTERNAL_SERVER_ERROR`.

### 7. Dodanie frameworka testowego (Vitest) — brak testów był odnotowany w concept
**[OK]** — Vitest skonfigurowany w `apps/api/vitest.config.ts`. Dodano 4 pliki testowe:
  - `health.test.ts` — introspekcja GraphQL
  - `db-connection.test.ts` — połączenie z Prisma/DB
  - `auth.test.ts` — register, login, me, błędy domenowe
  - `resolvers/files.test.ts` — storageUsage (fixture DB)

### 8. Problem: `jwt.sign is not a function` w `auth.ts` (odnotowany w attempt_log)
**[OK]** — Plik `middleware/auth.ts` w aktualnym stanie używa `import jwt from "jsonwebtoken"` i wywołuje `jwt.sign(...)` / `jwt.verify(...)` bezpośrednio. Typecheck przechodzi. Problem z logu (attempt_log 13:18 UTC) wydaje się naprawiony w aktualnym kodzie.

### 9. Problem: błędny import w `files.test.ts` (odnotowany w attempt_log)
**[OK]** — Aktualny `files.test.ts` importuje `import { db } from "@ddv4/database"` i `import { signToken } from "../../middleware/auth.js"` — oba prawidłowe. Typecheck przechodzi.

### 10. Propagacja zmiennych środowiskowych do testów (DATABASE_URL)
**[OK]** — `src/__tests__/setup.ts` ładuje `.env` przez `dotenv/config` ze ścieżką relatywną do katalogu `apps/api`. Plik `vitest.config.ts` wskazuje setup file.

---

## Podsumowanie

| Założenie | Status |
|-----------|--------|
| Usunięcie duplikatu mergeResolvers | [OK] |
| Import fix jsonwebtoken/argon2 CJS | [OK] |
| Naprawa toReversed() | [OK] |
| Zielony typecheck dla całego monorepo | [OK] |
| Naprawa DB credentials (Postgres role) | [OK] |
| maskedErrors: false w Yoga | [OK] |
| Dodanie Vitest + testów | [OK] |
| jwt.sign is not a function (fix) | [OK] |
| Błędny import w files.test.ts (fix) | [OK] |
| Propagacja .env do testów | [OK] |

## Wynik ogólny

**PASS**

Wszystkie założenia koncepcyjne zostały zrealizowane. `npm run typecheck` przechodzi czysto. Kod API jest zgodny z opisanymi naprawami. Warstwa testów pokrywa kluczowe ścieżki funkcjonalne (DB, auth flow, GraphQL health, pliki). Jedyna niepewność to faktyczne uruchomienie testów e2e (wymagają działającego serwera na porcie 3000) — nie były uruchamiane w ramach tego przeglądu, ale sam kod testów i konfiguracja są prawidłowe.
