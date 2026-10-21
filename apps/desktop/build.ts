// Build of the desktop app into dist/: main process, preload, agent and built-in instance bundled to
// CommonJS for Electron; the start page (static/); the web app of every mode (web/<mode>/, the same build
// an instance serves). package.json "main" points at dist/main.cjs.
//   tsx build.ts             everything
//   tsx build.ts --no-web    keep dist/web from the last build (only the Electron side changed)
import { build, type Plugin } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMode, MODES } from "../web-mo/build.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const noWeb = process.argv.includes("--no-web");
for (const f of ["main.cjs", "agent.cjs", "local-instance.cjs", "preload.cjs", "static"]) rmSync(join(out, f), { recursive: true, force: true });
if (!noWeb) rmSync(join(out, "web"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/** The agent hosts the core of metadata only (the desktop app's first mode); the window loads the matching web build. */
const modePlugin: Plugin = {
  name: "ddn-mode",
  setup(b) {
    b.onResolve({ filter: /^ddn:mode$/ }, () => ({ path: join(here, "..", "web-mo", "src", "modes", "metadata-only.ts") }));
  },
};
const common = { bundle: true, platform: "node" as const, format: "cjs" as const, target: "node22", external: ["electron"], logLevel: "error" as const, sourcemap: false, plugins: [modePlugin] };
await build({ ...common, entryPoints: { main: join(here, "src/main.ts"), agent: join(here, "src/agent.ts"), "local-instance": join(here, "src/local-instance.ts") }, outdir: out, outExtension: { ".js": ".cjs" } });
// The preload runs sandboxed: one file, only `electron` may be required.
await build({ ...common, entryPoints: { preload: join(here, "src/preload.ts") }, outdir: out, outExtension: { ".js": ".cjs" } });
cpSync(join(here, "static"), join(out, "static"), { recursive: true });
if (!noWeb) for (const m of MODES) await buildMode(m, join(out, "web"));
writeFileSync(join(out, "build.json"), JSON.stringify({ builtAt: new Date().toISOString() }) + "\n");
console.log("built", out);
