# DiscorDrive v3 — Plan implementacji

> Dokument kontekstowy dla agenta implementującego projekt od zera.
> Zawiera wszystkie decyzje architektoniczne, wyniki researchu Discord API, i szczegółowy plan faz.

---

## 1. Co to jest

DiscorDrive to self-hosted chmura z "nieograniczonym" storage, która używa Discord webhooków jako backendu do przechowywania plików. Pliki są dzielone na chunki ≤10 MB, szyfrowane E2E (AES-256-GCM), i uploadowane jako attachmenty wiadomości na kanałach Discord. Metadane (mapowanie pliku → chunki → message_id) żyją w PostgreSQL.

Primary use case: archiwum ~14 TB plików MP4 (filmy ~400 MB każdy, ~35k plików) z rzadkim odczytem.

---

## 2. Kluczowy kontekst: Discord API rate limits

Cały projekt opiera się na zrozumieniu jak Discord egzekwuje rate limity. Poniżej zebrane wyniki researchu.

### 2.1 System bucketów

Discord używa leaky bucket algorithm z trzema warstwami:

**Global rate limit**: 50 req/s per bot token. Webhooks są WYŁĄCZONE z globalnego limitu bota — to kluczowa przewaga webhooków nad botami.

**Per-route rate limit**: Scopowany przez endpoint template + "major parameter" (`channel_id`, `guild_id`, lub `webhook_id`). Dwa requesty do `/channels/1234/messages` i `/channels/5678/messages` mają NIEZALEŻNE countery — bo różny `channel_id`.

**Shared/resource-level limit** (`X-RateLimit-Scope: shared`): Dotyczy zasobu (kanał/guild) i jest dzielony między WSZYSTKICH callerów — inny bot na tym samym kanale może wyczerpać Twój budżet.

### 2.2 Konkretne limity dla operacji DiscorDrive

| Operacja | Limit | Scope |
|----------|-------|-------|
| POST message (= upload chunk) | ~5 req / 2s = ~150 req/min | per channel (webhook_id) |
| GET message (= refresh URL) | ~5 req / 2s | per channel (webhook_id) |
| DELETE message | ~5 req / 2s | per channel (webhook_id) |
| Global (bot token) | 50 req/s | per token |
| Webhooks | NIE podlegają globalnemu limitowi bota | — |

### 2.3 Headery rate limit

Każda odpowiedź Discord API zawiera:

```
X-RateLimit-Limit: max requestów w oknie
X-RateLimit-Remaining: ile zostało
X-RateLimit-Reset: Unix timestamp resetu
X-RateLimit-Reset-After: sekundy do resetu (decimal)
X-RateLimit-Bucket: hash identyfikujący route template
X-RateLimit-Scope: user|global|shared (tylko przy 429)
Retry-After: sekundy do ponowienia (tylko przy 429)
```

### 2.4 Cloudflare IP ban — KRYTYCZNE

Ponad systemem rate limitów Discorda, Cloudflare banuje IP na 24h jeśli wygeneruje **10,000 invalid requests (401/403/429) w ciągu 10 minut**. To jest PER IP, nie per token — multiple boty na jednym serwerze dzielą ten limit. Przy uploadzue 14 TB z jednego VPSa, jeden IP ban = stracony dzień.

### 2.5 Throughput per webhook

- 1 webhook = ~5 req/2s × 10 MB chunk = ~25 MB/s teoretycznie, **~10-15 MB/s realnie** (latencja HTTP)
- 5 webhooks na 5 osobnych kanałach = **~50-75 MB/s**
- WAŻNE: 2 webhooks na 1 kanale = ZERO zysku (dzielą bucket per channel_id)
- Każdy webhook MUSI być na osobnym kanale

### 2.6 Limit rozmiaru pliku

| Tier | Max per file |
|------|-------------|
| Free / Default bot | **10 MB** (obniżone z 25 MB we wrześniu 2024) |
| Nitro Basic | 50 MB |
| Server Boost Level 2 | 50 MB |
| Server Boost Level 3 | 100 MB |
| Nitro | 500 MB |

Projekt zakłada 10 MB jako default. Dynamiczne wykrywanie wyższego limitu (413 → fallback do 10 MB).

### 2.7 CDN URLs — signed i wygasające

Od 2024 attachment URLe zawierają podpisane parametry: `ex` (expiration), `is` (issued), `hm` (HMAC-SHA256). Wygasają po ~24h. Nie da się wygenerować nowego podpisu client-side.

