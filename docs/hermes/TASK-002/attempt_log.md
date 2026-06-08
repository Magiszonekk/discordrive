# TASK-002 Attempt Log

## 2026-04-23 13:09:46 UTC
- Subagent implementacyjny potwierdził root cause po stronie DB credentials / roli Postgresa, ale nie dokończył logowania artefaktów.
- Zaobserwowany runtime błąd przy `login`: `PrismaClientInitializationError` z komunikatem, że credentiale dla użytkownika `discordrive` są nieprawidłowe.
- Zweryfikowano `.env`: `DATABASE_URL` dekoduje się do użytkownika `discordrive` i hasła `discordrive`.
- Zweryfikowano role w Postgres: role `ddv4` i `discordrive` istnieją.
- Naprawa wykonana ręcznie: `ALTER ROLE discordrive WITH PASSWORD 'discordrive';`
- Weryfikacja po naprawie: `node --env-file .env ... db.user.count()` zwraca `OK count: 0`.
- Kolejny krok: ponownie uruchomić `dev:api`, sprawdzić GraphQL auth flow i dopiero potem dodać testy Vitest.

## 2026-04-23 13:18:30 UTC
- Root cause dla `login` po naprawie DB okazał się inny niż Prisma: GraphQL Yoga maskował błędy domenowe i zwracał `Unexpected error.` / `INTERNAL_SERVER_ERROR` dla zwykłego `throw new Error(...)` z resolverów.
- Potwierdzono to lokalnie przez `createYoga(..., maskedErrors: false)`: wtedy `login` zwraca prawidłowy komunikat `Invalid email/username or password`.
- Dodano `maskedErrors: false` do `apps/api/src/index.ts`, aby zachować oczekiwane błędy domenowe na API.
- Dodano konfigurację Vitest i pierwsze testy API/DB.
- Pierwszy bieg testów ujawnił dwa kolejne problemy implementacyjne:
  1. `jwt.sign is not a function` w `apps/api/src/middleware/auth.ts`
  2. błędny import w `src/__tests__/resolvers/files.test.ts`
- Kolejny krok: poprawić middleware JWT/import testu i ponowić testy + typecheck.
