// Build dist/<mode>/server-mode.mjs: the mode-specific part of the instance (modes/<mode>.ts +
// what only it needs, e.g. @ddv4/server-discord for e2ee/plain). The other modes' files are
// never read. Workspace packages the whole server shares stay external, so the process has ONE
// DdnServer/HttpError (instanceof checks) and the TypeScript sources still run through tsx.
//   tsx build-server.ts [mode|all]
import { build, type Plugin } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_MODES = ["metadata-only", "e2ee", "plain"] as const;
export type ServerModeName = (typeof SERVER_MODES)[number];
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
export const SERVER_DIST = join(here, "dist");
const STAMP = "build-stamp.json";
/** Shared by every mode: never bundled into a mode file. */
const SHARED = ["@ddv4/metadata-client", "@ddv4/metadata-client/node", "@ddv4/sync-core", "@ddv4/processing", "@ddv4/config"];

const INPUTS = ["apps/ddn-server/src/modes", "apps/ddn-server/build-server.ts", "packages/server-discord/src", "package-lock.json"];

export function serverSourceHash(): string {
  const files: string[] = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) for (const e of readdirSync(p).sort()) walk(join(p, e));
    else files.push(p);
  };
  for (const i of INPUTS) walk(join(repo, i));
  const h = createHash("sha256");
  for (const f of files) h.update(relative(repo, f).replaceAll("\\", "/")).update("\0").update(readFileSync(f)).update("\0");
  return h.digest("hex").slice(0, 32);
}

export function serverModeFile(mode: string): string {
  return join(SERVER_DIST, mode, "server-mode.mjs");
}

export function serverModeState(mode: string): "ok" | "missing" | "stale" {
  if (!existsSync(serverModeFile(mode))) return "missing";
  try {
    const s = JSON.parse(readFileSync(join(SERVER_DIST, mode, STAMP), "utf8")) as { hash?: string; mode?: string };
    return s.hash === serverSourceHash() && s.mode === mode ? "ok" : "stale";
  } catch {
    return "stale";
  }
}

const sharedExternal: Plugin = {
  name: "ddn-shared-external",
  setup(b) {
    b.onResolve({ filter: /^@ddv4\// }, (a) => (SHARED.includes(a.path) ? { path: a.path, external: true } : undefined));
    // A mode file must not pull the instance's own modules (i18n state, config) into its bundle:
    // it gets what it needs as arguments. Type-only imports are erased and never reach here.
    b.onResolve({ filter: /^\.\.\// }, (a) =>
      a.importer.includes(`${"modes"}`) ? { errors: [{ text: `mode files may not import ${a.path} (pass it in as an argument)` }] } : undefined,
    );
  },
};

export async function buildServerMode(mode: ServerModeName): Promise<string> {
  const entry = join(here, "src", "modes", `${mode}.ts`);
  if (!existsSync(entry)) throw new Error(`mode ${mode}: not available yet`);
  const out = join(SERVER_DIST, mode);
  const hash = serverSourceHash();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [entry],
    outfile: serverModeFile(mode),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "error",
    packages: "bundle",
    external: ["node:*"],
    plugins: [sharedExternal],
    banner: { js: `// discordrive-next instance, mode ${mode} (built ${new Date().toISOString()})` },
  });
  writeFileSync(join(out, STAMP), JSON.stringify({ hash, mode, builtAt: new Date().toISOString() }) + "\n");
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const want = process.argv[2] ?? "all";
  const list = want === "all" ? SERVER_MODES.filter((m) => existsSync(join(here, "src", "modes", `${m}.ts`))) : [want as ServerModeName];
  for (const m of list) console.log("built", await buildServerMode(m));
}
