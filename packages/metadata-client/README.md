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
- **CLI** `ddn put|get|ls` (jedno urządzenie, arbiter w procesie, log w `log.jsonl` 0600).

**Uwaga:** do kroku 3 planu (szyfrowanie operacji) `manifestRef` w logu zawiera klucz pliku
jawnie. Log zostaje lokalnie (0600) i nie może trafić na serwer, zanim operacje nie będą
szyfrowane.

## Testy

```
npm test -w @ddv4/metadata-client          # w pamięci (MemoryTransport), bez sieci
DDN_LIVE=1 DDN_LIVE_WEBHOOK_FILE=~/.config/discordrive-next/webhooks/<nazwa>.url \
  npx vitest run test/live.test.ts         # na żywo, TYLKO webhook z serwera a test Discord server; sprząta po sobie
node scripts/webhook-ratelimit.mjs run ... # pomiar limitów (koncept §7)
```

CLI: `DDN_STATE=<katalog> DDN_WEBHOOK_FILES=<plik.url> npx tsx src/cli.ts put <plik>`.
