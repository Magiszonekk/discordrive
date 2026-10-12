# @ddv4/ddn-server: the discordrive-next instance (`discordrive`)

One process: the metadata-only API (`/v1/...`), the notify websocket (`/v1/notify`) and the
built browser app (`apps/web-mo/dist`), all from the same origin (the service worker that
plays video needs the same origin and HTTPS).

## Quick start

See “Quick start” in the main [README](../../README.md): `git clone` → `npm run setup`.
`bin/discordrive.mjs` is plain JS: it checks the Node version (≥ 22.13, with a readable
message), installs only this app's dependencies on the first run
(`npm ci --workspace @ddv4/ddn-server`, about 55 packages / 75 MB, without the Prisma/Postgres
of the old ddv4), then loads the TS sources through tsx.

The wizard runs as an interactive terminal UI (@clack): choices with ↑/↓ and Enter shown as
◉/○, yes/no as a `Yes / No` toggle (←/→ or y/n; Polish mode also `t`), text fields with the
current value as a placeholder (Enter keeps it) and live validation (bad address, busy port with
a free one suggested, unwritable directory, a bot token refused by Discord: the message appears
under the field), a spinner while the app builds and the server is tested, a “Step n/5” header
and framed summary / next steps. Esc or Ctrl+C stops it (nothing saved, exit 130, cursor
restored). `NO_COLOR` is respected. Without a terminal (pipes, CI, `TERM=dumb`, `--yes`,
`DISCORDRIVE_PLAIN=1`) it falls back to plain numbered questions with `[Y/n]`, same order.
Steps (Enter = the default):
0. language: English (default) or Polish; skipped with `--lang en|pl` or `DISCORDRIVE_LANG`,
   saved as `language` in `config.json` and used by the next `start`/`doctor`/`invite` and as
   the default language of the browser app (users can switch there; their choice wins);
   in Polish mode `t`/`tak`/`nie` are accepted too, but `y/n` is what is shown,
1. checks the requirements (Node, write access to the data directory),
2. where it runs: **this computer only** (default: `http://localhost:<port>`, bind 127.0.0.1,
   open sign-up; localhost is a secure context, so the service worker and WebCrypto work
   without TLS) or **a server with a domain** (https address, listen address, trusted proxy,
   sign-up by invite code by default); port with busy-port detection,
3. mode (`metadata-only` today; e2ee and plain shown as “coming soon”),
4. link sharing: “Skip for now” is the default and explains what you lose; “now” shows the
   Discord Developer Portal step by step; the token is typed without echo, checked with
   `GET /users/@me`, stored only in the configuration file,
5. who can create accounts (server with a domain only),
6. data directory (checks write access),

then it saves `config.json`, builds the browser app, on Linux with systemd offers the
`discordrive-next.service` unit (default yes for a server, no for “this computer only”),
otherwise offers to start in this window (Ctrl+C stops it), runs a `/v1/health` test and ends
with a summary: the address to open, what to do in the browser, where the configuration and
data are, `npm start` / `npm run setup` / `npm run doctor`.
Running it again = editing: current values are the defaults, the saved token stays unless you
choose otherwise.

Cross-platform: data directory `~/.local/share` / `~/Library/Application Support` /
`%LOCALAPPDATA%` (override: `DISCORDRIVE_DATA_DIR`), paths via `path`/`os.homedir()`, systemd
on Linux only, POSIX modes (0600/0700) only outside Windows. Tested live on Linux; macOS and
Windows by code review only.

## Commands

```
discordrive setup  [--data-dir DIR] [--lang en|pl]   # wizard; again = edit                 (npm run setup)
discordrive start  [--data-dir DIR]                  # server in this window (alias: serve) (npm start)
discordrive doctor [--data-dir DIR]                  # (npm run doctor) Node, write access, config, permissions, port, bind, unit, local and public health, bot token
discordrive invite [--days N] [--note TXT]           # new single-use invite code (npm run invite)
```

`--lang en|pl` (or `DISCORDRIVE_LANG=pl`) works with every command and beats the saved language.
Through npm: `npm run setup -- --lang pl`.

Without questions (tests, automation):

```
discordrive setup --yes --public-url https://drive.example.com --host 10.0.0.2 --port 3020 \
  --trust-proxy 10.0.0.1 --signup invite --bot-token-file ~/bot.token --systemd --lang en
discordrive setup --yes --answers answers.json      # the same keys in JSON (publicUrl, host, port, trustProxy, signup, botTokenFile, systemd, language, …)
```

`--bot-token` on the command line is refused (it would end up in the shell history).
`--bot-token-file` accepts the bare token or an `.env` file with a `NAME=token` line.

## Files

- `<data dir>/config.json` (0600; dir 0700; default per platform, above): the only source of
  the server configuration. Fields: [.env.example](.env.example) (documentation; the server
  does not read environment variables).
- `<data dir>/ddn.db` (0600): the server database (encrypted log, vaults, device public keys,
  invite codes as SHA-256, attachment addresses of shared files).
- `~/.config/systemd/user/discordrive-next.service`: unit with the full path to Node.

## Preview

The public preview of the project runs behind nginx with TLS (websocket forwarded) and was
configured with `discordrive setup` alone, in the “server with a domain” mode.

## Tests

```
npm test -w @ddv4/ddn-server     # wizard without questions, scripted plain input (EN and PL), the arrow-key wizard in a pty (test/tui.test.ts), i18n key sets, invites, per-IP limits, health, static files, doctor
```
