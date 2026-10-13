# Proponowana treść AGENTS.md

Zapis do `AGENTS.md` jest chroniony w Hermesie (wymaga interaktywnej zgody; zablokowany 2026-10-09
i ponownie 2026-10-13, bo sesja nie miała interaktywnego zatwierdzenia). Właściciel zatwierdził zamianę
w zleceniu 2026-10-13. Przeniesienie 1:1 (od linii `# AGENTS.md:` do końca):

    sed -n '/^# AGENTS.md: discordrive-next/,$p' docs/AGENTS.proposed.md > AGENTS.md

---

# AGENTS.md: discordrive-next (repo `Magiszonekk/discordrive`, nazwa robocza)

Nowa generacja discordrive: jeden projekt zamiast discordrive (E2EE) i ddrive (bez E2EE), z trzema
trybami instancji (metadata only, e2ee, plain), ustalanymi przy budowaniu. Źródło prawdy:
`~/Desktop/discordrive-next/koncept.md` (poza repo). Zmiany decyzji proponuje się właścicielowi,
nie wprowadza samodzielnie.

## Granice
- Produkcja discordrive/ddrive (a VPS `discordrive-prod`, `ddrive-prod`, old-drive.example.com,
  old-drive.example.com) jest nietykalna: żadnych połączeń, webhooków, botów ani baz. Infra
  a VPS (nginx, DNS) należy do orkiestratora.
- Testy na żywo tylko na serwerze Discord `a test Discord server` (bot `test-bot`).
- Gałąź robocza `feat/metadata-only`; nie pushować na `main` bez zgody właściciela.
- Tokeny i URL-e webhooków nigdy w logach, commitach ani raportach.
- `~/Desktop/discordrive`, `~/Desktop/ddrive`: tylko do czytania.

## Struktura (to, co jest rozwijane)
- `packages/sync-core`: rdzeń synchronizacji (model indeksu, log operacji, reguły konfliktów 1–10,
  Sequencer, Replica, test losowy z niezmiennikami). `DECISIONS.md` = dziennik decyzji (etap 1, 2, 3
  i zlecenia późniejsze, w tym kontrakt §3.3 przy logowaniu hasłem).
- `packages/metadata-client`: klient wspólny dla trybów (DriveClient, szyfrowanie plików w formacie
  discordrive, manifesty, snapshoty, parowanie, zestaw ratunkowy, udostępnianie, sprzątanie
  `cleanup.ts`, klucz konta chroniony hasłem `password-key.ts`) + serwer HTTP/websocket (`src/node`,
  `DdnServer`) + CLI `ddn`. Metadata only: sejf webhooków i wysyłanie prosto na Discorda.
- `packages/server-discord`: część serwera e2ee/plain (webhooki instancji zaszyfrowane `instance.key`,
  wysyłacz z limiterem per kanał, fragmenty przez instancję, sprzątanie i snapshoty w tle,
  `PlainExtension`: replika indeksu, miniatury ffmpeg, streaming Range, wyszukiwanie).
- `apps/web-mo`: aplikacja przeglądarkowa wszystkich trybów (logika w workerze, OPFS, service worker
  do wideo). Moduł trybu `src/modes/<tryb>.ts` wybierany przez esbuild (`ddn:mode`); teksty
  `src/locales/{en,pl}.ts` z wariantami `klucz@e2ee` / `klucz@plain`, rozwiązywanymi przy budowaniu.
  Wygląd (Cobalt) robi profil `frontend`; tu logika i poprawki błędów.
- `apps/ddn-server`: instancja (`discordrive setup|start|serve|doctor|invite`), jeden proces dla API
  i aplikacji, bundle trybu `dist/<tryb>/server-mode.mjs`, autostart (systemd --user, Harmonogram
  zadań, LaunchAgent).
- Reszta (`apps/api`, `apps/frontend`, `packages/stream-engine`, `discord-client`, `database`,
  `redis`, …) to odziedziczony kod ddv4 (discordrive), tylko jako źródło wiedzy.
- Projekt etapu 3: `docs/stage3-modes.md`. Dowody: `docs/evidence/<data>-<temat>/`.

## Środowisko
- Node 22: `export PATH=/usr/local/bin:$PATH`
  (domyślny `node` w PATH to v26). W profilach agenta: `export HOME=~` przed git/npm.
- Chromium do testów: `CHROMIUM_PATH=~/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`.

## Komendy
```
npm run test:sync-core            # typecheck + testy rdzenia
npm run test:metadata-client      # typecheck + testy klienta/serwera (bez sieci)
npm test -w @ddv4/server-discord  # e2ee/plain po stronie serwera (fałszywy Discord)
npm run test:ddn-server           # setup, bundle trybów, teksty per tryb, i18n, autostart
DDN_E2E_MODE=metadata-only|e2ee|plain DDN_E2E_LANG=en|pl DDN_E2E_SCHEME=light|dark \
  npx tsx apps/web-mo/check.ts    # aplikacja w headless Chromium na serwerze instancji + fałszywy Discord
DDN_E2E_URL=https://drive.example.com DDN_E2E_INVITE=… DDN_E2E_WEBHOOK_FILES=a.url:b.url \
  npx tsx apps/web-mo/check.ts    # ta sama ścieżka przez publiczny preview, prawdziwy Discord
npm run setup                     # discordrive setup (interaktywnie)
```
Testy i check.ts budują do katalogu tymczasowego, nigdy do `apps/*/dist/<tryb>` (z niego serwują
działające preview). Komendy dłuższe niż ~7 min (fuzz, mutacje) w tle.

## Preview (wszystkie z `~/Desktop/discordrive`, gałąź `feat/metadata-only`)
| tryb | adres | usługa (`systemctl --user`) | port | dane |
|---|---|---|---|---|
| metadata only | https://drive.example.com | `discordrive-next` | 192.0.2.10:3020 | `~/.local/share/discordrive-next` |
| e2ee | https://e2ee.example.com | `discordrive-next-e2ee` | 192.0.2.10:3023 | `~/.local/share/discordrive-next-e2ee` |
| plain | https://plain.example.com | `discordrive-next-plain` | 192.0.2.10:3022 | `~/.local/share/discordrive-next-plain` |

nginx na a VPS (infra orkiestratora, nie ruszać) → a VPN → 192.0.2.10. Port 3021 zajęty przez inną
usługę. Po zmianie kodu: restart usługi przebudowuje `dist/<tryb>`; `discordrive doctor --data-dir …`
sprawdza całość. W preview są konta i dane właściciela: nie usuwać, testować na własnym koncie testowym.
