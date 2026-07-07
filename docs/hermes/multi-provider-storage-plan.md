# DiscordDrive — Multi-Provider Storage + Replication Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.
> Verification gate po każdej fazie: `npm run typecheck` && `npm test` && `npm run test:integration`.

**Goal:** Discord przestaje być jedynym providerem blob storage. Docelowo: (1) Telegram jako drugi provider, (2) striping chunków między providerami dla przepustowości, (3) asynchroniczna replikacja na **wydzielone pule senderów** (osobne webhooki/boty/konta — w tym osobny serwer Discord lub osobny bot Telegrama wyłącznie na kopie, odporność na utratę głównego konta).

**Architecture:** Wszystkie warianty (jeden provider / striping / mirror / N kopii) to polityki rozmieszczenia nad jednym mechanizmem: logiczny blob + tabela placementów + pule senderów z rolami. Zero zmian w modelu krypto i w klientach — replika kopiuje wyłącznie ciphertext (zero-knowledge zachowane), rozmiar chunka pozostaje `10 MiB − 28 B` (mieści się w limicie 10 MiB Discorda i pod capem 20 MB pobierania vanilla Telegram Bot API).

**Tech Stack:** TypeScript monorepo, Hono, GraphQL Yoga, Prisma/PostgreSQL, Vitest, Discord webhook/bot API, Telegram Bot API.

---

## Ustalenia wejściowe (stan kodu na 2026-07-06)

- `BlobTransport` (`packages/database/prisma/schema.prisma`) ma **dokładnie jeden** wiersz per `blobId` — placement jest zlepiony z logicznym blobem (kolumny `storageKind`, `storagePath`, `discordMessageId`, `discordChannelId`, `webhookId`, `healthStatus`).
- Odczyt (`apps/api/src/handlers/blob.ts:69`) już dziś dispatchuje **per blob** na `storageKind` — wybór providera przy uploadzie jest globalny (env, `getBlobStorageKind()`).
- Warstwa senderów Discorda (`apps/api/src/storage/discord-blobs.ts` + `@ddv4/discord-client`) ma: tiery (direct webhooks → boty → relay), wspólny `WebhookRateLimiter` z per-sender ID, per-sender concurrency cap (`MAX_CONCURRENT_PER_SENDER`), group-aware round-robin (`SERVERS_COUNT`, `USER_GROUPS_COUNT`).
- Config senderów: `WEBHOOK_1..50`, `BOT_n` + `BOT_n_CHANNEL` (`packages/config/src/server.ts`), `RELAY_WEBHOOK_IDS`, `RELAY_BASE_URL`, `BOT_UPLOADS_ENABLED`.
- Konwencja sender ID w kolumnie `webhookId`: numeryczne ID webhooka lub `"BOT_n"` — rozszerzalna o kolejne prefiksy.
- Klienci (frontend SW, mobile) rozmawiają wyłącznie z blob API — provider jest dla nich niewidoczny. Zmiany client-side: brak (poza opcjonalną telemetrią w HealthCheck).

### Kluczowa własność projektowa

Pule REPLICA mają **fizycznie osobne sendery** (osobne kanały/serwery/konta), więc mają osobne budżety rate limitów u providerów. Replikacja NIE konkuruje z ruchem primary o limity — może działać ciągle, z niską konkurencją, bez okna "kopiuję tylko gdy bezczynne". Jedyne współdzielone zasoby to CPU/łącze VPS-a — ograniczane stałą konkurencją workera, nie sprzężeniem z limiterem primary.

---

## Model danych — docelowy

