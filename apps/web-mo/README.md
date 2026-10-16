# @ddv4/web-mo: browser client of the metadata-only mode (stage 2)

Look and layout: **Cobalt, the theme of discordrive** (replaces Nordic):
tokens 1:1 from `discordrive/apps/frontend` (`cobalt/tokens.css`, light + dark), discordrive's
app-shell (`cobalt/app.css`): sidebar Files / Devices / Settings with the account, EN/PL and
light/dark/system in its footer; on a phone a hamburger and a drawer (MainLayout). Before sign-in the
AuthCard screens (Create account, Join this device, Restore from a rescue kit). Visual parity polish:
`frontend` profile. Served by the `apps/ddn-server` instance from the same origin; preview:
https://drive.example.com.

Pages (History API; the instance serves `index.html` for paths without an extension, so a reload keeps
the page):
- `/` and `/folder/<id>`: Files (folder heading with breadcrumb and counters, New folder modal,
  Upload, drop zone, upload panel, file table with type badges, size, date, play/download/share,
  pager only with more than one page). Without a channel: a note linking to Settings → Channels.
- `/devices`: device list (revoke) and pairing a new device (code/QR link + 6 digits).
- `/settings`: Account, Channels & webhooks (with the collapsed Discord guide), Rescue kit,
  Sharing, Appearance, About this browser (sync, main/secondary tab, persistent storage, limits).
- `/welcome`: first run after creating an account: 1. connect a channel, 2. save the rescue kit
  (forced once), then Files.
- signed out: `/` (create account), `/join`, `/restore`; share links `/s/<id>#<key>`.

Architecture:
- `src/app-core.ts`: application state (account, device, account key, paged folder list,
  upload/download, pairing), no DOM; called by the UI.
- `src/keystore.ts`: Ed25519 device key (non-extractable CryptoKey) and the account key in
  IndexedDB.
- `src/sw.ts`: service worker: `Range` streaming for `/ddn/file/<id>`.
- `index.html` + `src/ui.ts`: the interface and the client-side router (pages above). Elements
  driven by tests have stable `data-ddn` attributes; on* handlers never return a value (an
  `onkeydown` arrow returning `false` blocked typing in the webhook field; `check.ts` greps for it).
- `src/i18n.ts` + `src/locales/{en,pl}.ts`: all texts. English is the default (not taken from
  `navigator.language`); the instance default comes from `language` in the server config
  (`window.DDN_CONFIG.language`, also in `/v1/health`); the EN/PL switch (sidebar footer, sign-in screens, Settings → Appearance) stores
  the user's choice in `localStorage` (`ddn.lang`) and applies it without a reload. Static
  HTML uses `data-i18n` / `data-i18n-html` / `data-i18n-attr`; numbers, sizes and dates are
  formatted for the language (“11.4 MB” / “11,4 MB”). The key sets are compared by
  `apps/ddn-server/test/i18n.test.ts`.

Build: `npm run build -w @ddv4/web-mo` → `dist/` (the instance builds it at start when it is
missing or older than the sources: `build.ts` writes `dist/build-stamp.json` with a hash of
the inputs, `source-hash.ts`; `npm run update` in the repo root = pull + install + build). Chromium test: `npm run check -w @ddv4/web-mo` (instance server + fake Discord, 24
checks; text fields are driven with the real keyboard and Control+V, never `fill()`); `DDN_E2E_LANG=pl` runs it in Polish, `DDN_E2E_SCHEME=dark` with a dark color scheme;
the same scenario against the live preview: `DDN_E2E_URL=…` (see the header of `check.ts`).