**Refresh flow**: `GET /webhooks/{id}/{token}/messages/{msgId}` → odpowiedź zawiera ŚWIEŻY attachment URL.

Projekt NIE trzyma CDN URLi w bazie. Trzyma tylko `message_id` + `channel_id`. Świeży URL pobierany on-demand.

### 2.8 Webhook vs Bot

| Cecha | Webhook | Bot |
|-------|---------|-----|
| Auth | URL z tokenem (zero headerów) | `Authorization: Bot {token}` |
| Upload | POST multipart → message z attachment | POST multipart → message |
| Download | GET message → attachment URL | GET message → attachment URL |
| Gateway/WS | NIE potrzebuje | Wymaga połączenia |
| Global rate limit | WYŁĄCZONY z bot global limit | 50 req/s shared |
| Rate limit scope | per webhook_id | per bot token + route |
| Tworzenie | UI lub `POST /channels/{id}/webhooks` | Developer Portal |
| Limit per kanał | 15 webhooks | — |
| Odczyt wiadomości | Tylko SWOJE (via webhook token) | Wszystkie (z permisjami) |

Projekt używa WYŁĄCZNIE webhooków. Zero bot tokena. Trzy endpointy:
1. `POST /webhooks/{id}/{token}` — upload chunk
2. `GET /webhooks/{id}/{token}/messages/{msgId}` — get message (świeży CDN URL)
3. `DELETE /webhooks/{id}/{token}/messages/{msgId}` — delete chunk

### 2.9 1 chunk = 1 wiadomość

Discord pozwala do 10 attachmentów per wiadomość. Projekt celowo używa 1:1 bo:
- Prostszy retry (fail = powtórz 10 MB, nie 100 MB)
- `message_id` = chunk, zero ambiguity
- Prostsze metadane w DB
- Throughput skaluje się przez dodawanie kanałów/webhooków
- Przy łączu VPS ~46 MB/s (370 Mbps) 3-4 webhooks i tak nasycają bandwidth

### 2.10 Istniejące projekty referencyjne

- **ddrive** (~530 stars) — testowany z 4 TB na jednym kanale. V4 przeszedł na webhooks i PostgreSQL. Upload 5 GB w 85s (~60 MB/s). Rekomenduje min 5 webhooków.
- **discord-fs** — FUSE filesystem, AES-256, 8 MB chunki.
- **DisboxApp** — browser-based, webhooks only.

---

## 3. Architektura

### 3.1 Stack

- **Runtime**: Bun
- **Monorepo**: Bun workspaces
- **Backend**: Bun.serve (GraphQL Yoga + HTTP handlers)
- **Frontend**: Vite + React 19 + React Router 7 + TailwindCSS 4 + shadcn/ui
- **Baza**: PostgreSQL + Prisma (PrismaPg adapter)
- **Szyfrowanie**: AES-256-GCM (Web Crypto API) + Argon2id (hash-wasm)
- **State**: Zustand
- **GraphQL client**: graphql-request
- **Queries**: @tanstack/react-query

### 3.2 Struktura workspace'ów

```
ddv3/
├── apps/api/                GraphQL + HTTP backend
├── apps/frontend/           Vite + React + shadcn
├── packages/config/         Stałe konfiguracyjne
├── packages/database/       Prisma + PostgreSQL
├── packages/discord-client/ Webhook integration (raw fetch, 3 endpointy)
├── packages/processing/     Crypto, chunking, hashing
├── packages/types/          TypeScript types
└── infra/                   Docker + env
```

### 3.3 Kluczowe decyzje

- **Discord.js USUNIĘTY** — zastąpiony raw `fetch`. Trzy endpointy webhook, zero bot tokena. Oszczędność ~50 MB node_modules, pełna kontrola nad rate limit headers.
- **Metadane w PostgreSQL** — NIGDY w wiadomościach Discord. ddrive przy 3 TB miał 30+ min startup ładując metadane z kanału.
- **CDN URLe NIE w bazie** — wygasają po 24h, bezwartościowe. Trzymamy `message_id` + `channel_id`, świeży URL on-demand.
- **IV prepended do chunku** — format: `[12B IV][ciphertext]`. Chunk jest self-contained, zero dodatkowych kolumn/headerów na IV. Przy decrypt: odetnij pierwsze 12B = IV, reszta = ciphertext.
- **Master Key TYLKO w pamięci** (Zustand store). Po refresh strony → ponowne podanie hasła.
- **Nazwy plików i foldery NIESZYFROWANE server-side** — szyfrowany jest tylko content chunków.

