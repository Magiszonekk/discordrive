# TASK-002 — Plan implementacji

## Cel
Naprawić błędy runtime (INTERNAL_SERVER_ERROR na zapytaniach DB/auth) i dodać testy pokrywające kluczowe ścieżki funkcjonalne.

---

## Diagnoza stanu aktualnego

### Symptom główny
API startuje, `/graphql` introspection działa, ale **wszystkie resolwery dotykające bazy** (`me`, `login`, `register`, `storageUsage`, itp.) zwracają `INTERNAL_SERVER_ERROR`.

### Zidentyfikowana przyczyna
`DATABASE_URL` w `.env` używa credentials `postgresql://discordrive:***@localhost:5432/discordrive`, natomiast działający kontener PostgreSQL (`infra-postgres-1`) posiada **wyłącznie rolę `ddv4`** — rola `discordrive` nie istnieje. Baza `discordrive` istnieje i ma poprawny schemat (tabele `User`, `File`, `Folder`, itd.) ale połączenie pada na autentykacji Postgres.

**Weryfikacja:**
```
docker exec infra-postgres-1 psql -U ddv4 -c "\du"
# → tylko rola ddv4, brak discordrive
```

### Drugi potencjalny problem
`infra/docker-compose.yml` tworzy Postgres z `POSTGRES_USER=ddv4` (domyślnie), ale `.env` w root projektu deklaruje `POSTGRES_USER=discordrive`. Przy następnym `infra:up` od zera kontener zostanie stworzony z credentialami z `.env` — więc `.env` jest spójny _z intencją_, ale nie z _aktualnym stanem_ kontenera.

---

## Lista plików do stworzenia / modyfikacji

### Naprawa DB/auth (KRYTYCZNE)

| Plik | Akcja | Uzasadnienie |
|------|-------|--------------|
| `.env` | **TYLKO weryfikacja** — bez zmiany wartości | Credentiale są intencjonalne; naprawiamy stan Postgres, nie .env |
| `infra/docker-compose.yml` | Weryfikacja (brak zmian) | Już obsługuje zmienne z `.env`; problem w tym że kontener był stworzony bez pliku .env |

**Właściwa naprawa:** Zsynchronizować stan kontenera Postgres z `.env` (patrz krok 1 poniżej).

### Testy

| Plik | Akcja | Uzasadnienie |
|------|-------|--------------|
| `package.json` (root) | Modyfikacja — dodanie skryptu `test` | Centrum uruchamiania testów |
| `apps/api/package.json` | Modyfikacja — dodanie `vitest` + skryptu `test` | Framework testowy dla API |
| `apps/api/vitest.config.ts` | Stworzenie | Konfiguracja vitest: pool=forks, env-file |
| `apps/api/src/__tests__/health.test.ts` | Stworzenie | Test smoke: API odpowiada na introspection |
| `apps/api/src/__tests__/auth.test.ts` | Stworzenie | Testy register/login przez GraphQL |
| `apps/api/src/__tests__/db-connection.test.ts` | Stworzenie | Test połączenia z DB przez Prisma |
| `apps/api/src/__tests__/resolvers/me.test.ts` | Stworzenie | Test resolvera `me` z ważnym tokenem |
| `apps/api/src/__tests__/resolvers/files.test.ts` | Stworzenie | Test `storageUsage`, `files` |
| `packages/database/src/__tests__/connection.test.ts` | Stworzenie | Izolowany test klienta Prisma |

---

## Kolejność kroków implementacji

### Krok 1 — Naprawa DB: zsynchronizuj kontener Postgres z .env

Problem: kontener Postgres został wystartowany bez odczytania `POSTGRES_USER` z `.env` lub z innymi wartościami.

**Opcja A (zalecana — bez utraty danych):**
```bash
# Utwórz brakującą rolę i nadaj uprawnienia
docker exec infra-postgres-1 psql -U ddv4 -d discordrive -c "
  CREATE ROLE discordrive WITH LOGIN PASSWORD '<hasło z .env>';
  GRANT ALL PRIVILEGES ON DATABASE discordrive TO discordrive;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO discordrive;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO discordrive;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO discordrive;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO discordrive;
"
```

**Opcja B (pełny reset — jeśli dane nieistotne):**
```bash
cd infra && docker compose down -v && docker compose --env-file ../.env up -d
# Następnie: npm run db:generate && npm run db:migrate
```