```prisma
model BlobTransport {              // logiczny blob (bez zmian semantyki dla klientów)
  blobId              String   @id
  ownerUserId         String
  ciphertextSizeBytes BigInt
  ciphertextHash      String?
  createdAt           DateTime @default(now())
  placements          BlobPlacement[]
  // usunięte: storageKind, storagePath, discordMessageId, discordChannelId,
  //           webhookId, healthStatus, healthCheckedAt → przeniesione do BlobPlacement
}

model BlobPlacement {              // jedna fizyczna kopia bloba u providera
  id            String          @id @default(cuid())
  blobId        String
  provider      BlobStorageKind // LOCAL | DISCORD | TELEGRAM
  poolRole      PoolRole        // PRIMARY | REPLICA
  status        PlacementStatus // PENDING | ACTIVE | MISSING | MODIFIED | DELETING
  storagePath   String          // "discord://attachments/<id>" | "telegram://file/<file_id>" | ścieżka lokalna
  messageId     String?         // discord message id / telegram message_id (do delete)
  locationId    String?         // discord channel id / telegram chat_id
  senderId      String?         // "123456789" | "BOT_n" | "TG_BOT_n" — klucz do limitera i configu
  attemptCount  Int             @default(0)
  lastError     String?
  createdAt     DateTime        @default(now())
  activatedAt   DateTime?       // kiedy kopia stała się ACTIVE (metryka replication lag)
  healthCheckedAt DateTime?

  blob BlobTransport @relation(fields: [blobId], references: [blobId], onDelete: Cascade)

  @@index([blobId, poolRole, status])
  @@index([status, createdAt])    // kolejka workera: PENDING/DELETING wg wieku
  @@unique([blobId, provider, poolRole]) // max 1 kopia per (blob, provider, rola) w v1
}

enum PoolRole { PRIMARY REPLICA }
enum PlacementStatus { PENDING ACTIVE MISSING MODIFIED DELETING }
```

Semantyka statusów:
- `PENDING` — placement zaplanowany, kopia jeszcze nie istnieje u providera (kolejka replikacji),
- `ACTIVE` — kopia zapisana i uznawana za zdrową,
- `MISSING` / `MODIFIED` — wynik health-checku lub nieudanego odczytu (dzisiejszy `BlobHealthStatus`),
- `DELETING` — plik/blob skasowany, worker ma usunąć kopię u providera i skasować wiersz.

Mapowanie Telegram → kolumny: `storagePath = telegram://file/<file_id>` (stabilny uchwyt pobierania przez `getFile`), `messageId = message_id`, `locationId = chat_id` (potrzebne do `deleteMessage`), `senderId = TG_BOT_n`.

---

## Konfiguracja — pule senderów z rolami

Zasada: **istniejące zmienne env zachowują znaczenie** (primary Discord), nowe pule dostają prefiksy. Parsowanie w `packages/config/src/server.ts`.

```
# PRIMARY Discord (bez zmian — backcompat)
WEBHOOK_1..50, BOT_n + BOT_n_CHANNEL, RELAY_*, SERVERS_COUNT, USER_GROUPS_COUNT

# PRIMARY Telegram
TG_BOT_1..n              # token bota
TG_BOT_1_CHAT            # chat_id prywatnego kanału/grupy bota

# REPLICA Discord — osobny serwer/konto, wyłącznie kopie
REPLICA_WEBHOOK_1..50
REPLICA_BOT_n + REPLICA_BOT_n_CHANNEL

# REPLICA Telegram
REPLICA_TG_BOT_n + REPLICA_TG_BOT_n_CHAT

# Polityka rozmieszczenia (instancja; per-user poza scope v1)
STORAGE_PRIMARY_PROVIDERS=DISCORD,TELEGRAM   # striping po tej liście; 1 element = single provider
STORAGE_REPLICA_PROVIDERS=DISCORD            # pusta / brak = replikacja wyłączona
REPLICATION_CONCURRENCY=2                    # równoległość workera
```

Sender ID w limiterze i w `BlobPlacement.senderId`: `REPLICA_`-prefiksowane ID nigdy nie trafiają do puli primary i odwrotnie — separacja jest twarda na poziomie selekcji, nie tylko konwencji.

`getBlobStorageKind()` / `BLOB_STORAGE_KIND` zostaje jako fallback dla instancji bez `STORAGE_PRIMARY_PROVIDERS` (dev z `LOCAL`).

---

## Interfejs providera

Nowy plik `apps/api/src/storage/provider.ts` (albo docelowo `packages/storage-providers`, decyzja w Task 1.1):

```ts
interface BlobProviderPool {
  readonly kind: BlobStorageKind;
  readonly role: PoolRole;
  hasSenders(): boolean;
  put(ownerUserId: string, blobId: string, bytes: Uint8Array, telemetry?: BlobTelemetry): Promise<PlacementWriteResult>;
  get(placement: PlacementRef): Promise<Uint8Array>;
  stat(placement: PlacementRef): Promise<{ exists: boolean; size: number; hashOk?: boolean }>;
  delete(placement: PlacementRef): Promise<void>;
  limiterSnapshot(): { remaining: number; inFlight: number }; // do wyboru puli przy stripingu i do HealthCheck
}
```

