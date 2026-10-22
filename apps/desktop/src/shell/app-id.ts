// The app's identity on Windows. The installer (package.ts: electron-builder `appId`) gives its desktop and
// Start menu shortcuts this AppUserModelID, and the app sets the same one on its process (main.ts), so the
// taskbar treats a pin made from a shortcut, from the Start menu or from the running window as one app.
// Never change it: the installer derives its registry key from it (a new ID = a second installation), and
// pins made with the old ID would stop matching the running app.
export const APP_USER_MODEL_ID = "io.github.magiszonekk.discordrive";
