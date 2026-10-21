# discordrive-next

**English** · [Polski](README.pl.md)

A private drive on your own Discord channels. In the default mode files are encrypted in the
browser before anything leaves the computer; Discord only stores encrypted pieces, and the server
only an encrypted file list. Works in the browser on computers and phones.

## Quick start

**You need:**
- **Node.js 22 or newer** (the “LTS” version from https://nodejs.org; on Windows/macOS the
  regular installer, then open a new terminal window). Check: `node -v`.
- **Git** (https://git-scm.com) and access to this repository.
- **A Discord account** (a regular, free one). You create the server, channels and webhooks
  along the way: the app shows where to click.

**Run it** (Terminal on macOS/Linux or PowerShell on Windows):

```
git clone https://github.com/Magiszonekk/discordrive.git
cd discordrive
npm run setup
```

The first time, `npm run setup` installs the libraries it needs by itself (a few seconds,
internet required). The first question after the language is a notice you have to accept on
purpose (Enter alone cancels): storing files on Discord is against Discord's Terms of Service,
and the software comes without any warranty. Then it asks a few questions: pick with the arrow
keys, confirm with Enter. **You can answer each of them with Enter**:
by default the drive only runs on this computer, at `http://localhost:3020`. Link sharing
(needs your own Discord bot) can be skipped and turned on later.

**What you will see:** at the end the wizard says “Done. Open in the browser:
http://localhost:3020” and keeps the drive running in that window. Open that address, create an
account, connect a Discord channel following the on-screen guide, save the rescue kit and
upload your first file.

**Language:** English by default. Polish: answer `2` to the first question
(`Language / Język`), or run `npm run setup -- --lang pl`, or set `DISCORDRIVE_LANG=pl`. The
choice is saved for the next commands. Yes/no questions are always `[Y/n]` / `[y/N]`. The
browser app has an EN/PL switch in the header (remembered in the browser).

## Browser requirements

The app signs every device in with an Ed25519 key made by the browser (WebCrypto). That needs
**Chrome, Edge or Brave 137 or newer, Firefox 129 or newer, Safari 17 or newer** (also on phones).
An older browser shows “This browser is too old” instead of the sign-up form; update it. There is
no fallback in JavaScript on purpose: the key stays inside the browser's own crypto.

**Transfers stuck at ~20 MB/s on a fast line (Chrome, Brave, Edge on Linux).** These browsers talk to
Discord over HTTP/3 (QUIC), which on some systems is much slower than HTTP/2 (measured on a
111/69 MB/s line: ~20 MB/s with QUIC, 63–67 MB/s without). You can turn it off for the browser:
`chrome://flags/#enable-quic` (Brave: `brave://flags/#enable-quic`) → Disabled, or the policy
`QuicAllowed: false`; Firefox: `network.http.http3.enable` = false in `about:config`. It affects every
site; the app works either way.

## Desktop app (Windows, Linux)

The same drive as an app: the web app in a window plus a background agent that moves the data itself
(several connections to Discord for uploads, files read from and written straight to disk). It keeps
uploading, downloading and syncing with the window closed (tray icon; Quit is in the tray menu), starts
with the system (can be switched off), and continues an interrupted download after a restart. At the
first start pick **Connect to a server** (the address of an instance; then sign in, pair or create an
account as in the browser) or **This computer only** (the app runs its own instance on this computer, no
Node.js or terminal needed; only this computer can reach it).

**Download:** [Releases → `main-build`](https://github.com/Magiszonekk/discordrive/releases/tag/main-build):
`…win-x64.exe` (Windows), `…amd64.deb` (Ubuntu, Debian), `…x86_64.AppImage` (other Linux). Check the
download with `SHA256SUMS` from the same page (`sha256sum -c SHA256SUMS --ignore-missing`).

- **The builds are not code-signed.** Windows SmartScreen says “Windows protected your PC”: click
  **More info → Run anyway**. Only do that with a file from the page above whose checksum matches.
- **Ubuntu 24.04 and newer:** install the `.deb` (`sudo apt install ./discordrive-…-amd64.deb`); it adds
  the AppArmor profile Chromium's sandbox needs. The AppImage cannot get one by itself on these systems
  and says so instead of starting without the sandbox.
- **Updates are never installed by themselves.** The app checks for a newer build every few hours
  (Settings → Desktop app; can be switched off) and shows it in the tray and in Settings. **Download**
  fetches the installer for your system to Downloads and checks its SHA-256; you run it yourself.
- **Keys:** kept by the app, protected by the system key store (Windows DPAPI, Linux GNOME Keyring /
  KWallet). Without a key store (some Linux setups) they are a file only your user can read; Settings
  says so. Details: [docs/threat-model.md §2.12](docs/threat-model.md).

## Modes

Chosen in `npm run setup`, fixed for the life of the instance (another mode = a new instance in
another data directory). The app and the server are built for that one mode only.

| Mode | The server sees | Who uploads to Discord | Background work without an open tab |
|---|---|---|---|
| **metadata only** (default) | accounts, device public keys, how many operations, sizes and times; not your files, names or webhooks | your browser, straight to your channels | no |
| **e2ee** | the same plus the webhooks and every encrypted piece on its way; not your files or names | the server, with the instance's channels (or yours, added in Settings) | yes: snapshots, cleanup, link refreshing |
| **plain** | everything (files, names, file keys): thumbnails, preview, search on the server | the server | yes |

What the server, Discord, a thief of the server's database or of a device can and cannot do in
each mode: [docs/threat-model.md](docs/threat-model.md) (one chapter per mode).

e2ee without questions: `npm run setup -- --yes --accept-risk --mode e2ee --webhooks-file hooks.txt`
(one webhook URL per line; they are stored encrypted with `instance.key` in the data directory,
never in `config.json`).

## Devices and people

**Your next device (phone, laptop).** Pair it with a device that is already signed in:
1. On the new device open the drive's address and choose **Join this device**. It shows a QR code
   and a text starting with `ddn-pair1:`.
2. On the signed-in device: **Devices → Pair a new device**, scan the code (or paste the text),
   press **Pair**.
3. Both screens show 6 digits. They must be the same; if not, stop and revoke the new device.

The signed-in device hands over the account key encrypted for the new one, through a one-time
mailbox on the server: the server relays it but cannot read it. The new device gets its own
sign-in key (Ed25519), added to your account. Pairing gives the whole account, so use it only for
your own devices.

**When no device is at hand:**
- **Rescue kit** (shown after the first channel, again in Settings): on a new device choose
  **I have a rescue kit** and paste the code. Keep it like a password: whoever has it has the
  account.
- **Sign in with password** (optional, off by default: Settings → Security). Convenient, but the
  server then keeps your account key locked with the password. Whoever steals the server's
  database can try passwords offline, so only use it with a long password.

**Lost or old device.** Devices → **Revoke device**. It can no longer sign in to the server. Be
aware of the limit: the account key that device had is not changed (there is no key rotation).
Whoever kept it can still decrypt what they can get from Discord and can add a new device to the
account the way a rescue kit does. If a device fell into the wrong hands, the only full fix is a
new account and uploading the files again. In metadata only, also delete and recreate your
webhooks in Discord.

**Another person.** Always their own account, never pairing. On a public instance the
administrator gives them an invite code (`npm run invite`, or the **Admin** screen in the web app
for an account with the admin flag). Accounts are separate: nobody sees anyone else's files.
- metadata only: they connect their own channels and webhooks. Best if they create them
  themselves: whoever creates a webhook knows its address, and the address is the secret that can
  post and delete messages.
- e2ee / plain: the instance's shared channels are used; webhooks are not needed (they can still
  add their own in Settings → Channels & webhooks).

**One file for someone.** **Share** in the file list gives a link `https://…/s/<id>#<key>`. The
recipient needs no account. The key after `#` is never sent to the server. Sharing needs the
instance's Discord bot (set up in `npm run setup`). Turning a link off stops new recipients, but
whoever already has the link keeps access as long as the file's pieces exist on Discord.

**Shared folders between accounts do not exist and are not planned.**

## Commands

| What | Command (in the `discordrive` directory) |
|---|---|
| start the drive | `npm start` (stop: Ctrl+C) |
| change settings | `npm run setup` |
| something is wrong | `npm run doctor` |
| stop starting it in the background | `npm run uninstall-autostart` |
| invite code (public instance) | `npm run invite` (`-- --note "for Ann"`, `-- list`, `-- revoke <id>`) |
| accounts: list, block, delete, admin | `npm run accounts -- list` (`block <id>`, `unblock <id>`, `delete <id>`, `admin <id> on`) |
| who can create accounts | `npm run signup -- invite` (or `open`, `closed`; applies at once) |
| update to the newest version | `npm run update`, then start the drive again |

## Updating

`npm run update`, then start the drive again. It runs `git pull` + `npm install` + a fresh build
of the browser app. A plain `git pull` is fine too: `npm start` notices that the browser app
sources changed and rebuilds it before starting (a few seconds). A running drive (or the
background start: systemd, Task Scheduler, LaunchAgent) keeps serving the old page until it is
restarted.

## Where things are

Server data (configuration and the encrypted file list) is in `~/.local/share/discordrive-next`
(Linux), `~/Library/Application Support/discordrive-next` (macOS) or
`%LOCALAPPDATA%\discordrive-next` (Windows). The files themselves are on your Discord channels.

## Advanced

Server with a domain and HTTPS, background start on Linux/Windows/macOS, options without questions:
[apps/ddn-server/README.md](apps/ddn-server/README.md).

Note: storing files on Discord is against its terms of service; Discord may delete messages
or block the account. Keep a copy of important files somewhere else.
