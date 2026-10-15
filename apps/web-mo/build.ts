// Build dist/<mode>/: ui.js, w/worker.js, sw.js, w/sw.js (ESM / IIFE bundles), sqlite3.wasm, index.html, cobalt/ (style),
// build-stamp.json (hash of the sources; `discordrive start` rebuilds when it no longer matches).
//
// The mode is fixed at build time (koncept §2, docs/stage3-modes.md §2): app-core imports the
// virtual module `ddn:mode`, which this plugin resolves to src/modes/<mode>.ts. The files of the
// other modes are never read, so their code cannot end up in the bundle (mode-bundles test).
//
//   tsx build.ts                 every mode (dist/metadata-only, dist/e2ee, dist/plain)
//   tsx build.ts e2ee            one mode
//   DDN_MODE=e2ee tsx build.ts   same
//   tsx build.ts e2ee <outRoot>  into <outRoot>/e2ee instead of dist/e2ee (tests and check.ts: the
//                                previews of all three modes run from this checkout and serve dist/<mode>,
//                                so a test build must never replace what they serve)
import { build, type Plugin } from "esbuild";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceHash, STAMP_FILE } from "./source-hash.js";

export const MODES = ["metadata-only", "e2ee", "plain"] as const;
export type Mode = (typeof MODES)[number];

const here = dirname(fileURLToPath(import.meta.url));

/** Text variants of a mode: plain falls back to e2ee (same server role), then to the base text. */
const CHAIN: Record<Mode, string[]> = { "metadata-only": [""], e2ee: ["@e2ee", ""], plain: ["@plain", "@e2ee", ""] };

/** One dictionary as this mode shows it: base keys only, each with the variant the mode would pick. */
export function resolveTexts(dict: Record<string, string>, mode: Mode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(dict)) {
    if (k.includes("@")) continue;
    for (const suf of CHAIN[mode]) {
      const v = dict[k + suf];
      if (v !== undefined) {
        out[k] = v;
        break;
      }
    }
  }
  return out;
}

function modePlugin(mode: Mode): Plugin {
  return {
    name: "ddn-mode",
    setup(b) {
      b.onResolve({ filter: /^ddn:mode$/ }, () => ({ path: join(here, "src", "modes", `${mode}.ts`) }));
      // Texts: the bundle of a mode carries only the texts that mode shows (a plain bundle has no e2ee or
      // metadata-only wording at all; the mode-texts test greps it), resolved here at build time.
      b.onLoad({ filter: /[\\/]src[\\/]locales[\\/](en|pl)\.ts$/ }, async (a) => {
        const lang = a.path.endsWith("en.ts") ? "en" : "pl";
        const m = (await import(pathToFileURL(a.path).href)) as Record<string, Record<string, string>>;
        return { contents: `export const ${lang} = ${JSON.stringify(resolveTexts(m[lang]!, mode))};`, loader: "js" };
      });
    },
  };
}

export async function buildMode(mode: Mode, outRoot = join(here, "dist")): Promise<string> {
  if (!existsSync(join(here, "src", "modes", `${mode}.ts`))) throw new Error(`mode ${mode}: not available yet`);
  const out = join(outRoot, mode);
  // Hash first: a file edited during the build makes the next start rebuild again (never the other way round).
  const hash = sourceHash();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const common = {
    bundle: true,
    platform: "browser" as const,
    format: "esm" as const,
    target: "es2022",
    logLevel: "error" as const,
    sourcemap: false,
    define: { __DDN_MODE__: JSON.stringify(mode) },
    plugins: [modePlugin(mode)],
  };
  await build({ ...common, entryPoints: { ui: join(here, "src/ui.ts") }, outdir: out });
  // The app worker lives under /w/, outside the scope of /sw.js (see sw.ts and src/w-sw.ts): requests of a
  // client a service worker controls keep their upload bodies in Chromium's browser process.
  await build({ ...common, entryPoints: { worker: join(here, "src/worker.ts") }, outdir: join(out, "w") });
  await build({ ...common, format: "iife", entryPoints: { sw: join(here, "src/sw.ts") }, outdir: out });
  await build({ ...common, format: "iife", entryPoints: { sw: join(here, "src/w-sw.ts") }, outdir: join(out, "w") });
  // Second connection to the CDN (src/lane.ts, zlecenie 2026-10-15-transfery §1): a page for a sandboxed iframe.
  await build({ ...common, format: "iife", entryPoints: { lane: join(here, "src/lane.ts") }, outdir: out });
  writeFileSync(join(out, "lane.html"), '<!doctype html><meta charset="utf-8"><title>lane</title><script src="/lane.js"></script>\n');
  copyFileSync(createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"), join(out, "sqlite3.wasm"));
  copyFileSync(join(here, "index.html"), join(out, "index.html"));
  // Look: Cobalt (discordrive) tokens, app CSS, theme.js and local fonts (see cobalt/README.md).
  cpSync(join(here, "cobalt"), join(out, "cobalt"), { recursive: true });
  writeFileSync(join(out, STAMP_FILE), JSON.stringify({ hash, mode, builtAt: new Date().toISOString() }) + "\n");
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const want = (process.argv[2] ?? process.env.DDN_MODE ?? "all") as Mode | "all";
  const list = want === "all" ? MODES.filter((m) => existsSync(join(here, "src", "modes", `${m}.ts`))) : [want];
  const outRoot = process.argv[3];
  for (const m of list) {
    if (!MODES.includes(m as Mode)) throw new Error(`unknown mode ${m} (${MODES.join(", ")})`);
    console.log("built", await buildMode(m as Mode, outRoot));
  }
  if (outRoot) process.exit(0);
  // Builds from before stage 3 put the files straight in dist/: drop them, nothing serves them now.
  for (const f of ["ui.js", "worker.js", "sw.js", "sqlite3.wasm", "index.html", STAMP_FILE]) rmSync(join(here, "dist", f), { force: true });
  for (const d of ["cobalt", "nordic"]) rmSync(join(here, "dist", d), { recursive: true, force: true });
}
