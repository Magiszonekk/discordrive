# discordrive desktop (Electron)

The web app in a window plus a background **agent**: the application core (`apps/web-mo/src/app-core.ts`,
the same code the browser runs in its worker) runs in a Node process with its own HTTP/2 connections to
Discord (`h2Fetch`), the tree in SQLite on disk, uploads read from disk and downloads written to disk at
offsets. Transfers continue with the window closed; the app lives in the tray.

Processes:
- **main** (`src/main.ts`): window, tray, autostart, first start, the OS key store (`safeStorage`), update
  check. Moves no data.
- **agent** (`src/agent.ts`, Electron `utilityProcess`): the core on the desktop platform
  (`src/agent/node-platform.ts`). Windows reach it through a `MessagePort` handed over by the preload;
  every call is checked against `src/agent/methods.ts`.
- **built-in instance** (`src/local-instance.ts`, `utilityProcess`, "This computer only"): the metadata-only
  server on 127.0.0.1, random port, database in the app's data folder.
- **window**: sandboxed, `contextIsolation`, no Node; loads only `app://ddn/` (the start page from
  `static/`, the web app of the server's mode from `dist/web/<mode>/`).

```
npm run build -w @ddv4/desktop          # dist/ (Electron side + the web app of every mode)
npm start -w @ddv4/desktop              # run it
npm test -w @ddv4/desktop               # agent and shell tests (Node)
xvfb-run -a npx tsx apps/desktop/test/smoke.ts   # Linux without a display
xvfb-run -a npx tsx apps/desktop/test/e2e.ts     # the real app driven by Playwright
npx tsx apps/desktop/package.ts --linux          # installers into release/ (--win on Windows)
```

Data folder (Electron `userData`; Linux `~/.config/discordrive`, Windows `%APPDATA%\discordrive`):
`desktop-settings.json` (server, autostart, downloads folder, update checks), `agent/` (keys, tree,
journals, transfer logs), `instance/` (the built-in instance's database).

## Updates

The app checks the `main-build` pre-release on GitHub (at most every 4 hours, or on "Check now") and offers a
build of another commit; nothing is downloaded or installed without the user's click. "Download the new
version" saves the installer for this system in the Downloads folder and checks its SHA-256 against the
release's `SHA256SUMS`. Then:

- **Windows: "Install and restart".** The app closes (running transfers: it asks first) and starts the
  downloaded installer silently in update mode in the folder it runs from (`/S --updated --force-run
  /D=<folder>`). In update mode electron-builder's NSIS installer keeps the shortcuts: the old version is
  removed with `--keep-shortcuts`, no desktop or Start menu shortcut is created again, so shortcuts the user
  moved, renamed or pinned to the taskbar stay where they are (the program's path and its AppUserModelID do
  not change). The data folder is not touched. The installer starts the app again (`--updated`). Running the
  downloaded `.exe` by hand opens the full installer, which re-creates the default shortcuts. A copy
  installed for all users (Program Files) needs administrator rights: Windows asks for them.
  Independent of updates: Windows shows an app's notifications only when the Start menu has a shortcut
  with the app's ID, so Electron itself writes `<Start menu>\Programs\discordrive.lnk` (with its
  notification activator) when the app shows its first notification, also when the user removed it.
  It touches only that one Start menu entry, never the desktop or pinned shortcuts.
  The app runs with the installer's AppUserModelID (`src/shell/app-id.ts`), so a pin made from the desktop
  shortcut, the Start menu or the running window is the same taskbar icon.
  CI (`desktop-release.yml`, job "update in place") installs a build A, moves the desktop shortcut, adds a
  Start menu shortcut, lets A update itself to B and checks the shortcuts, the data and the restart.
  Taskbar pins cannot be made in CI; to check by hand: pin discordrive to the taskbar, then Settings →
  Desktop app → Download → Install and restart; after the restart the pin is still there and starts the
  new version (About shows its build).
- **AppImage: "Install and restart"** replaces the AppImage file (when its folder is writable) and starts it.
- **.deb: "Install and restart".** The system password dialog (pkexec, polkit) runs `dpkg -i <file>` while the
  app still runs, then the app starts again as the new version (`--updated`); the data folder stays. Without
  pkexec the app shows `sudo dpkg -i "<file>"` with a Copy button. App Center and `apt install ./file.deb`
  are not used: they refuse a file whose package version equals the installed one.
  CI (job "update in place (.deb)") installs a build A, lets it update itself to B (with `sudo -n`, as pkexec
  needs a desktop session) and checks the package version, the files, the restart and the data.

**Version.** Every build of `main` has a growing package version `0.1.<number of commits>` (CI: `DDN_VERSION`):
the installer names, About and `build-info.json` show it, and dpkg, App Center and NSIS see a newer package.
The update check itself still compares commits.

## Electron security checklist

Against https://www.electronjs.org/docs/latest/tutorial/security:

| # | item | state |
|---|---|---|
| 1 | Only secure content | app files over `app://` (privileged, secure); the server over https (http only for this computer / a LAN, checked in `settings.ts`) |
| 2 | No Node.js integration for remote content | no remote content is loaded at all; `nodeIntegration: false` |
| 3 | Context isolation | `contextIsolation: true` |
| 4 | Process sandboxing | `sandbox: true`; the AppImage refuses to run without the sandbox (`shell/sandbox.ts`) |
| 5 | Permission requests | every request and check denied (`setPermissionRequestHandler`, `setPermissionCheckHandler`) |
| 6 | `webSecurity` | left on |
| 7 | Content Security Policy | set on every `app://` response (`csp()` in `main.ts`): `script-src 'self'`, `connect-src` = the server + Discord |
| 8 | `allowRunningInsecureContent` | off |
| 9 | Experimental features | not enabled |
| 10 | `enableBlinkFeatures` | not used |
| 11 | `<webview>` | blocked (`will-attach-webview` prevented) |
| 12 | Navigation | `will-navigate` / `will-redirect`: only `app://ddn`; http(s) opens in the system browser |
| 13 | New windows | `setWindowOpenHandler` denies all (http(s) → system browser) |
| 14 | `shell.openExternal` with untrusted content | only `http:`/`https:` URLs; `shell.openPath` and the in-place update only for the installer the app downloaded and checked (SHA-256 checked again before it runs) |
| 15 | Current Electron | 45 (Node 24, Chromium 156); updated with the app |
| 16 | Validate the sender of IPC messages | every handler checks the sender frame is the app's own main frame (`isAppUrl`); setup calls only from the start page |
| 17 | `file://` | not used for the window (custom `app://` protocol mapped to the app's folders, path traversal refused: `shell/paths.ts`, tests) |
| 18 | Electron fuses | set in `package.ts`: RunAsNode, NODE_OPTIONS and --inspect off; app only from the asar, with integrity validation where Electron supports it (Windows, macOS); no extra file:// privileges; cookie encryption on |
| 19 | Do not expose Electron APIs to untrusted web content | the preload exposes only a few narrow functions (`ddnDesktop`), never `ipcRenderer` itself |

Not yet: code signing (owner's decision: none for now), OS-level metered connection detection.
