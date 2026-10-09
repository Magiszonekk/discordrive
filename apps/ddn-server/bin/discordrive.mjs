#!/usr/bin/env node
// discordrive: setup | start | doctor | invite
//
// Plain JavaScript on purpose: this file must run (and explain itself) on any
// Node version, before the TypeScript sources are loaded through tsx.
//  1. Node version check with a human message (no stack trace).
//  2. First run after `git clone`: installs this app's dependencies (only this
//     workspace and what it needs, not the whole monorepo), then continues.
//  3. Hands over to src/cli.ts.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIN = [22, 13, 0]; // node:sqlite without a flag
const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const repoDir = resolve(pkgDir, "..", "..");

const v = process.versions.node.split(".").map(Number);
const older = v[0] < MIN[0] || (v[0] === MIN[0] && (v[1] < MIN[1] || (v[1] === MIN[1] && v[2] < MIN[2])));
if (older) {
  console.error(
    [
      "",
      `discordrive potrzebuje Node.js w wersji ${MIN.join(".")} lub nowszej (zalecane: 22 LTS albo 24 LTS).`,
      `Masz: ${process.version} (${process.execPath}).`,
      "",
      "Jak zainstalować:",
      "  • Windows / macOS: pobierz instalator „LTS” ze strony https://nodejs.org i uruchom go,",
      "    potem otwórz NOWE okno terminala.",
      "  • Linux: https://nodejs.org/en/download (np. przez nvm: nvm install 22).",
      "Sprawdzenie: node -v",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function hasDeps() {
  try {
    const req = createRequire(join(pkgDir, "package.json"));
    for (const m of ["tsx/esm/api", "@ddv4/metadata-client/package.json", "@ddv4/web-mo/package.json", "@sqlite.org/sqlite-wasm/package.json", "uqr", "esbuild", "hash-wasm"]) req.resolve(m);
    return true;
  } catch {
    return false;
  }
}

if (!hasDeps()) {
  if (!existsSync(join(repoDir, "package-lock.json"))) {
    console.error("Brakuje zależności, a to nie wygląda na katalog repozytorium (brak package-lock.json). Uruchom polecenie w katalogu sklonowanego repo.");
    process.exit(1);
  }
  console.log("Pierwsze uruchomienie: instaluję zależności aplikacji (jednorazowo, zwykle kilkanaście sekund)…");
  const args = ["ci", "--workspace", "@ddv4/ddn-server", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"];
  // Inside `npm run`, npm tells us where its CLI is (works the same on Windows).
  const npmCli = process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? process.env.npm_execpath : null;
  const r = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: repoDir, stdio: "inherit" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: repoDir, stdio: "inherit", shell: process.platform === "win32" });
  if (r.error || r.status !== 0 || !hasDeps()) {
    console.error(
      [
        "",
        "Instalacja zależności nie powiodła się.",
        "Sprawdź połączenie z internetem i spróbuj ponownie. Ręcznie (w katalogu repo):",
        "  npm ci --workspace @ddv4/ddn-server --omit=dev",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log("Zależności zainstalowane.\n");
}

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
