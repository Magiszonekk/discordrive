// Build of `ddn` for release: one bundled file (dist/ddn.cjs) that runs on Node.js 22.13+ without the
// repository, and, with --sea, a single executable of the current system (Node's single executable
// applications: the bundle injected into a copy of the node binary).
//   npx tsx apps/cli/build.ts            → dist/ddn.mjs (the bundle) + dist/ddn.cjs (its launcher)
//   npx tsx apps/cli/build.ts --sea      → also dist/ddn-<os>-<arch>[.exe]
// DDN_VERSION / DDN_COMMIT as for the desktop app (CI: 0.1.<commits on main>, the head commit).
import { build, type Plugin } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildId, gitCommit, sourceHash } from "../web-mo/source-hash.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const VERSION = process.env.DDN_VERSION || (JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string }).version;
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) throw new Error(`DDN_VERSION must be x.y.z, got ${VERSION}`);
const COMMIT = process.env.DDN_COMMIT || gitCommit();
const BUILD = buildId(sourceHash(), COMMIT ? COMMIT.slice(0, 7) : null, VERSION);

// The core's `ddn:mode` is the command line's switch (all three modes in one program).
const modePlugin: Plugin = {
  name: "ddn-mode",
  setup(b) {
    b.onResolve({ filter: /^ddn:mode$/ }, () => ({ path: join(here, "src", "mode-switch.ts") }));
  },
};

// Step 1: an ES module bundle (the sources use top-level await and import.meta).
await build({
  entryPoints: [join(here, "src", "main.ts")],
  outfile: join(out, "ddn.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [modePlugin],
  define: { __DDN_BUILD__: JSON.stringify(BUILD) },
  // Bundled CommonJS dependencies call require(): give the module one.
  banner: { js: "import { createRequire as __ddnCreateRequire } from 'node:module'; const require = __ddnCreateRequire(import.meta.url);" },
  // Optional pieces the command line never loads (browser storage).
  external: ["@sqlite.org/sqlite-wasm"],
  logLevel: "error",
  legalComments: "none",
});
// Step 2: the launcher (CommonJS, as single executables need): quiets node:sqlite's warning, private file
// modes, then imports the bundle. As a file next to ddn.mjs it is `ddn.cjs`; inside an executable the bundle is
// an embedded asset written to a private temporary file first (a single executable can only run CommonJS).
const launcher = (embedded: boolean) => `#!/usr/bin/env node
"use strict";
{ const e = process.emitWarning; process.emitWarning = function (w, ...r) { if (String((w && w.message) || w).includes("SQLite is an experimental feature")) return; return e.call(process, w, ...r); }; }
if (process.platform !== "win32") process.umask(0o077);
${
  embedded
    ? `const { getAsset } = require("node:sea");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const code = Buffer.from(getAsset("ddn.mjs"));
const dir = path.join(os.tmpdir(), "ddn-" + (process.getuid ? process.getuid() : "u"));
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, "ddn-" + crypto.createHash("sha256").update(code).digest("hex").slice(0, 16) + ".mjs");
if (!fs.existsSync(file)) { const tmp = file + "." + process.pid; fs.writeFileSync(tmp, code, { mode: 0o600 }); fs.renameSync(tmp, file); }
import(require("node:url").pathToFileURL(file).href).catch((e) => { console.error(e); process.exit(1); });`
    : `import(require("node:url").pathToFileURL(require("node:path").join(__dirname, "ddn.mjs")).href).catch((e) => { console.error(e); process.exit(1); });`
}
`;
writeFileSync(join(out, "ddn.cjs"), launcher(false));
chmodSync(join(out, "ddn.cjs"), 0o755);
writeFileSync(join(out, "build-info.json"), JSON.stringify({ version: VERSION, build: BUILD, commit: COMMIT, builtAt: new Date().toISOString() }) + "\n");
console.log("built", join(out, "ddn.cjs"), BUILD);

if (process.argv.includes("--sea")) {
  // https://nodejs.org/api/single-executable-applications.html
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const exe = join(out, `ddn-${os}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);
  const cfg = join(out, "sea-config.json");
  const blob = join(out, "sea.blob");
  const main = join(out, "sea-main.cjs");
  writeFileSync(main, launcher(true));
  writeFileSync(cfg, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets: { "ddn.mjs": join(out, "ddn.mjs") } }));
  execFileSync(process.execPath, ["--experimental-sea-config", cfg], { stdio: "inherit" });
  copyFileSync(process.execPath, exe);
  if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", exe]);
  if (process.platform === "win32") {
    // A copy of a signed node.exe: drop the signature it no longer matches (signtool may be absent: then keep it).
    try {
      execFileSync("signtool", ["remove", "/s", exe], { stdio: "ignore" });
    } catch {
      /* not available */
    }
  }
  const postject = join(here, "..", "..", "node_modules", "postject", "dist", "cli.js");
  const args = [postject, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
  if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
  execFileSync(process.execPath, args, { stdio: "inherit" });
  if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", exe]);
  if (process.platform !== "win32") chmodSync(exe, 0o755);
  rmSync(cfg);
  rmSync(blob);
  rmSync(main);
  console.log("built", exe);
}
