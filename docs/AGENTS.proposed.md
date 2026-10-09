# Proponowana treść AGENTS.md (zapis do AGENTS.md zablokowany 2026-10-09: plik chroniony, wymaga zgody)

Do przeniesienia 1:1 do `AGENTS.md` w katalogu głównym repo (obecny opisuje stary discordrive).

---

# AGENTS.md: discordrive-next (repo `Magiszonekk/discordrive`, nazwa robocza)

Nowa generacja discordrive: jeden projekt zamiast discordrive (E2EE) i ddrive (bez E2EE),
z trzema trybami instancji. Źródło prawdy: `~/Desktop/discordrive-next/koncept.md` (poza
repo). Zmiany decyzji proponuje się właścicielowi, nie wprowadza samodzielnie.

## Granice
- Produkcja discordrive/ddrive (a VPS `discordrive-prod`, `ddrive-prod`, old-drive.example.com,
  old-drive.example.com) jest nietykalna: żadnych połączeń, webhooków, botów ani baz.
- Testy na żywo tylko na serwerze Discord `a test Discord server` (bot `test-bot`).
- Gałąź robocza `feat/metadata-only`; nie pushować na `main` bez zgody właściciela.
- Tokeny i URL-e webhooków nigdy w logach, commitach ani raportach.

## Struktura (to, co jest rozwijane)
- `packages/sync-core`: etap 1, rdzeń synchronizacji (model indeksu, log operacji, reguły
  konfliktów 1–10, Sequencer, Replica, test losowy z niezmiennikami). `DECISIONS.md` = dziennik
  decyzji (sekcja „Etap 2” dla metadata only).
- `packages/metadata-client`: etap 2, klient i serwer trybu metadata only (sejf webhooków,
  szyfrowany log, upload/download prosto na Discorda, snapshoty, parowanie, zestaw
  ratunkowy, udostępnianie, serwer HTTP + websocket, CLI `ddn`). Plan: `PLAN-etap2.md`.
- `apps/web-mo`: aplikacja przeglądarkowa trybu metadata only (logika w workerze, OPFS,
  service worker do wideo). Wygląd robi profil `frontend`; tu tylko logika i poprawki błędów.
- `apps/ddn-server`: instancja (`discordrive setup|serve|doctor|invite`), jeden proces dla
  API i aplikacji, unit systemd --user.
- Reszta (`apps/api`, `apps/frontend`, `packages/stream-engine`, `discord-client`, `database`,
  `redis`, …) to odziedziczony kod ddv4 (discordrive), źródło do etapu 3 (tryby e2ee/plain).

## Środowisko
- Node 22: `export PATH=/usr/local/bin:$PATH`
  (domyślny `node` w PATH to v26). W profilach agenta: `export HOME=~` przed git/npm.
- Chromium do testów: `CHROMIUM_PATH=~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`.

## Komendy
```
npm run test:sync-core            # typecheck + testy rdzenia
npm run test:metadata-client      # typecheck + testy klienta/serwera (bez sieci)
npm run test:ddn-server           # kreator setup, zaproszenia, limity, health
npm run check:web-mo              # aplikacja w headless Chromium na ścieżce serwera instancji + fałszywy Discord
npm run setup                     # discordrive setup (interaktywnie)
DDN_E2E_URL=https://drive.example.com DDN_E2E_INVITE=… DDN_E2E_WEBHOOK_FILES=a.url:b.url \
  npx tsx apps/web-mo/check.ts    # ta sama ścieżka przez publiczny preview, prawdziwy Discord
```
Komendy dłuższe niż ~7 min (fuzz, mutacje) w tle, na osobnym worktree.

## Preview
https://drive.example.com → nginx na a VPS (infra orkiestratora, nie ruszać) → `192.0.2.10:3020`,
`systemctl --user status discordrive-next`, konfiguracja `~/.local/share/discordrive-next/`,
`discordrive doctor` sprawdza całość.
