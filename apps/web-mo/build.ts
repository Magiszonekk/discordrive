// Build dist/: ui.js, worker.js, sw.js (ESM bundles), sqlite3.wasm, index.html, nordic/ (style),
// build-stamp.json (hash of the sources; `discordrive start` rebuilds when it no longer matches).
import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHash, STAMP_FILE } from "./source-hash.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
// Hash first: a file edited during the build makes the next start rebuild again (never the other way round).
const hash = sourceHash();
mkdirSync(out, { recursive: true });
const common = { bundle: true, platform: "browser" as const, format: "esm" as const, target: "es2022", logLevel: "error" as const, sourcemap: false };
await build({ ...common, entryPoints: { ui: join(here, "src/ui.ts"), worker: join(here, "src/worker.ts") }, outdir: out });
await build({ ...common, format: "iife", entryPoints: { sw: join(here, "src/sw.ts") }, outdir: out });
copyFileSync(createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"), join(out, "sqlite3.wasm"));
copyFileSync(join(here, "index.html"), join(out, "index.html"));
// Look: nordic tokens, theme.js and local fonts (see nordic/README.md).
cpSync(join(here, "nordic"), join(out, "nordic"), { recursive: true });
writeFileSync(join(out, STAMP_FILE), JSON.stringify({ hash, builtAt: new Date().toISOString() }) + "\n");
console.log("built", out);
