# @ddv4/metadata-client

Etap 2 discordrive-next: klient trybu metadata only (koncept §3) na rdzeniu `@ddv4/sync-core`.
Plan i kolejność: [PLAN-etap2.md](PLAN-etap2.md).

## Co działa (przekrój 1)

- **Upload**: plik → fragmenty po ~10 MiB (format discordrive: losowy klucz pliku, klucz treści
  HKDF `ddv4-file-content-v1`, fragment `iv(12) || AES-256-GCM`) → POST na webhooki użytkownika
  → zaszyfrowany manifest też na webhook → w logu `upload_begin`, potem grupa
  `[upload_commit, create]` z `leaseGuard` i dzierżawą (reguła 8). Nazwa w NFC (Q5),
  `plaintextSha256` liczony w trakcie (Q7).
- **Download**: `manifestRef` → manifest (świeży link CDN przez `GET` wiadomości webhookiem)
  → fragmenty, sprawdzenie `ciphertextHash` każdego fragmentu, rozmiaru i SHA-256 całości.
- **Limiter** (`ChannelPacer`): jeden kubełek na **kanał** (limit Discorda jest per kanał, ~30
  wiadomości/min; pomiar w koncepcie §7), start 30/min, po 429 `shared` blokada na
  `retry_after` i spadek tempa ×0,8, powolny powrót do 36/min.
- **Klucz konta** (`account-key.ts`): losowe 256 bitów, podklucze HKDF `ddn-vault-v1`,
  `ddn-op-v1`, `ddn-snapshot-v1`; AES-256-GCM z AAD wiążącym szyfrogram z kontekstem.