### 3.4 Hierarchia kluczy E2E

```
Master Password
    ↓ Argon2id(password, salt)
   KEK (Key Encryption Key)
    ↓ AES-GCM wrapKey
  Master Key (random AES-256)
    ↓ AES-GCM wrapKey (per file)
   FEK (File Encryption Key, random AES-256)
    ↓ AES-GCM encrypt (per chunk)
  [IV|ciphertext]
```

- Rejestracja: derive KEK → generate Master Key → wrap MK z KEK → zapisz {kekSalt, wrapIv, encryptedMasterKey}
- Login: derive KEK → unwrap MK → trzymaj MK w pamięci
- Upload: generate FEK → wrap z MK → zapisz {encryptedFEK, fekIv} w DB
- Zmiana hasła: derive nowy KEK → re-wrap MK → re-wrap WSZYSTKICH FEK client-side → batch update

### 3.5 Upload flow

```
Plik → generate FEK → wrap FEK z Master Key
     → SHA-256 hash (streaming, hash-wasm)
     → initUpload mutation → fileId
     → chunk file (10 MB)
        → encrypt chunk (AES-GCM) → prepend IV → [IV|ciphertext]
        → POST /api/upload/:fileId/chunk/:index
            → backend POST do Discord webhook (multipart)
            → zapisz {messageId, channelId, webhookId, size} w DB
     → finalizeUpload mutation
        → integrity check: SELECT COUNT(*) WHERE file_id = ? AND message_id IS NOT NULL
        → jeśli count ≠ chunkCount → reject z listą brakujących indeksów
```

Concurrency: 3 równoległe uploady. Round-robin między webhookami/kanałami.

### 3.6 Download flow (streaming)

```
DB → file metadane (chunkCount, encryptedFEK, fekIv)
   → unwrap FEK z Master Key
   → ReadableStream:
      → dla każdego chunk index 0..N-1:
         → DB → messageId, channelId, webhookId
         → GET /webhooks/{id}/{token}/messages/{msgId} → świeży CDN URL
         → fetch CDN URL → encrypted chunk stream
         → TransformStream: [IV|ciphertext] → odetnij 12B IV → decrypt → plaintext
         → push do output
   → Output via:
      A) Service Worker (primary, uniwersalny z HTTPS) — StreamSaver.js pattern
      B) File System Access API (Chrome/Edge — user wybiera lokalizację)
      C) Blob fallback (tylko <500 MB)
   → SHA-256 hash streaming weryfikacja na końcu
```

Pamięć: max ~30-60 MB in-flight (2-3 chunki × 10 MB × 2 encrypted+decrypted), niezależnie od rozmiaru pliku.

### 3.7 Share flow

**Tworzenie**:
1. Frontend ma FEK w pamięci → generuje losowy 32B share key
2. Wrap FEK share key'em (AES-GCM)
3. Mutation `createShareLink` z wrappedFEK + opcjonalne hasło
4. Jeśli hasło: dodatkowy wrap FEK kluczem z Argon2(password). Server przechowuje hash hasła.
5. URL: `domain.com/share/{token}#key={base64ShareKey}` — fragment `#` nie jest wysyłany do serwera

**Otwieranie**:
1. Extract `#key=...` z URL
2. GET `/api/share/:token/info` → metadane + wrappedFEK
3. Jeśli password-protected: prompt → POST verify-password
4. Unwrap FEK → download + decrypt normalnie

**Revoke**: Usuń ShareLink z DB → serwer odmawia dostępu niezależnie od posiadania klucza.

---

## 4. Fazy implementacji

### Faza 1: Fundamenty (`packages/types`, `packages/config`)

#### 1.1 `packages/types/src/index.ts`

