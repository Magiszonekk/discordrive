// The Speed test button's code (AppCore.speedTest) in Node, as the desktop agent runs it, against REAL
// webhooks of a test server: the numbers to compare with conn-bench / live-transfer-bench on the same channels.
//   node --import tsx --import ./apps/desktop/test/mode-hook.mjs scripts/speed-test-bench.mts webhooks.txt [--count 32] [--size 10] [--no-line]
// Prints the result JSON (no webhook tokens or CDN links). Every test message is deleted by the test itself.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DdnServer, h2Fetch } from "@ddv4/metadata-client/node";
import { AppCore } from "../apps/web-mo/src/app-core.js";
import { nodePlatform } from "../apps/desktop/src/agent/node-platform.js";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1]! : d;
};
const file = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!file) throw new Error("usage: speed-test-bench.mts webhooks.txt [--count 32] [--size 10] [--no-line]");
const hooks = readFileSync(file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "speed-bench-"));
const srv = new DdnServer({ rateLimits: false, signup: "open" });
const { url } = await srv.listen(0);
const f = h2Fetch({});
const core = new AppCore({}, nodePlatform({ dataDir: join(work, "agent"), downloadsDir: join(work, "dl"), discordFetch: f, cdnLanes: [f.onLane(1)] }));
await core.createAccount(url, "speed bench");
await core.open();
for (const h of hooks) await core.addWebhook(h);
const t0 = Date.now();
let last = "";
core.onEvent = (e) => {
  if (e.type !== "speed-progress") return;
  const s = `${e.p.stage}`;
  if (s !== last) console.error(`[speed] ${s} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  last = s;
};
const r = await core.speedTest({ count: Number(arg("count", "32")), sizeMb: Number(arg("size", "10")), noLine: argv.includes("--no-line") });
console.log(JSON.stringify({ wallS: (Date.now() - t0) / 1000, ...r }, null, 1));
await srv.close();
process.exit(0);
