# TASK-002: sprawić aby discordrive odpalał się bez błędów i dodać testy sprawdzające jego funkcjonalności

## Opis taska
Naprawić błędy startowe projektu discordrive i dodać testy sprawdzające jego funkcjonalności.

## Ustalenia z sesji koncepcyjnej
- Repo ma działający frontend build (`npm run build` dla `@ddv4/frontend` przechodzi), ale root `npm run typecheck` historycznie padał już na API.
- W `apps/api/src/schema.ts` był zduplikowany fragment funkcji `mergeResolvers`; to był pierwszy oczywisty błąd składni blokujący start API.
- Po usunięciu duplikatu wyszły dalsze problemy TypeScript/API: importy typu `default` dla `jsonwebtoken` i `argon2`, użycie `toReversed()`, oraz szerszy problem z konfiguracją TS / zgodnością modułów w API.
- `npm run typecheck` udało się doprowadzić do stanu zielonego. Kluczowe poprawki dotyczyły lokalnych `tsconfig.json` (API/config/types/plugin-sdk), dodania `apps/frontend/src/vite-env.d.ts` oraz wcześniejszych poprawek w API (`schema.ts`, importy CJS, `toReversed()`).
- Diagnoza `dev:api` bez pełnych napraw runtime pokazała, że proces nie kończy się natychmiast błędem składni/TS; problem przeniósł się z kompilacji na konfigurację/bootstrapping środowiska.
- Pogłębiona diagnoza wykazała, że `dev:api` faktycznie startuje i nasłuchuje na porcie `3000`. `/graphql` odpowiada poprawnie, introspekcja działa, a `GET /` zwraca oczekiwane `404` JSON.
- Najmocniejszy symptom runtime nie dotyczy samego bootu serwera, tylko ścieżek dotykających bazy. Zapytania GraphQL typu `me`, `storageUsage`, `login` kończą się `INTERNAL_SERVER_ERROR`, co wskazuje na problem w warstwie DB/auth, nie w HTTP serverze ani schema bootstrapie.
- Bezpośredni test Prisma z `node --env-file ../../.env` w `packages/database` potwierdza, że klient Prisma potrafi połączyć się z bazą, jeśli środowisko jest załadowane. Osobny test bez env kończy się błędem `Environment variable not found: DATABASE_URL`, więc krytycznym miejscem diagnostycznym pozostaje propagacja środowiska / sposób uruchamiania procesów pomocniczych, a nie sama definicja schematu GraphQL.
- Projekt nie ma jeszcze skonfigurowanego frameworka testowego w całym repo; trzeba dobrać minimalny zestaw testów adekwatny do obecnej architektury.

## Cel planowania
Przygotować plan, który doprowadzi do stabilnego uruchamiania discordrive bez błędów krytycznych oraz doda sensowną warstwę testów pokrywającą najważniejsze ścieżki funkcjonalne i regresje związane z naprawami startu.