Wszystkie interfejsy:
- `User` — id, email, passwordHash, kekSalt, wrapIv, encryptedMasterKey, createdAt
- `File` — id, userId, folderId?, name, mimeType, size (BigInt), chunkSize, chunkCount, encryptedFEK, fekIv, sha256, thumbnailUrl?, status (UPLOADING|READY|FAILED), createdAt
- `Chunk` — id, fileId, index, messageId, channelId, webhookId, size
- `Folder` — id, userId, parentId?, name, createdAt
- `ShareLink` — token, fileId, userId, wrappedFEK, wrapIv, passwordHash?, passwordSalt?, expiresAt?, label?, downloads, maxDownloads?
- `UploadProgress` — fileId, fileName, totalChunks, uploadedChunks, bytesUploaded, bytesTotal, status
- `DownloadProgress` — fileId, fileName, totalChunks, downloadedChunks, bytesDownloaded, bytesTotal
- `UploadStatus` enum — PENDING, HASHING, ENCRYPTING, UPLOADING, FINALIZING, DONE, FAILED
- `ChunkMeta` — index, messageId, channelId, webhookId, size
- `AppMode` — "full" | "backend-only"
- `WebhookHealth` — id, channelId, remaining, resetAt, isAvailable

Plus `api.ts`:
- RegisterRequest, LoginResponse
- InitUploadRequest/Response
- CreateShareRequest, ShareInfoResponse

#### 1.2 `packages/config/src/index.ts`

```ts
export const config = {
  defaultChunkSize: 10 * 1024 * 1024,       // 10 MB — bezpieczny default (darmowe webhooki)
  maxChunkSize: 25 * 1024 * 1024,            // 25 MB — tylko Nitro/boost, wykrywany dynamicznie
  argon2: { memory: 65536, iterations: 3, parallelism: 4, hashLength: 32 },
  ivLength: 12,
  saltLength: 16,
  defaultUploadConcurrency: 3,
  webhookRateLimitDefault: 120,              // ~120 req/min start, dynamicznie z X-RateLimit-*
  webhookRateLimitWindow: 60_000,
  cloudflareErrorThreshold: 8000,            // stop przed 10k/10min IP ban
  anonymousTTLDays: 30,
  appMode: (process.env.APP_MODE ?? "full") as AppMode,
  apiUrl: process.env.API_URL ?? "http://localhost:3000",
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:5173",
  jwtSecret: process.env.JWT_SECRET ?? "change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
}
```

Osobny `db.ts` z `getConnectionString()` (server-only import).

---

### Faza 2: Baza danych (`packages/database`)

#### 2.1 `prisma/schema.prisma`

```prisma
model User {
  id                 String    @id @default(cuid())
  email              String    @unique
  passwordHash       String
  kekSalt            String    // base64 — salt do Argon2id
  wrapIv             String    // base64 — IV użyty do wrap Master Key
  encryptedMasterKey String    // base64 — Master Key wrapped z KEK
  createdAt          DateTime  @default(now())
  files              File[]
  folders            Folder[]
  shareLinks         ShareLink[]
}

model File {
  id           String     @id @default(cuid())
  userId       String
  folderId     String?
  name         String
  mimeType     String     @default("application/octet-stream")
  size         BigInt
  chunkSize    Int
  chunkCount   Int
  encryptedFEK String     // base64 — FEK wrapped z Master Key
  fekIv        String     // base64 — IV użyty do wrap FEK
  sha256       String?    // hex — hash oryginalnego pliku
  thumbnailUrl String?
  status       FileStatus @default(UPLOADING)
  createdAt    DateTime   @default(now())

  user       User        @relation(fields: [userId], references: [id])
  folder     Folder?     @relation(fields: [folderId], references: [id])
  chunks     Chunk[]
  shareLinks ShareLink[]

  @@index([userId, folderId])
  @@index([status, createdAt]) // dla cron cleanup orphanów
}

enum FileStatus {
  UPLOADING
  READY
  FAILED
}

model Chunk {
  id          String @id @default(cuid())
  fileId      String
  index       Int
  messageId   String // Discord message ID
  channelId   String // Discord channel ID
  webhookId   String // webhook użyty do uploadu
  size        Int    // rozmiar zaszyfrowanego chunku (z IV)

  file File @relation(fields: [fileId], references: [id], onDelete: Cascade)

  @@unique([fileId, index])
}

model Folder {
  id        String   @id @default(cuid())
  userId    String
  parentId  String?
  name      String
  createdAt DateTime @default(now())

  user     User      @relation(fields: [userId], references: [id])
  parent   Folder?   @relation("FolderTree", fields: [parentId], references: [id])
  children Folder[]  @relation("FolderTree")
  files    File[]

  @@index([userId, parentId])
}

model ShareLink {
  token        String    @id @default(cuid())
  fileId       String
  userId       String
  wrappedFEK   String    // base64 — FEK wrapped z share key
  wrapIv       String    // base64
  passwordHash String?   // Argon2 hash hasła (jeśli password-protected)
  passwordSalt String?   // base64
  expiresAt    DateTime?
  label        String?
  downloads    Int       @default(0)
  maxDownloads Int?
  createdAt    DateTime  @default(now())

  file File @relation(fields: [fileId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id])

  @@index([fileId])
  @@index([expiresAt])
}

model Setting {
  key   String @id
  value String
}
```

