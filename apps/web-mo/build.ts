// Build dist/: ui.js, worker.js, sw.js (ESM bundles), sqlite3.wasm, index.html, nordic/ (style).
import { build } from "esbuild";
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
mkdirSync(out, { recursive: true });
const common = { bundle: true, platform: "browser" as const, format: "esm" as const, target: "es2022", logLevel: "error" as const, sourcemap: false };
await build({ ...common, entryPoints: { ui: join(here, "src/ui.ts"), worker: join(here, "src/worker.ts") }, outdir: out });
await build({ ...common, format: "iife", entryPoints: { sw: join(here, "src/sw.ts") }, outdir: out });
copyFileSync(createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"), join(out, "sqlite3.wasm"));
copyFileSync(join(here, "index.html"), join(out, "index.html"));
// Look: nordic tokens, theme.js and local fonts (see nordic/README.md).
cpSync(join(here, "nordic"), join(out, "nordic"), { recursive: true });
console.log("built", out);
