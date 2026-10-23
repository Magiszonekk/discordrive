// Build of the desktop app into dist/: main process, preload, agent and built-in instance bundled to
// CommonJS for Electron; the start page (static/); the web app of every mode (web/<mode>/, the same build
// an instance serves). package.json "main" points at dist/main.cjs.
//   tsx build.ts             everything
//   tsx build.ts --no-web    keep dist/web from the last build (only the Electron side changed)
import { build, type Plugin } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMode, MODES } from "../web-mo/build.js";
import { buildId, gitCommit, sourceHash } from "../web-mo/source-hash.js";

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
// The same build ID the web app and an instance show (`<version>+<source hash>.g<commit>`): the agent writes it
// in its transfer logs and About / the update check read it from build-info.json.
// The package version grows with every build of main (dpkg, App Center and NSIS compare it): DDN_VERSION from CI
// (0.1.<commits on main>), else package.json's.
const VERSION = process.env.DDN_VERSION || (JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string }).version;
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) throw new Error(`DDN_VERSION must be x.y.z, got ${VERSION}`);
const COMMIT = process.env.DDN_COMMIT || gitCommit();
const BUILD = buildId(sourceHash(), COMMIT ? COMMIT.slice(0, 7) : null, VERSION);
const common = { bundle: true, platform: "node" as const, format: "cjs" as const, target: "node22", external: ["electron"], logLevel: "error" as const, sourcemap: false, plugins: [modePlugin], define: { __DDN_BUILD__: JSON.stringify(BUILD) } };
await build({ ...common, entryPoints: { main: join(here, "src/main.ts"), agent: join(here, "src/agent.ts"), "local-instance": join(here, "src/local-instance.ts") }, outdir: out, outExtension: { ".js": ".cjs" } });
// The preload runs sandboxed: one file, only `electron` may be required.
await build({ ...common, entryPoints: { preload: join(here, "src/preload.ts") }, outdir: out, outExtension: { ".js": ".cjs" } });
cpSync(join(here, "static"), join(out, "static"), { recursive: true });
if (!noWeb) for (const m of MODES) await buildMode(m, join(out, "web"), BUILD);
writeFileSync(join(out, "build-info.json"), JSON.stringify({ version: VERSION, build: BUILD, commit: COMMIT, builtAt: new Date().toISOString() }) + "\n");
console.log("built", out, BUILD);