**WAŻNE**: Chunk NIE ma kolumny `iv`. IV jest prepended do encrypted data (pierwsze 12 bajtów chunku = IV). Chunk jest self-contained.

#### 2.2 `src/index.ts`

Prisma client z PrismaPg adapter. Re-export typów.

---

### Faza 3: Processing (`packages/processing`)

Musi być **browser-compatible** (Web Crypto API + hash-wasm). Zero Node/Bun-only API.

#### 3.1 `src/crypto.ts`

```ts
// Hierarchia kluczy
deriveKEK(password: string, salt: Uint8Array): Promise<CryptoKey>
  // Argon2id via hash-wasm → importKey jako AES-GCM wrapKey/unwrapKey

generateMasterKey(): Promise<CryptoKey>
  // crypto.subtle.generateKey AES-GCM 256

wrapKey(keyToWrap: CryptoKey, wrappingKey: CryptoKey): Promise<{data: ArrayBuffer, iv: Uint8Array}>
  // crypto.subtle.wrapKey

unwrapKey(wrapped: ArrayBuffer, unwrappingKey: CryptoKey, iv: Uint8Array): Promise<CryptoKey>
  // crypto.subtle.unwrapKey

generateFEK(): Promise<CryptoKey>
  // crypto.subtle.generateKey AES-GCM 256, encrypt/decrypt usage

encryptChunk(chunk: ArrayBuffer, fek: CryptoKey): Promise<ArrayBuffer>
  // generate random 12B IV
  // encrypt = crypto.subtle.encrypt AES-GCM
  // return [IV (12B) | ciphertext] — SELF-CONTAINED

decryptChunk(encryptedWithIv: ArrayBuffer, fek: CryptoKey): Promise<ArrayBuffer>
  // iv = first 12 bytes
  // ciphertext = rest
  // return crypto.subtle.decrypt AES-GCM

// Utilities
generateSalt(length?: number): Uint8Array
randomBytes(length: number): Uint8Array
toBase64(buffer: ArrayBuffer): string
fromBase64(base64: string): ArrayBuffer
exportKey(key: CryptoKey): Promise<ArrayBuffer>
importKey(raw: ArrayBuffer, usages: KeyUsage[]): Promise<CryptoKey>
```

#### 3.2 `src/chunker.ts`

```ts
async function* chunkFileStream(
  file: File | ReadableStream<Uint8Array>,
  chunkSize: number = config.defaultChunkSize
): AsyncGenerator<{index: number, data: Uint8Array}>
```

Konfigurowalny rozmiar chunku. Streaming — nie ładuje całego pliku do pamięci.

#### 3.3 `src/hash.ts`

SHA-256 streaming via hash-wasm. Browser + Bun compatible.

```ts
async function hashStream(stream: ReadableStream<Uint8Array>): Promise<string>
  // returns hex string
```

---

### Faza 4: Discord Client (`packages/discord-client`)

#### 4.1 Trzy endpointy (raw fetch, ZERO discord.js)

```ts
// Upload chunk — returns message with attachment
POST https://discord.com/api/webhooks/{webhookId}/{webhookToken}
Content-Type: multipart/form-data
Body: file attachment

// Get message — returns fresh signed CDN URL
GET https://discord.com/api/webhooks/{webhookId}/{webhookToken}/messages/{messageId}

// Delete message
DELETE https://discord.com/api/webhooks/{webhookId}/{webhookToken}/messages/{messageId}
```

Zero bot tokena. Zero `Authorization` headerów. Webhook URL zawiera token.

#### 4.2 `src/rate-limiter.ts`

```ts
class WebhookRateLimiter {
  // Parse X-RateLimit-* headerów z odpowiedzi Discord
  recordResponse(webhookId: string, headers: Headers): void

  // Track 401/403/429 dla Cloudflare IP protection
  recordError(statusCode: number): void

  // Czy webhook ma dostępny budżet
  canUse(webhookId: string): boolean

  // Czy globalny error counter jest bezpieczny (< 8000/10min)
  // SLIDING WINDOW — nie fixed window!
  isGlobalSafe(): boolean

  // Wybierz najlepszy webhook (round-robin + rate-limit-aware)
  getBestWebhook(webhookIds: string[]): string | null

  // Czekaj aż jakikolwiek webhook będzie dostępny
  waitForAvailable(webhookIds: string[]): Promise<string>
}
```