**Weryfikacja po kroku 1:**
```bash
node --env-file .env --input-type=module <<'EOF'
import { PrismaClient } from './packages/database/node_modules/@prisma/client/index.js';
const db = new PrismaClient(); 
db.user.count().then(c => { console.log('OK, users:', c); db.$disconnect(); }).catch(e => console.error('FAIL:', e.message));
EOF
```

### Krok 2 — Weryfikacja API end-to-end po naprawie DB

```bash
npm run dev:api &
sleep 3

# Test introspection (już działało)
curl -s -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{__typename}"}' | jq .

# Test login (wcześniej INTERNAL_SERVER_ERROR)
curl -s -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { login(emailOrUsername: \"test@x.com\", password: \"test\") { token } }"}' | jq .
# Oczekiwany wynik: błąd "Invalid credentials" (nie INTERNAL_SERVER_ERROR)
```

### Krok 3 — Konfiguracja frameworka testowego (Vitest)

```bash
npm install --workspace=@ddv4/api --save-dev vitest @vitest/coverage-v8
```

`apps/api/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    globals: true,
    env: {
      // Vitest ładuje zmienne środowiskowe — alternatywnie użyć dotenv w setup
    },
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

`apps/api/src/__tests__/setup.ts`:
```typescript
import { config } from 'dotenv';
import { resolve } from 'path';

// Załaduj .env z root monorepo
config({ path: resolve(__dirname, '../../../../.env') });
```

### Krok 4 — Napisz testy

#### 4a. Test połączenia z DB (`packages/database/src/__tests__/connection.test.ts`)
```typescript
import { describe, it, expect } from 'vitest';
import { db } from '../index.js';

describe('Prisma DB connection', () => {
  it('should connect and return user count', async () => {
    const count = await db.user.count();
    expect(count).toBeGreaterThanOrEqual(0);
    await db.$disconnect();
  });
});
```

#### 4b. Test smoke GraphQL (`apps/api/src/__tests__/health.test.ts`)
```typescript
import { describe, it, expect } from 'vitest';

const GQL = 'http://localhost:3000/graphql';

