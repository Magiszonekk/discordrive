# discordrive desktop (Electron)

The web app in a window plus a background agent: transfers run in a Node process (its own HTTP/2
connections to Discord, writes straight to disk), so they continue with the window closed.

Processes:
- **main** (`src/main.ts`): window, tray, autostart, OS key store. Moves no data.
- **agent** (`src/agent.ts`, Electron `utilityProcess`): the application core on Node. The window reaches it
  through a `MessagePort` handed over by the preload, with the same request/response protocol as the browser worker.
- **window**: sandboxed, `contextIsolation`, no Node, loads only `app://ddn/` (the app's own files).

    npm run build -w @ddv4/desktop
    npm start -w @ddv4/desktop
    xvfb-run -a npx tsx apps/desktop/test/smoke.ts   # Linux without a display

Status: skeleton (window ↔ agent channel, security baseline, smoke test in CI).