**KRYTYCZNE**: `isGlobalSafe()` musi używać SLIDING WINDOW. Przy fixed window: 7999 błędów z ostatniej sekundy starego okna + nowe błędy w nowym oknie = IP ban. Sliding window to eliminuje.

Default: 120 req/min jako starting point, dynamicznie dostosowywany z `X-RateLimit-*` headers.

#### 4.3 `src/webhooks.ts`

Parsowanie webhooków z env (`WEBHOOKS=url1,url2,url3`). Extract webhook_id i token z URL. Round-robin + rate-limit-aware selection via `WebhookRateLimiter`.

#### 4.4 `src/uploader.ts`

```ts
async function uploadChunk(
  webhookUrl: string,
  data: ArrayBuffer,    // [IV|ciphertext] — already encrypted
  filename: string,
  rateLimiter: WebhookRateLimiter
): Promise<{messageId: string, channelId: string, attachmentUrl: string}>
```

Raw `fetch` + `FormData` (multipart). Retry: 429 → exponential backoff z `Retry-After` header. 5xx → max 3 retries.

#### 4.5 `src/downloader.ts`

```ts
// Pobierz świeży CDN URL via GET message
async function getChunkUrl(
  webhookId: string,
  webhookToken: string,
  messageId: string,
  rateLimiter: WebhookRateLimiter
): Promise<string>

// Stream chunk z CDN
async function streamChunk(cdnUrl: string): Promise<ReadableStream<Uint8Array>>
```

#### 4.6 `src/deleter.ts`

```ts
async function deleteChunk(
  webhookId: string,
  webhookToken: string,
  messageId: string,
  rateLimiter: WebhookRateLimiter
): Promise<void>
```

---

### Faza 5: Backend API (`apps/api`)

#### 5.1 `src/index.ts` — Hybrid server

```ts
Bun.serve({
  routes: {
    "/graphql":                            graphqlHandler,   // GraphQL Yoga
    "POST /api/upload/:fileId/chunk/:index":   uploadHandler,
    "GET /api/download/:fileId/chunk/:index":  downloadHandler,
    "GET /api/share/:token":                   sharePageHandler,  // HTML + OG tags
    "GET /api/share/:token/info":              shareInfoHandler,  // JSON
    "POST /api/share/:token/verify-password":  shareVerifyHandler,
    "GET /api/share/:token/chunk/:index":       shareChunkHandler, // stream bez auth
    "GET /api/thumbnail/:fileId":              thumbnailHandler,
  }
})
```

#### 5.2 `src/router.ts`

Prosty pattern-matching router. Bez frameworka, ~10 routes.

#### 5.3 `src/schema.ts` — GraphQL

**Query**: `me`, `files(folderId)`, `folders(parentId)`, `file(fileId)`, `shareLinks(fileId)`, `storageUsage`

**Mutation**: `register`, `login`, `changePassword`, `initUpload`, `finalizeUpload`, `deleteFile`, `moveFile`, `renameFile`, `createFolder`, `deleteFolder`, `renameFolder`, `createShareLink`, `deleteShareLink`, `updateShareLink`

`changePassword` przyjmuje `reWrappedFEKs` — klient re-wrapuje wszystkie FEK nowym master key i wysyła batch update.

#### 5.4 HTTP Handlers (`src/handlers/`)

- **`upload.ts`** — odbiera binary body (chunk z prepended IV), forwaduje do Discord webhook, zapisuje `{messageId, channelId, webhookId, size}` w Chunk.
- **`download.ts`** — pobiera chunk metadane z DB → GET message do Discord → stream CDN response do klienta. Proxy, zero buforowania.
- **`share.ts`** — serwuje HTML z OG meta tags (dla crawlerów) + embed React app (dla userów). Plus JSON info endpoint i password verification.
- **`thumbnail.ts`** — proxy thumbnail z DB/Discord.

#### 5.5 Resolvers (`src/resolvers/`)

- **`auth.ts`** — register (Bun.password Argon2 + zapis crypto material), login, changePassword
- **`files.ts`** — initUpload, finalizeUpload (**z integrity check**: weryfikuje że ALL chunki 0..N-1 istnieją w DB z prawidłowym messageId, inaczej reject z listą brakujących), delete (+ Discord cleanup), move, rename
- **`folders.ts`** — CRUD z fileCount/subfolderCount
- **`sharing.ts`** — CRUD share linków

