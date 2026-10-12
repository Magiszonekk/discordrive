# @ddv4/web-mo: browser client of the metadata-only mode (stage 2)

Logic and wiring; the look comes from the `frontend` profile: nordic, Nordic Calm
(light, default) / Nordic Night (dark) with a system/light/dark button in the header (branch
`design/discordrive-next-20261012`, merged 2026-10-12; before: house-v1). Screens added later for the logic
(rescue kit, joining a device, sharing) use the same classes and tokens.
Served by the `apps/ddn-server` instance from the same origin; preview:
https://drive.example.com.

Architecture (concept §4.1):
- `src/app-core.ts`: application state (account, device, account key, paged folder list,
  upload/download, pairing), no DOM; called by the UI.
- `src/keystore.ts`: Ed25519 device key (non-extractable CryptoKey) and the account key in
  IndexedDB.
- `src/sw.ts`: service worker: `Range` streaming for `/ddn/file/<id>`.
- `index.html` + `src/ui.ts`: the interface: account (with invite code), channel wizard, rescue
  kit (`ddn-kit1:` text + QR + file + print; forced once after the first channel), files
  (keyset paging by 50, upload queue with byte progress, download, video, sharing), devices
  (names, revoke, pairing: QR + 6 digits on both sides), joining from a kit, the share link
  recipient page `/s/<id>#<key>`, phone view (tabs). Elements driven by tests have stable
  `data-ddn` attributes.
- `src/i18n.ts` + `src/locales/{en,pl}.ts`: all texts. English is the default (not taken from
  `navigator.language`); the instance default comes from `language` in the server config
  (`window.DDN_CONFIG.language`, also in `/v1/health`); the EN/PL switch in the header stores
  the user's choice in `localStorage` (`ddn.lang`) and applies it without a reload. Static
  HTML uses `data-i18n` / `data-i18n-html` / `data-i18n-attr`; numbers, sizes and dates are
  formatted for the language (“11.4 MB” / “11,4 MB”). The key sets are compared by
  `apps/ddn-server/test/i18n.test.ts`.

Build: `npm run build -w @ddv4/web-mo` → `dist/` (the instance builds it at start when it is
missing or older than the sources: `build.ts` writes `dist/build-stamp.json` with a hash of
the inputs, `source-hash.ts`; `npm run update` in the repo root = pull + install + build). Chromium test: `npm run check -w @ddv4/web-mo` (instance server + fake Discord, 20
checks); `DDN_E2E_LANG=pl` runs it in Polish, `DDN_E2E_SCHEME=dark` with a dark color scheme;
the same scenario against the live preview: `DDN_E2E_URL=…` (see the header of `check.ts`).