- `discord-blobs.ts` i `local-blobs.ts` już de facto to implementują — Task 1.x tylko domyka je w ten interfejs (adapter przyjmuje listę senderów, więc PRIMARY i REPLICA to **dwie instancje tej samej klasy** z różnymi listami; osobne kursory round-robin i osobne budżety w limiterze via sender ID).
- `delete()` dla Discorda: `DELETE /webhooks/:id/:token/messages/:messageId` (webhook) lub bot `DELETE /channels/:channelId/messages/:messageId`. Dziś kod nie kasuje wiadomości Discorda — Task 1.4 weryfikuje, co robi trash auto-purge, i domyka lukę.

---

## Provider Telegram — fakty i ograniczenia

- Vanilla Bot API (`api.telegram.org`): upload `sendDocument` do **50 MB**, pobieranie `getFile` do **20 MB** → chunk 10 MiB przechodzi w obie strony. Self-hostowany `telegram-bot-api` (limity 2 GB) — poza scope v1, ale interfejs providera tego nie blokuje.
- Pobieranie: `getFile(file_id)` → `file_path` → `GET https://api.telegram.org/file/bot<token>/<file_path>`. `file_path` jest ważny ≥1h — **nie zapisujemy go**, pobieramy świeży per download (analogia do odświeżania CDN URL Discorda).
- `file_id` jest stabilny i powiązany z botem, który wysłał plik → pobieranie musi iść przez tego samego bota (`senderId` w placement to gwarantuje).
- Rate limity: ~30 msg/s globalnie per bot, ale bezpiecznie ~1 msg/s per chat (20/min w grupach). Architektura: **jeden bot = jeden prywatny kanał** (jak webhook = kanał w Discordzie); skalowanie przepustowości = więcej botów. Flood → HTTP 429 z `retry_after` w body — mapuje się wprost na istniejący `WebhookRateLimiter` (per sender ID `TG_BOT_n`).
- ToS: ta sama szara strefa co Discord — to jest argument ZA mirroringiem między providerami, nie przeciw Telegramowi.

Nowy pakiet `packages/telegram-client` (symetryczny do `discord-client`): `uploadDocument`, `getFileStream`, `deleteMessage`, typy `TgBotInfo`, reużycie `WebhookRateLimiter` (rename/alias na `SenderRateLimiter` — mechanika identyczna).

---

## Przepływ danych — docelowy

### Upload chunka (`PUT /api/blob/:blobId`)
1. auth, hash — bez zmian,
2. wybór puli PRIMARY: spośród `STORAGE_PRIMARY_PROVIDERS` bierz pulę z najlepszym `limiterSnapshot()` (striping steruje się dostępnością, nie sztywnym round-robinem — provider zapchany na 429 naturalnie oddaje ruch drugiemu),
3. `pool.put(...)` → insert `BlobPlacement` (PRIMARY, ACTIVE),
4. jeśli replikacja włączona: insert `BlobPlacement` (REPLICA, PENDING) w tej samej transakcji **+ opportunistic write-through**: fire-and-forget task, który — mając ciphertext jeszcze w pamięci — od razu robi `replicaPool.put(...)` i flipuje PENDING→ACTIVE. Crash/wysycenie repliki = nic straconego: wiersz PENDING zostaje i podnosi go worker (durable fallback bez ponownego pobierania z primary w happy path),
5. response do klienta wychodzi po kroku 3 — replikacja nigdy nie blokuje uploadu.

> Uwaga na styk z TASK-011 (batch metadata commit): jeśli batch commit wejdzie pierwszy, kroki 3–4 przenoszą się do końcowego commitu — placementy REPLICA/PENDING wstawiane są batchowo razem z metadata. Write-through wtedy działa na podstawie in-memory listy z sesji uploadu.

