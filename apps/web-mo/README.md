# @ddv4/web-mo — klient przeglądarkowy trybu metadata only (etap 2)

Logika i okablowanie; wygląd (house-v1) od profilu `frontend` (gałąź
`design/discordrive-next-20261006`, zmergowana 2026-10-09). Nowe ekrany wymagane logiką
(zestaw ratunkowy, dołączanie urządzenia, udostępnianie) używają tych samych klas i tokenów.
Serwowana przez instancję `apps/ddn-server` z tego samego originu; preview:
https://drive.example.com.

Architektura (koncept §4.1):
- `src/app-core.ts` — stan aplikacji (konto, urządzenie, klucz konta, lista folderu
  stronicowana, upload/download, parowanie), bez DOM; wywoływany przez UI.
- `src/keystore.ts` — klucz urządzenia Ed25519 (nieeksportowalny CryptoKey) i klucz konta w
  IndexedDB.
- `src/sw.ts` — service worker: streaming `Range` dla `/ddn/file/<id>`.
- `index.html` + `src/ui.ts` — interfejs: konto (z kodem zaproszenia), kreator kanałów, zestaw
  ratunkowy (tekst `ddn-kit1:` + QR + plik + druk; wymuszony raz po pierwszym kanale), pliki
  (stronicowanie keyset po 50, kolejka wysyłania z postępem w bajtach, pobieranie, wideo,
  udostępnianie), urządzenia (nazwy, odwołanie, parowanie: QR + 6 cyfr po obu stronach),
  dołączanie z zestawu, strona odbiorcy linku `/s/<id>#<klucz>`, widok telefonu (zakładki).
  Elementy sterowane przez testy mają stabilne `data-ddn`.

Budowanie: `npm run build -w @ddv4/web-mo` → `dist/` (instancja buduje sama przy pierwszym
starcie, jeśli brak). Test w Chromium: `npm run check -w @ddv4/web-mo` (serwer instancji +
fałszywy Discord, 15 sprawdzeń); ten sam scenariusz na żywym preview: `DDN_E2E_URL=…`
(patrz nagłówek `check.ts`).
