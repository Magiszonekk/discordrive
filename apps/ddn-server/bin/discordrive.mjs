#!/usr/bin/env node
// discordrive: setup | start | doctor | invite
//
// Plain JavaScript on purpose: this file must run (and explain itself) on any
// Node version, before the TypeScript sources are loaded through tsx.
//  1. Node version check with a human message (no stack trace).
//  2. First run after `git clone`: installs this app's dependencies (only this
//     workspace and what it needs, not the whole monorepo), then continues.
//  3. Hands over to src/cli.ts.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIN = [22, 13, 0]; // node:sqlite without a flag
const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const repoDir = resolve(pkgDir, "..", "..");

// Language (same rules as src/cli.ts): --lang, DISCORDRIVE_LANG, `language` in
// the saved config.json, else English. Only the messages of this file.
function savedLang() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--data-dir");
  const env = process.env;
  const home = homedir();
  const dir =
    (i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--data-dir="))?.split("=")[1]) ||
    env.DISCORDRIVE_DATA_DIR ||
    (process.platform === "win32"
      ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "discordrive-next")
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support", "discordrive-next")
        : join(env.XDG_DATA_HOME || join(home, ".local", "share"), "discordrive-next"));
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).language;
  } catch {
    return undefined;
  }
}
const langArg = (() => {
  const argv = process.argv.slice(2);
  const i = argv.findIndex((a) => a === "--lang" || a.startsWith("--lang="));
  return i < 0 ? undefined : argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1];
})();
const LANG = [langArg, process.env.DISCORDRIVE_LANG, savedLang()].map((x) => String(x ?? "").toLowerCase().slice(0, 2)).find((x) => x === "en" || x === "pl") ?? "en";
const M = {
  en: {
    oldNode: (min, have, exe) => [
      "",
      `discordrive needs Node.js ${min} or newer (recommended: 22 LTS or 24 LTS).`,
      `You have: ${have} (${exe}).`,
      "",
      "How to install:",
      "  • Windows / macOS: download the “LTS” installer from https://nodejs.org and run it,",
      "    then open a NEW terminal window.",
      "  • Linux: https://nodejs.org/en/download (e.g. with nvm: nvm install 22).",
      "Check: node -v",
      "",
    ],
    notRepo: "Dependencies are missing and this does not look like the repository directory (no package-lock.json). Run the command in the cloned repo directory.",
    installing: "First run: installing the app's dependencies (once, usually a few seconds)…",
    installFail: (missing) => [
      "",
      `Installing dependencies failed${missing ? ` (missing: ${missing})` : ""}.`,
      "Check your internet connection and try again. Manually (in the repo directory):",
      "  npm ci --workspace @ddv4/ddn-server",
    ],
    installed: "Dependencies installed.\n",
  },
  pl: {
    oldNode: (min, have, exe) => [
      "",
      `discordrive potrzebuje Node.js w wersji ${min} lub nowszej (zalecane: 22 LTS albo 24 LTS).`,
      `Masz: ${have} (${exe}).`,
      "",
      "Jak zainstalować:",
      "  • Windows / macOS: pobierz instalator „LTS” ze strony https://nodejs.org i uruchom go,",
      "    potem otwórz NOWE okno terminala.",
      "  • Linux: https://nodejs.org/en/download (np. przez nvm: nvm install 22).",
      "Sprawdzenie: node -v",
      "",
    ],
    notRepo: "Brakuje zależności, a to nie wygląda na katalog repozytorium (brak package-lock.json). Uruchom polecenie w katalogu sklonowanego repo.",
    installing: "Pierwsze uruchomienie: instaluję zależności aplikacji (jednorazowo, zwykle kilkanaście sekund)…",
    installFail: (missing) => [
      "",
      `Instalacja zależności nie powiodła się${missing ? ` (brakuje: ${missing})` : ""}.`,
      "Sprawdź połączenie z internetem i spróbuj ponownie. Ręcznie (w katalogu repo):",
      "  npm ci --workspace @ddv4/ddn-server",
    ],
    installed: "Zależności zainstalowane.\n",
  },
}[LANG];

const v = process.versions.node.split(".").map(Number);
const older = v[0] < MIN[0] || (v[0] === MIN[0] && (v[1] < MIN[1] || (v[1] === MIN[1] && v[2] < MIN[2])));
if (older) {
  console.error(M.oldNode(MIN.join("."), process.version, process.execPath).join("\n"));
  process.exit(1);
}

const NEEDED = ["tsx/esm/api", "@ddv4/metadata-client", "@ddv4/web-mo/package.json", "@sqlite.org/sqlite-wasm/package.json", "uqr", "esbuild", "hash-wasm", "@clack/core", "@clack/prompts"];
/** First missing module, or null. */
function missingDep() {
  const req = createRequire(join(pkgDir, "package.json"));
  for (const m of NEEDED) {
    try {
      req.resolve(m);
    } catch {
      return m;
    }
  }
  return null;
}
const hasDeps = () => missingDep() === null;

if (!hasDeps()) {
  if (!existsSync(join(repoDir, "package-lock.json"))) {
    console.error(M.notRepo);
    process.exit(1);
  }
  // A small spinner on a terminal (the TUI library is not installed yet); npm output only on error.
  const tty = process.stdout.isTTY && process.env.TERM !== "dumb";
  const frames = ["◒", "◐", "◓", "◑"];
  let fi = 0;
  const spin = tty ? setInterval(() => process.stdout.write(`\r${frames[fi++ % 4]}  ${M.installing}`), 100) : null;
  if (tty) process.stdout.write("\x1b[?25l");
  else console.log(M.installing);
  // Not --omit=dev: tsx (runs the TypeScript sources) is a root devDependency.
  const args = ["ci", "--workspace", "@ddv4/ddn-server", "--no-audit", "--no-fund", "--loglevel=error", "--update-notifier=false"];
  // Inside `npm run`, npm tells us where its CLI is (works the same on Windows).
  const npmCli = process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? process.env.npm_execpath : null;
  const child = npmCli
    ? spawn(process.execPath, [npmCli, ...args], { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const r = await new Promise((done) => {
    child.on("error", (error) => done({ error, status: null }));
    child.on("close", (status) => done({ error: null, status }));
  });
  if (spin) {
    clearInterval(spin);
    process.stdout.write(`\r\x1b[2K${r.status === 0 ? "✔" : "✖"}  ${M.installing.replace(/…$/, "")}\n\x1b[?25h`);
  }
  if (r.error || r.status !== 0 || !hasDeps()) {
    if (log.trim()) console.error(log.trim());
    console.error(M.installFail(r.status === 0 ? missingDep() : null).join("\n"));
    process.exit(1);
  }
  console.log(M.installed);
}

// Output piped into `head` and closed early: exit quietly instead of an EPIPE stack trace.
for (const st of [process.stdout, process.stderr]) st.on("error", (e) => (e.code === "EPIPE" ? process.exit(0) : undefined));
// Files we create (database, config) are private to the user.
if (process.platform !== "win32") process.umask(0o077);
// node:sqlite prints an "experimental" warning on every start; it is expected here.
const emit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (String(w?.message ?? w).includes("SQLite is an experimental feature")) return;
  return emit.call(process, w, ...rest);
};
const { register } = await import("tsx/esm/api");
register();
const { main } = await import("../src/cli.ts");
const code = await main(process.argv.slice(2));
// "running": the server keeps the process alive (start, or setup that started it).
if (code !== "running") process.exit(code);