### Download chunka
1. wybierz placement: ACTIVE PRIMARY > ACTIVE REPLICA (failover),
2. błąd/brak u providera → oznacz placement MISSING, spróbuj następnego, **enqueue self-heal**: nowy placement PENDING w puli, w której kopia zginęła (odbudowa z ocalałej kopii przez workera),
3. sukces → strumień do klienta (bez zmian dla SW).

### Delete (trash purge / deleteEnrichments / hard delete)
1. wszystkie placementy bloba → `DELETING` (w tym PENDING — inaczej worker wskrzesi skasowany blob),
2. worker kasuje kopie u providerów (`delete()`), potem wiersze placementów i `BlobTransport`,
3. placement PENDING bez istniejącej kopii = po prostu usuń wiersz.

### Worker replikacji (in-process, `apps/api`)
Pętla co N sekund: pobierz batch `PENDING`/`DELETING` (wg `createdAt`, `attemptCount < MAX`), dla PENDING: ciphertext z dowolnego ACTIVE placementu → `put` do docelowej puli → ACTIVE + `activatedAt`. Backoff wykładniczy per placement (`attemptCount`, `lastError`). Konkurencja: `REPLICATION_CONCURRENCY`. Metryki do HealthCheck: głębokość kolejki, max wiek PENDING (replication lag), błędy per pula.

---

## Fazy

### Phase 0 — Ekstrakcja interfejsu providera (bez zmiany zachowania)

- **Task 0.1:** Zdefiniować `BlobProviderPool` + `PlacementRef`/`PlacementWriteResult` w `apps/api/src/storage/provider.ts`. Owinąć `local-blobs.ts` i `discord-blobs.ts` w implementacje. `blob.ts` przechodzi na interfejs. Kolumny DB bez zmian (adapter mapuje na stare pola).
- **Task 0.2:** Testy jednostkowe interfejsu na LOCAL + istniejące integration testy zielone.
- **Gate:** typecheck + testy zielone, zero zmian w schemacie i API.

### Phase 1 — Schemat placementów + migracja

- **Task 1.1:** Migracja Prisma: `BlobPlacement` + enumy; backfill — każdy istniejący `BlobTransport` dostaje 1 placement (PRIMARY, ACTIVE, provider = dotychczasowy `storageKind`). Stare kolumny placementowe usunięte z `BlobTransport` w tej samej migracji (prod: backup DB przed `db:push`/migrate).
- **Task 1.2:** Read path (`blob.ts`, `files.ts` commitManifest, sharing download) na placementy. Selekcja: ACTIVE PRIMARY first.
- **Task 1.3:** Write path: insert placementu zamiast kolumn inline (nadal 1 placement, PRIMARY).
- **Task 1.4:** Audyt delete: co dziś dzieje się z wiadomościami Discorda przy trash purge? Dodać `delete()` do providerów i propagację na placementy (statusy DELETING obsługiwane synchronicznie do czasu Phase 4 — brak workera).
- **Gate:** pełny lifecycle e2e (`test:e2e:download`) + integration na LOCAL i DISCORD.

### Phase 2 — Provider Telegram

- **Task 2.1:** `packages/telegram-client`: `uploadDocument` (multipart, 429/`retry_after` → limiter), `getFileStream` (`getFile` + fetch `file_path`), `deleteMessage`. Testy jednostkowe z mockowanym fetch.
- **Task 2.2:** Config: `TG_BOT_n`/`TG_BOT_n_CHAT` w `server.ts`; `TELEGRAM` w `BlobStorageKind`; `telegram-blobs.ts` implementuje `BlobProviderPool`.
- **Task 2.3:** Smoke test na realnym bocie (upload → download → hash check → delete) — skrypt w `scripts/`, odpalany ręcznie (sekrety poza CI).
- **Gate:** upload/download pliku end-to-end z `STORAGE_PRIMARY_PROVIDERS=TELEGRAM` na dev instancji.

### Phase 3 — Striping między providerami

- **Task 3.1:** Selekcja puli primary per chunk wg `limiterSnapshot()` (najwięcej wolnego budżetu wygrywa; tie-break round-robin). `STORAGE_PRIMARY_PROVIDERS` z listą.
- **Task 3.2:** Benchmark (`scripts/benchmark-e2e.ts`) DISCORD vs TELEGRAM vs oba — potwierdzić addytywność przepustowości.
- **Gate:** plik z chunkami rozłożonymi na oba providery pobiera się i deszyfruje poprawnie (integration test z dwoma mock providerami + ręczny e2e).