#### 5.6 Middleware (`src/middleware/`)

- **`auth.ts`** — JWT weryfikacja dla HTTP handlers
- **`rate-limit.ts`** — per-IP limit dla anonymous uploads

---

### Faza 6: Frontend (`apps/frontend`)

#### 6.1 Setup

Vite + React 19 + React Router 7 + TailwindCSS 4 + shadcn/ui. Deps: `@tanstack/react-query`, `graphql-request`, `zustand`, `hash-wasm`.

#### 6.2 Struktura

```
src/
├── lib/
│   ├── graphql.ts         GraphQL client
│   ├── api.ts             HTTP API client (upload/download)
│   ├── crypto.ts          Orchestrator (wraps @discordrive/processing)
│   ├── upload.ts          Upload pipeline
│   └── download.ts        Download pipeline (streaming)
├── stores/
│   ├── auth.ts            User, token, masterKey (IN-MEMORY ONLY)
│   ├── files.ts           File list, current folder
│   └── upload.ts          Upload queue, progress
├── pages/
│   ├── Login.tsx
│   ├── Register.tsx
│   ├── Dashboard.tsx      File browser
│   ├── SharedFile.tsx     /share/:token#key=...
│   └── Settings.tsx       Zmiana hasła, usage
├── components/
│   ├── files/             FileTable, FileActions, UploadDropzone, UploadProgress, FolderBreadcrumb
│   ├── share/             ShareDialog, ShareLinkList, PasswordPrompt
│   └── layout/            Sidebar, Header, MainLayout
```

#### 6.3 `src/lib/crypto.ts` — Orchestrator

```ts
registerCrypto(password) → {kekSalt, wrapIv, encryptedMasterKey, masterKey}
loginCrypto(password, kekSalt, wrapIv, encryptedMasterKey) → masterKey
prepareFileUpload(masterKey) → {fek, encryptedFEK, fekIv}
prepareShareLink(fek) → {shareKey, wrappedFEK, wrapIv}
unwrapFEK(masterKey, encryptedFEK, fekIv) → CryptoKey
unwrapSharedFEK(shareKeyBase64, wrappedFEK, wrapIv) → CryptoKey
unwrapSharedFEKWithPassword(password, salt, wrappedFEK, wrapIv) → CryptoKey
```

#### 6.4 Upload pipeline

1. Generate FEK + wrap z master key
2. Hash pliku (hash-wasm SHA-256 streaming)
3. `initUpload` mutation → fileId
4. Chunk file → encrypt chunk → POST `/api/upload/:fileId/chunk/:index` (równolegle, concurrency 3)
5. `finalizeUpload` mutation (server robi integrity check)
6. Progress tracking via Zustand store

**WAŻNE**: NIE generować wszystkich chunków do pamięci przed uploadem. Pipeline: generuj chunk → hashuj → encrypt → upload → zwolnij → następny. Inaczej OOM przy dużych plikach (640 chunków × 10 MB = 6.4 GB w pamięci).

#### 6.5 Download pipeline (streaming)

1. Unwrap FEK
2. ReadableStream z lookahead buffer 2-3 chunki:
   - Pobierz chunk metadane z API
   - Sekwencyjnie fetch chunki z backendu (backend: GET message → CDN URL → stream)
   - TransformStream: `[IV|ciphertext]` → odetnij 12B IV → decrypt → plaintext
3. Output:
   - **Primary**: Service Worker intercept (StreamSaver.js pattern) — uniwersalny z HTTPS
   - **Opcja B**: `window.showSaveFilePicker()` (File System Access API) — Chrome/Edge
   - **Fallback**: Blob + download link — tylko <500 MB
4. SHA-256 hash streaming weryfikacja na końcu

Pamięć: max ~30-60 MB in-flight niezależnie od rozmiaru pliku.

---

### Faza 7: Sharing

Opisana w sekcji 3.7 powyżej. Implementacja:
- GraphQL mutations: `createShareLink`, `deleteShareLink`, `updateShareLink`
- HTTP handlers: share page (HTML + OG), share info (JSON), verify password, share chunk stream
- Frontend: ShareDialog, ShareLinkList, PasswordPrompt, SharedFile page

---

### Faza 8: Embedy

