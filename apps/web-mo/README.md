# @ddv4/web-mo — klient przeglądarkowy trybu metadata only (etap 2)

Logika i okablowanie bez wyglądu. Wygląd zleca się profilowi `frontend`
(`design-request --no-deploy`, bez publicznej domeny).

Architektura (koncept §4.1):
- `src/app-core.ts` — stan aplikacji (konto, urządzenie, klucz konta, lista folderu
  stronicowana, upload/download, parowanie), bez DOM; wywoływany przez UI.
- `src/keystore.ts` — klucz urządzenia Ed25519 (nieeksportowalny CryptoKey) i klucz konta w
  IndexedDB.
- `src/sw.ts` — service worker: streaming `Range` dla `/ddn/file/<id>`.
- `index.html` + `src/ui.ts` — minimalny, funkcjonalny interfejs (bez stylów) do testów i dla
  profilu `frontend` jako punkt wyjścia.

Budowanie: `npm run build -w @ddv4/web-mo` → `dist/`. Test w Chromium: `npm run check -w @ddv4/web-mo`.
