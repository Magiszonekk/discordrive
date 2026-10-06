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
  Brakuje: retencji (7 dziennych + 4 tygodniowe) i harmonogramu w kliencie.
- **CLI** `ddn init | webhook add|ls|rm | put | get | ls`. Katalog stanu 0700, pliki 0600;
  `server/` to dokładnie to, co trzymałby serwer (zaszyfrowany log i sejf), do czasu
  serwera HTTP (krok 6 planu) obsługiwane w procesie.

## Testy

```
npm test -w @ddv4/metadata-client          # w pamięci (MemoryTransport), bez sieci
DDN_LIVE=1 DDN_LIVE_WEBHOOK_FILE=~/.config/discordrive-next/webhooks/<nazwa>.url \
  npx vitest run test/live.test.ts         # na żywo, TYLKO webhook z serwera a test Discord server; sprząta po sobie
node scripts/webhook-ratelimit.mjs run ... # pomiar limitów (koncept §7)
```

CLI: `DDN_STATE=<katalog> npx tsx src/cli.ts init`, potem `webhook add <plik.url>`, `put <plik>`.