describe('GraphQL health', () => {
  it('should respond to introspection', async () => {
    const res = await fetch(GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    const json = await res.json();
    expect(json.data.__typename).toBe('Query');
  });
});
```

#### 4c. Test auth (`apps/api/src/__tests__/auth.test.ts`)
```typescript
import { describe, it, expect } from 'vitest';

const GQL = 'http://localhost:3000/graphql';

async function gql(query: string) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

describe('Auth resolvers', () => {
  it('login with invalid credentials returns error (not INTERNAL_SERVER_ERROR)', async () => {
    const result = await gql(`mutation { login(emailOrUsername: "nonexistent@test.com", password: "wrongpass") { token } }`);
    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).not.toBe('Unexpected error.');
    expect(result.errors[0].extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
  });

  const testEmail = `test-${Date.now()}@vitest.local`;
  let authToken: string;

  it('register creates new user', async () => {
    const result = await gql(`
      mutation {
        register(
          email: "${testEmail}"
          username: "testuser${Date.now()}"
          password: "TestPass123!"
          kekSalt: "aabbcc"
          wrapIv: "ddeeff"
          encryptedMasterKey: "00112233"
        ) { token user { id email } }
      }
    `);
    expect(result.errors).toBeUndefined();
    expect(result.data.register.token).toBeTruthy();
    authToken = result.data.register.token;
  });

  it('login returns token for registered user', async () => {
    const result = await gql(`mutation { login(emailOrUsername: "${testEmail}", password: "TestPass123!") { token user { email } } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.login.token).toBeTruthy();
  });

  it('me query returns user with valid token', async () => {
    const res = await fetch(GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ query: '{ me { id email } }' }),
    });
    const result = await res.json();
    expect(result.errors).toBeUndefined();
    expect(result.data.me.email).toBe(testEmail);
  });
});
```

#### 4d. Test `storageUsage` (`apps/api/src/__tests__/resolvers/files.test.ts`)
```typescript
import { describe, it, expect } from 'vitest';

// (wymaga aktywnego tokenu — można go wziąć z auth.test.ts przez globalny store lub setup fixture)
describe('File resolvers', () => {
  it('storageUsage returns valid structure for authenticated user', async () => {
    // ... (wymaga authToken z wcześniejszego testu lub setup fixture)
  });
});
```

### Krok 5 — Dodaj skrypty testowe do package.json

`apps/api/package.json`:
```json
"scripts": {
  "test": "vitest run --reporter=verbose",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```

`package.json` (root):
```json
"test": "npm run test --workspace=@ddv4/api",
"test:db": "npm run test --workspace=@ddv4/database"
```

### Krok 6 — Uruchom testy i zweryfikuj

```bash
# Upewnij się że API działa w tle (testy integracyjne)
npm run dev:api &

npm test
```

---

## Potencjalne problemy i rozwiązania

### Problem 1: Testy integracyjne wymagają działającego serwera
**Rozwiązanie:** Dwa podejścia:
- **Prosty** (zalecany na start): testy zakładają, że API jest uruchomione osobno (CI: `dev:api &` przed `npm test`)
- **Zaawansowany**: użyć `globalSetup` Vitest do startowania serwera in-process przed testami

### Problem 2: Brudne dane testowe w bazie
**Rozwiązanie:** Używać unikalnych emaili (timestamp), cleanup w `afterAll` lub dedykowana test-DB przez osobny `DATABASE_URL_TEST`.

### Problem 3: Kolejność testów (authToken z register potrzebny w me/storageUsage)
**Rozwiązanie:** Użyć `vitest --sequence.concurrent=false` lub przechowywać stan przez `let` w obrębie pliku testowego (jak w przykładach wyżej).

### Problem 4: `tsx` / importy ESM w testach
**Rozwiązanie:** Skonfigurować Vitest z `pool: 'forks'` i dodać `@vitest/transform` lub plugin dla TypeScript. Alternatywnie: użyć `vitest` z `vite-node` który domyślnie wspiera TS.

### Problem 5: Prisma client nie ładuje `DATABASE_URL` w środowisku testowym
**Rozwiązanie:** Zadbać, że `setup.ts` ładuje dotenv **przed** importem `@ddv4/database`. Użyć `setupFiles` (wykonywane przed importami modułów testowych).

### Problem 6: `infra-tor-rotator-1` i `wstunnel` ciągle restartują
**Nieblokujące dla DB/API**, ale warto odnotować w devops. Można zignorować na potrzeby tego taska.

---

## Definicja ukończenia (Definition of Done)

Task uznajemy za **ukończony**, gdy spełnione są **wszystkie** poniższe warunki:

### ✅ Naprawa runtime
- [ ] `npm run dev:api` startuje bez błędów krytycznych w logach
- [ ] `curl -X POST http://localhost:3000/graphql -d '{"query":"{__typename}"}'` zwraca `{"data":{"__typename":"Query"}}`
- [ ] Mutacja `login` z niepoprawnymi credentialami zwraca GraphQL error (`Invalid email/username or password`), **NIE** `INTERNAL_SERVER_ERROR`
- [ ] Mutacja `register` tworzy użytkownika i zwraca token
- [ ] Query `me` z ważnym tokenem zwraca dane użytkownika
- [ ] Query `storageUsage` z ważnym tokenem zwraca `{ totalBytes, fileCount }`

### ✅ Testy
- [ ] `npm test` przechodzi bez błędów (wszystkie testy zielone)
- [ ] Pokryte ścieżki: połączenie DB, register, login, me, storageUsage
- [ ] Test regresyjny: `login` z błędnym hasłem NIE zwraca `INTERNAL_SERVER_ERROR`
- [ ] Testy można uruchamiać wielokrotnie (idempotentne — cleanup danych testowych)

### ✅ Typecheck
- [ ] `npm run typecheck` przechodzi zielono (stan z poprzedniej sesji utrzymany)

---

## Szacowany nakład pracy

| Krok | Czas szacowany |
|------|---------------|
| Krok 1: Naprawa DB (opcja A — SQL) | 15 min |
| Krok 2: Weryfikacja API e2e | 10 min |
| Krok 3: Konfiguracja Vitest | 20 min |
| Krok 4: Napisanie testów | 45 min |
| Krok 5-6: Skrypty + uruchomienie | 15 min |
| **Łącznie** | **~1h 45min** |