OG meta tags w `GET /api/share/:token`:
```html
<meta property="og:title" content="{filename}">
<meta property="og:description" content="{size} | {type}">
<meta property="og:image" content="/api/thumbnail/{fileId}">
```

Crawlery nie wykonują JS — widzą OG tags. Userzy widzą React app.

Thumbnaily (opt-in): frontend generuje nieszyfrowany thumbnail PRZED szyfrowaniem. Upload jako osobny mały plik. `File.thumbnailUrl` w DB.

---

### Faza 9: Backend-Only Mode

- `APP_MODE=backend-only` → brak userów, brak auth, anonymous uploads z TTL
- Opcjonalny API key (env `API_KEY`) zamiast JWT
- Register/login/changePassword → error
- Foldery niedostępne
- Sharing nadal działa (anonymous share links)

---

## 5. Kolejność implementacji

```
1. packages/types          (0 deps)
2. packages/config         (0 deps)
3. packages/database       (config)
4. packages/processing     (config, hash-wasm)
5. packages/discord-client (types, config)
6. apps/api                (wszystkie packages)
7. apps/frontend           (types, config, processing)
8. Integracja upload/download E2E
9. Sharing system
10. Embedy/thumbnaily
11. Backend-only mode
```

Fazy 6 i 7 (api + frontend) mogą być robione równolegle.

---

## 6. Weryfikacja

1. **Unit**: `crypto.ts` — wrap/unwrap/encrypt/decrypt roundtrip. Sprawdź że `encryptChunk → decryptChunk` = identyczne dane.
2. **Unit**: `chunker.ts` — split + reassemble = identyczny plik (porównaj SHA-256).
3. **Integration**: Upload E2E — plik → chunki → Discord → DB → download → decrypt → porównaj hash.
4. **Integration**: Share flow — create share → open link → decrypt → verify content.
5. **Integration**: Password share — create z hasłem → verify password → decrypt.
6. **Integration**: Revoke — delete share → verify 404.
7. **Manual**: OG meta tags — wklej share link na Discordzie, sprawdź embed.
8. **Manual**: Backend-only mode — ustaw `APP_MODE=backend-only`, sprawdź że auth endpointy odmawiają.

---

## 7. Ryzyka i mitygacje

| Ryzyko | Mitygacja |
|--------|-----------|
| Argon2 WASM nie ładuje się w przeglądarce | Fallback: PBKDF2 z ostrzeżeniem |
| OOM przy dużych plikach (upload) | Pipeline streaming: generuj → encrypt → upload → zwolnij. Max ~60 MB in-flight (concurrency 3 × 10 MB × 2) |
| OOM przy dużych plikach (download) | Streaming via Service Worker / File System Access API. Max ~30-60 MB in-flight. Blob fallback tylko <500 MB |
| Discord rate limits | Default 120 req/min, dynamiczne z `X-RateLimit-*`. Round-robin webhooków na osobnych kanałach |
| Cloudflare IP ban (10k/10min) | Globalny error counter (sliding window!), stop przy 8000 |
| Discord chunk size limit | Default 10 MB. Dynamiczne wykrywanie (413 → fallback). 25 MB wymaga Nitro/boost |
| CDN URL expiry (~24h) | GET message → świeży URL on-demand. Zero CDN URLi w DB |
| Zmiana hasła | Re-wrap wszystkich FEK client-side (pure crypto, szybkie) → batch update do DB |
| Przerwany upload | Orphaned chunks na Discord. Cron job czyści niesfinalizowane pliki po N godzinach |
| Streaming download w Safari/Firefox | Service Worker jako primary (nie File System Access API). Pattern: StreamSaver.js |
| Discord zmieni politykę / zbanuje | Traktuj Discord storage jako expendable. Backup metadanych w PostgreSQL pozwala re-upload na inny backend |

---

## 8. Przyszłe optymalizacje (NIE w MVP)

- **Redis cache na CDN URLe** — klucz `cdn:{messageId}`, TTL 20h. Sensowny dopiero gdy share linki generują powtarzalny ruch.
- **Resume uploadu** — przy 400 MB plikach niepotrzebny (re-upload = kilka minut). Rozważyć jeśli użycie się rozszerzy na pliki >10 GB.
- **Multiple IP / proxy** — dla skalowania CDN downloads poza limit Cloudflare jednego IP. Datacenter IPs mają niższy trust score niż residential.
- **Rate limiter state w Redis** — potrzebny dopiero przy multiple instancjach API.