- **Sejf webhooków** (§3.2, `vault.ts`): jeden zaszyfrowany blob na konto, serwer trzyma
  tylko `{revision, blob}`. Zapis compare-and-swap (dwa urządzenia naraz: oba wpisy
  zostają), ochrona przed cofnięciem rewizji przez serwer, AAD = konto + rewizja.
  Dodanie webhooka sprawdza URL przez `GET` webhooka (bez wysyłania wiadomości) i zapisuje
  ID kanału. Kreator (decyzja #12): wymagany 1 kanał, zachęta do 3–4.
- **Zaszyfrowany log operacji** (§3.3, `op-crypto.ts`): serwer widzi tylko `opId`,
  `rulesVersion`, `baseSeq`, `leaseGuard` i rozmiar `payload`; reszta (urządzenie, czasy,
  operacja z nazwami i kluczami plików) jest zaszyfrowana, a AAD wiąże ją z kontem i
  jawnymi polami. Wpis, którego nie da się odszyfrować, każda replika zamienia w ten sam
  `invalid_op`. Dzierżawy sprawdzane względem urządzenia sesji, nie zaszyfrowanej koperty.
- **Drzewo na dysku** (§4.1, `node/sqlite-store.ts`, wbudowane `node:sqlite`): unikalność
  nazw wymuszana indeksem częściowym, stronicowanie keyset po `(name_key, id)`. Ten sam stan
  co `MemoryIndexStore` na losowych logach z symulacji etapu 1 (40 w `npm test`,
  `SQLITE_RUNS=500` sprawdzone). CLI trzyma `index.db` i przy starcie pobiera tylko ogon logu.
- **Snapshoty i wiadomość wskaźnikowa** (§6.2, `snapshots.ts`): segmenty (zaszyfrowane wpisy
  logu, łańcuch od seq 1), baza (drzewo, gzip, dzielone na części), jedna wiadomość
  wskaźnikowa edytowana `PATCH`-em, która nigdy się nie cofa. Polityka `decideSnapshot`:
  1 min ciszy / max 5 min, baza przy 20 % lub 7 dniach, tylko na łączu nielimitowanym.
  `restoreFromDiscord` + zestaw ratunkowy (`ddn-kit1:`) odtwarzają drzewo bez serwera.
  Retencja (`selectRetained`, `pruneSnapshots`): bieżąca baza + najnowsza z każdego z 7
  ostatnich dni + najstarsza z każdego z 4 tygodni przed nimi (~30 dni), segmenty od
  najstarszej trzymanej bazy; najpierw zapis wskaźnika, potem kasowanie wiadomości.
  Przywracanie na dowolny moment w tym oknie (`restoreFromDiscord(..., atSeq)`).
  `deletableUploadsWithRetention`: fragmenty kasowane dopiero, gdy żadna trzymana baza ich nie
  wskazuje. `SnapshotScheduler.tick()` (tylko urządzenie główne; telefon tylko segmenty).
- **Serwer** (§3.4, `node/server.ts`, `node:http` + `node:sqlite`, tylko 127.0.0.1): arbiter
  zaszyfrowanego logu (Sequencer per konto, duplikaty, wersja reguł, dzierżawy względem
  urządzenia z sesji), sejf (CAS), urządzenia (dodanie, odwołanie), long-poll
  `GET /v1/log?wait=` oraz WebSocket `/v1/notify` (bez zależności, RFC 6455; wysyła tylko
  „head = N”, dane idą zwykłym API; wejście jednorazowym biletem z `POST /v1/notify-ticket`,
  więc token sesji nie trafia do URL-a). `HttpApi.subscribe` łączy się ponownie z backoffem. Przyjmuje tylko jawne pola z §3.3 (inne pola koperty = 400).
  Klient: `HttpApi` (fetch, Node + przeglądarka).
- **Logowanie urządzeń** (decyzja #13, `device-key.ts`, `node/auth.ts`): para Ed25519 na
  urządzenie, serwer zna tylko klucze publiczne. Logowanie = podpis jednorazowego wyzwania
  (2 min, kasowane przy pierwszym użyciu, związane z instancją serwera) → token sesji (1 h,
  w bazie tylko SHA-256). Parowanie dopisuje klucz nowego urządzenia podpisem zalogowanego
  urządzenia; zestaw ratunkowy rejestruje urządzenie kluczem ratunkowym Ed25519 wyprowadzonym
  z klucza konta (HKDF `ddn-rescue-ed25519-v1`); odwołanie (podpisane) kasuje klucz i sesje.
  W przeglądarce klucz prywatny jest nieeksportowalny.
- **Polityki klienta** (`policies.ts`, README sync-core „etap 2”): Q4 `decideTrashCleanup`
  (główne urządzenie; inne po 7 dniach bez czyszczenia; tylko zsynchronizowane, nie na
  łączu taryfowym; grupa purge, Q9), Q10 licznik `invalid_op` per urządzenie z jednym
  komunikatem po 5, Q5 ostrzeżenie o cudzej nazwie nie-NFC. `MetadataClient.observer`
  zasilany przy każdym `pull`.
- **Parowanie urządzeń** (§3.8, `pairing.ts`): kod/QR `ddn-pair1:` z efemerycznym kluczem
  ECDH P-256 i kluczem publicznym Ed25519 nowego urządzenia; stare urządzenie rejestruje ten
  klucz swoim podpisem i szyfruje do nowego urządzenia klucz konta, serwer przekazuje jedną nieczytelną wiadomość (skrzynka
  jednorazowa, 10 min). Obie strony pokazują 6-cyfrowy kod (SAS): podmiana klucza przez
  serwer daje różne kody, a klucza konta serwer nie zobaczy w żadnym wariancie.
- **CLI** `ddn init [--server URL] | rescue | pair-offer | pair-accept | devices [revoke] | kit |
  webhook add|ls|rm | put | get | ls`. Z `--server` (tylko 127.0.0.1 w etapie 2) działa przez
  HTTP z kluczem Ed25519 urządzenia w `device.json` (0600); bez — tryb lokalny (testy). Katalog stanu 0700, pliki 0600;
  `server/` to dokładnie to, co trzymałby serwer (zaszyfrowany log i sejf), do czasu
  serwera HTTP (krok 6 planu) obsługiwane w procesie.

- **Przeglądarka** (logika, bez UI): `src/index.ts` buduje się na `platform: browser`
  (części Node są w `src/node/`), a `npm run check:browser` w headless Chromium robi:
  konto przez HTTP (CORS tylko dla wskazanego originu), sejf, upload/download z kontrolą
  SHA-256, snapshot + odtworzenie i sparowanie urządzenia Node przez kartę (zgodny SAS).
  Drzewo w przeglądarce (`browser/opfs-store.ts`): SQLite-WASM na OPFS (SAH pool, w
  dedykowanym workerze), ten sam `SqlIndexStore` co w Node (`sql-store.ts`). `opfs-check.ts`:
  30 losowych logów etapu 1 w Chromium = ten sam stan co w Node, baza przetrwa przeładowanie.
  Pomiar: transakcja na wpis 14,3 ms/wpis, transakcja na partię 0,5 ms/wpis, więc
  `MetadataClient.pull` stosuje partię w jednej transakcji.
  Główna karta (`browser/leader.ts`, Web Locks): dokładnie jedna karta profilu jest liderem,
  po jej zamknięciu przejmuje kolejna (`leader-check.ts`).
  Brakuje: service worker do streamingu, UI (profil `frontend`).

## Testy

```
npm test -w @ddv4/metadata-client          # w pamięci (MemoryTransport), bez sieci
DDN_LIVE=1 DDN_LIVE_WEBHOOK_FILE=~/.config/discordrive-next/webhooks/<nazwa>.url \
  npx vitest run test/live.test.ts         # na żywo, TYLKO webhook z serwera a test Discord server; sprząta po sobie
node scripts/webhook-ratelimit.mjs run ... # pomiar limitów (koncept §7)
CHROMIUM_PATH=... npm run check:browser    # klient w headless Chromium + serwer HTTP na 127.0.0.1
npm run server                             # serwer: DDN_DB, DDN_PORT; tylko 127.0.0.1
```

CLI: `DDN_STATE=<katalog> npx tsx src/cli.ts init`, potem `webhook add <plik.url>`, `put <plik>`.
