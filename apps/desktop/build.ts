// Build of the desktop app: main process, preload and agent bundled to CommonJS for Electron, plus the
// static pages. Output: dist/ (package.json "main" points at dist/main.cjs).
//   tsx build.ts
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const common = { bundle: true, platform: "node" as const, format: "cjs" as const, target: "node22", external: ["electron"], logLevel: "error" as const, sourcemap: false };
await build({ ...common, entryPoints: { main: join(here, "src/main.ts"), agent: join(here, "src/agent.ts") }, outdir: out, outExtension: { ".js": ".cjs" } });
// The preload runs sandboxed: one file, only `electron` may be required.
await build({ ...common, entryPoints: { preload: join(here, "src/preload.ts") }, outdir: out, outExtension: { ".js": ".cjs" } });
cpSync(join(here, "static"), join(out, "static"), { recursive: true });
console.log("built", out);