### Phase 4 — Replikacja na wydzielone pule

- **Task 4.1:** Config puli REPLICA (`REPLICA_*` env) + twarda separacja sender ID od puli primary.
- **Task 4.2:** Worker replikacji (pętla in-process w `apps/api/src/index.ts`, start za flagą `STORAGE_REPLICA_PROVIDERS`): PENDING→ACTIVE, DELETING→usunięcie, backoff, `REPLICATION_CONCURRENCY`.
- **Task 4.3:** Opportunistic write-through przy uploadzie (ciphertext z pamięci, fallback na workera).
- **Task 4.4:** Failover odczytu + self-heal (MISSING → czytaj z repliki → enqueue odbudowy).
- **Task 4.5:** HealthCheck: głębokość kolejki, replication lag, stan pul (per provider × rola), licznik failoverów.
- **Task 4.6:** Testy: integration z dwoma mock pulami — (a) replikacja dogania po awarii write-through, (b) delete propaguje do PENDING, (c) failover czyta z repliki i enqueue'uje heal, (d) sender repliki nigdy nie obsługuje ruchu primary.
- **Gate:** scenariusz "spadł cały primary provider": pliki nadal czytelne z repliki; scenariusz "utrata głównego konta Discord": nowa instancja z samą pulą REPLICA (przepiętą jako PRIMARY w env) serwuje wszystkie zreplikowane pliki.

### Poza scope v1 (świadomie)

- Polityki per-user / per-folder (dziś: per instancja).
- Erasure coding / parity między providerami (mirror wystarcza; wracamy, jeśli koszt storage zacznie boleć — a nie zaczyna, bo storage jest darmowy).
- Self-hostowany `telegram-bot-api` (chunki 2 GB) i per-provider chunk size — wymaga zmian w manifeście i kliencie; osobny spec, jeśli kiedyś.
- Rebalans istniejących blobów między providerami (mechanizm self-heal + placementy już na to pozwalają; brakuje tylko komendy/skryptu — quality of life na później).

---

## Ryzyka i decyzje otwarte

| # | Ryzyko | Mitygacja |
|---|--------|-----------|
| 1 | Migracja `BlobTransport` na prodzie (rozbicie tabeli) | backup przed migracją; backfill w jednej transakcji; Phase 1 nie zmienia zachowania — łatwy rollback |
| 2 | Kolizja z TASK-011 (batch metadata commit) dotyka tych samych ścieżek `blob.ts` | ustalić kolejność wdrożeń przed startem Phase 1; plan zakłada adaptację (patrz uwaga w przepływie uploadu) |
| 3 | Telegram flood-ban bota przy sustained uploadzie | konserwatywny limiter (1 rps/chat na start), honorowanie `retry_after`, skalowanie liczbą botów; benchmark w Task 3.2 wyznacza bezpieczny pułap |
| 4 | Worker wskrzesza skasowane bloby | delete zawsze flipuje PENDING→DELETING w tej samej transakcji; test 4.6b pilnuje regresji |
| 5 | Rozjazd hash po replikacji (bit rot / MODIFIED) | `put()` repliki weryfikuje `ciphertextHash` po zapisie (Telegram nie zwraca hasha — worker robi read-back stat/getFile size + opcjonalny pełny hash check w health cyklu) |
| 6 | `file_path` Telegrama wygasa | nigdy nie persystowany; świeży `getFile` per download |

---

## Definition of Done

- [ ] Instancja z `STORAGE_PRIMARY_PROVIDERS=DISCORD,TELEGRAM` + `STORAGE_REPLICA_PROVIDERS=DISCORD` (osobny serwer) przechodzi pełny lifecycle: upload → striped placementy ACTIVE → replika dogania (lag widoczny w HealthCheck) → download z failoverem → delete propaguje wszędzie.
- [ ] Symulacja utraty głównego konta Discord (wyłączenie primary webhooków) nie powoduje utraty żadnego zreplikowanego pliku.
- [ ] Verification gate zielony: `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run test:e2e:download`.
- [ ] README: sekcja o providerach, pulach i politykach; `.env.example` zaktualizowany.
