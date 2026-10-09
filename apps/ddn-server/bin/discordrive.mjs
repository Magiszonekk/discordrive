#!/usr/bin/env node
// discordrive: setup | serve | doctor | invite (TypeScript sources run through tsx).
import { register } from "tsx/esm/api";

// Files we create (database, config) are private to the user.
process.umask(0o077);
// node:sqlite prints an "experimental" warning on every start; it is expected here.
const emit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (String(w?.message ?? w).includes("SQLite is an experimental feature")) return;
  return emit.call(process, w, ...rest);
};
register();
const { main } = await import("../src/cli.ts");
const code = await main(process.argv.slice(2));
if (code !== 0 || process.argv[2] !== "serve") process.exit(code);
