# TASK-002 — Review planu vs. koncepcja

**Data przeglądu:** 2026-04-23  
**Dokumenty:** `concept.md` (koncepcja) ↔ `plan.md` (plan implementacji)

---

## 1. Czy plan realizuje WSZYSTKIE założenia z koncepcji?

### [OK] Naprawa błędów startu / INTERNAL_SERVER_ERROR
Koncepcja identyfikuje główny symptom runtime: `me`, `storageUsage`, `login` → `INTERNAL_SERVER_ERROR` spowodowany brakiem propagacji `DATABASE_URL`. Plan adresuje to w Kroku 1 jako problem krytyczny — brakująca rola `discordrive` w Postgres — i dostarcza dwa warianty naprawy (Opcja A i B) z krokami weryfikacji.

### [OK] Naprawa wcześniejszych błędów składniowych / TS
Koncepcja wymienia zduplikowany fragment `mergeResolvers` w `schema.ts`, importy `default` dla `jsonwebtoken`/`argon2`, `toReversed()`, problemy z `tsconfig.json`. Plan **nie powtarza tych napraw** (słusznie — koncepcja stwierdza, że `npm run typecheck` już przechodzi zielono). Definicja ukończenia zawiera punkt utrzymania stanu `typecheck`, co jest adekwatne.

### [OK] Brak frameworka testowego — dobór minimalnego zestawu
Koncepcja wskazuje, że projekt nie ma skonfigurowanego frameworka testowego. Plan wybiera **Vitest** jako minimalne, spójne z ekosystemem TS/ESM rozwiązanie, dodaje konfigurację oraz setup ładujący `.env`.

### [OK] Stabilny start serwera i działanie API end-to-end
Koncepcja mówi o doprowadzeniu do stabilnego uruchamiania. Plan zawiera Krok 2 — weryfikację API e2e po naprawie DB — z konkretnymi komendami `curl`.

### [OK] Pokrycie testami najważniejszych ścieżek funkcjonalnych
Koncepcja oczekuje testów dla kluczowych ścieżek. Plan pokrywa: połączenie DB, `register`, `login`, `me`, `storageUsage`.

### [OK] Pokrycie regresji związanej z naprawą startu
Koncepcja mówi o regresji startu. Plan ma dedykowany test: `login` z błędnym hasłem NIE może zwracać `INTERNAL_SERVER_ERROR`.

---

## 2. Czy nie ma sprzeczności między planem a koncepcją?

### [OK] Spójność diagnozy głównego problemu
Koncepcja: problem w propagacji środowiska / DATABASE_URL. Plan: brak roli `discordrive` w Postgres przy aktualnym kontenerze. Obie diagnozy są wzajemnie zgodne — jest to ten sam problem (niedziałające połączenie DB), opisany na różnym poziomie szczegółowości. Plan pogłębia diagnozę, nie przeczy koncepcji.

### [OK] Podejście do .env
Koncepcja: `.env` jest spójne z intencją, problem w stanie kontenera. Plan: `.env` — tylko weryfikacja, nie modyfikacja. Pełna zgodność.

### [OK] Poprawki TS/typecheck
Koncepcja: typecheck doprowadzony do zielonego. Plan: nie cofa ani nie modyfikuje tych poprawek, jedynie weryfikuje ich utrzymanie. Brak sprzeczności.

### [PROBLEM — DROBNY] Test `files.test.ts` jest szkieletem bez implementacji
W planie plik `apps/api/src/__tests__/resolvers/files.test.ts` (4d) zawiera pustą implementację z komentarzem `// wymaga authToken`. Koncepcja oczekuje pokrycia ścieżki `storageUsage`. Definicja ukończenia wymaga przechodzenia testu `storageUsage` — jednak plan nie dostarcza pełnej implementacji tego testu, tylko placeholder. Ryzyko: krok implementacji może pominąć ten test lub dostarczyć pusty plik, który technicznie "przechodzi" bez asercji.

---

## 3. Czy definicja ukończenia jest zgodna z oczekiwaniami koncepcji?

### [OK] Naprawa runtime — pełne pokrycie
Koncepcja: stabilny start, brak krytycznych błędów. DoD planu: `dev:api` bez błędów, `__typename` OK, `login` błędny → poprawny błąd GraphQL (nie INTERNAL), `register` zwraca token, `me` zwraca dane, `storageUsage` zwraca `{ totalBytes, fileCount }`. Pokrycie kompletne.

### [OK] Testy — zakres zgodny z koncepcją
DoD: `npm test` zielony, pokryte DB/register/login/me/storageUsage, test regresyjny login, idempotentność. Spójne z oczekiwaniami koncepcji.

### [OK] Typecheck — utrzymanie poprzedniego stanu
Koncepcja explicite wymienia zielony typecheck jako osiągnięcie. DoD wymaga jego utrzymania.

### [PROBLEM — DROBNY] Brak weryfikacji idempotentności w przykładach kodu
DoD wymaga, żeby testy były idempotentne (cleanup danych). Plan omawia to jako "Problem 2" z sugestią (unikalny timestamp e-mail, cleanup w `afterAll`), ale nie dostarcza kodu `afterAll` w przykładach testów. Deklaracja w DoD może nie zostać spełniona bez dodatkowej pracy.

---

## 4. Czy proponowane testy pokrywają wymagania z koncepcji?

### [OK] Połączenie z bazą danych
`packages/database/src/__tests__/connection.test.ts` — bezpośredni test klienta Prisma z pełną implementacją.

### [OK] Smoke test API (introspection)
`health.test.ts` — pełna implementacja.

### [OK] Rejestracja użytkownika (`register`)
`auth.test.ts` — pełna implementacja z asercjami.

### [OK] Logowanie (`login`) — ścieżka szczęśliwa i błędna
`auth.test.ts` — obie ścieżki pokryte. Ścieżka błędna to kluczowa regresja z koncepcji.

### [OK] Query `me` z ważnym tokenem
`auth.test.ts` — implementacja z nagłówkiem `Authorization`.

### [PROBLEM — DROBNY] Query `storageUsage` — brak pełnej implementacji testu
`files.test.ts` — placeholder bez asercji. Koncepcja wymaga pokrycia tej ścieżki. Ryzyko nieukończenia.

### [OK] Dobór frameworka (Vitest)
Vitest jest spójny z obecnym stackiem (ESM, TypeScript, Vite w frontendzie). Adekwatny wybór.

---

## Ogólna ocena

**PASS** ✅ (z zastrzeżeniami)

Plan jest **spójny z koncepcją** i realizuje wszystkie kluczowe założenia. Diagnoza, kolejność kroków, dobór narzędzi i definicja ukończenia są wzajemnie zgodne z dokumentem koncepcyjnym.

### Zastrzeżenia (nieblokujące):
1. **`files.test.ts` (storageUsage)** — placeholder bez implementacji. Wymaga uzupełnienia podczas implementacji; plan powinien to oznaczyć jako TODO, nie gotowy test.
2. **Brak kodu `afterAll` / cleanup** — DoD deklaruje idempotentność testów, ale przykłady kodu jej nie implementują. Należy uzupełnić podczas pisania testów.

### Rekomendacja dla implementatora:
- Uzupełnić `files.test.ts` o pełną implementację (fixture authToken ze wspólnego setup lub `globalThis`).
- Dodać `afterAll` z `db.user.deleteMany({ where: { email: { contains: 'vitest.local' } } })` w `auth.test.ts`.
