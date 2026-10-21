// Starts the built app hidden with DDN_DESKTOP_SMOKE and checks the report it writes (see main.ts smoke()).
// Linux CI runs it under xvfb-run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)("electron") as unknown as string;
const dir = mkdtempSync(join(tmpdir(), "ddn-desktop-smoke-"));
const out = join(dir, "report.json");
const args = [join(here, "..")];
// CI containers without user namespaces cannot start Chromium's sandbox for the GPU/utility helpers.
if (process.env.DDN_DESKTOP_NO_SANDBOX) args.push("--no-sandbox");
const r = spawnSync(electron, args, {
  env: { ...process.env, DDN_DESKTOP_SMOKE: out, DDN_DESKTOP_HIDDEN: "1", DDN_DESKTOP_DATA: join(dir, "data") },
  stdio: "inherit",
  timeout: 90_000,
});
if (!existsSync(out)) {
  console.error("no report; exit", r.status, r.signal, r.error);
  process.exit(1);
}
const report = JSON.parse(readFileSync(out, "utf8")) as { ok: boolean };
console.log(JSON.stringify(report, null, 1));
process.exit(report.ok ? 0 : 1);
