#!/usr/bin/env node
// ddn: discordrive-next from the command line. Runs the TypeScript sources through tsx (from the repo);
// the release build is a single bundled file instead (apps/cli/build.ts).
import { register } from "node:module";
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`ddn needs Node.js 22.13 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
if (process.platform !== "win32") process.umask(0o077);
const emit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (String(w?.message ?? w).includes("SQLite is an experimental feature")) return;
  return emit.call(process, w, ...rest);
};
// The application core imports its mode as `ddn:mode`: the command line picks it per instance (mode-switch.ts).
register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === "ddn:mode") return { url: ${JSON.stringify(new URL("../src/mode-switch.ts", import.meta.url).href)}, shortCircuit: true };
  return next(s, c);
}`));
const { register: tsx } = await import("tsx/esm/api");
tsx();
await import("../src/main.ts");
