// Transfer benchmark of the desktop agent against REAL Discord webhooks (a test server, one webhook per
// channel): the same core and transport the desktop app runs (AppCore on the desktop platform, h2Fetch),
// with a local metadata-only instance in this process. Uploads a file of --mb MB generated on disk, downloads
// it back to disk, checks the SHA-256, and writes the transfer log + report. Compare with conn-bench on the
// same line (what Node can do at all) and with live-transfer-bench (the browser).
//
//   node --import tsx --import ./apps/desktop/test/mode-hook.mjs scripts/desktop-bench.mts webhooks.txt [--mb 2000] [--out dir] [--label x] [--speedtest]
//        [--up-sessions 6] [--up-streams 6] [--conc up,down] [--keep]
// --conc 32,32: fixed fragments in flight (Settings → Diagnostics) instead of the automatic value, which
// starts low on a new device and climbs while it measures (a short file ends before it gets there).
//
// Every posted message is deleted at the end unless --keep. No webhook tokens or CDN links in the output.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DdnServer, h2Fetch } from "@ddv4/metadata-client/node";
import { buildReport, parseLines } from "@ddv4/metadata-client/transfer-report";
import { AppCore } from "../apps/web-mo/src/app-core.js";
import { nodePlatform } from "../apps/desktop/src/agent/node-platform.js";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1]! : d;
};
const file = argv.find((a: string, i: number) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!file) {
  console.error("usage: node --import tsx --import ./apps/desktop/test/mode-hook.mjs scripts/desktop-bench.mts webhooks.txt [--mb 2000] [--out dir] [--label x] [--speedtest]");
  process.exit(2);
}
const MB = Number(arg("mb", "2000"));
const LABEL = arg("label", "agent");
const OUT = arg("out", "") || mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "desktop-bench-"));
mkdirSync(OUT, { recursive: true });
const hooks = readFileSync(file, "utf8").split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean);

async function speedtest(): Promise<{ down: number; up: number }> {
  // speed.cloudflare.com, 8 streams each way for ~8 s (same as live-transfer-bench).
  const run = async (up: boolean) => {
    const t0 = Date.now();
    let bytes = 0;
    const end = t0 + 8000;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (Date.now() < end) {
          if (up) {
            const body = randomBytes(25_000_000);
            const r = await fetch("https://speed.cloudflare.com/__up", { method: "POST", body }).catch(() => null);
            if (r?.ok) bytes += body.length;
          } else {
            const r = await fetch("https://speed.cloudflare.com/__down?bytes=50000000").catch(() => null);
            if (r?.ok) bytes += (await r.arrayBuffer()).byteLength;
          }
        }
      }),
    );
    return bytes / ((Date.now() - t0) / 1000) / 1e6;
  };
  return { down: await run(false), up: await run(true) };
}

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "desktop-bench-work-"));
const srcPath = join(work, `bench-${MB}MB.bin`);
// The file on disk, written in 16 MiB blocks (never whole in memory).
{
  const fd = openSync(srcPath, "w");
  let left = MB * 1e6;
  while (left > 0) {
    const n = Math.min(left, 16 << 20);
    writeSync(fd, randomBytes(n));
    left -= n;
  }
  closeSync(fd);
}
const sha = async (p: string) => {
  const h = createHash("sha256");
  for await (const c of createReadStream(p)) h.update(c as Buffer);
  return h.digest("hex");
};
const want = await sha(srcPath);

const line = argv.includes("--speedtest") ? await speedtest() : null;
const srv = new DdnServer({ rateLimits: false, signup: "open" });
const { url } = await srv.listen(0);
const events: string[] = [];
const f = h2Fetch({
  upSessions: Number(arg("up-sessions", "6")),
  upStreams: Number(arg("up-streams", "6")),
  onEvent: (e) => events.push(`${e.ev} ${e.role} ${e.lane}${"why" in e ? ` ${e.why}` : ""}${"cap" in e ? ` cap ${e.cap}` : ""}`),
});
const dl = join(work, "dl");
const p = nodePlatform({ dataDir: join(work, "agent"), downloadsDir: dl, discordFetch: f, cdnLanes: [f.onLane(1)] });
const core = new AppCore({}, p);
await core.createAccount(url, "desktop bench");
await core.open();
for (const h of hooks) await core.addWebhook(h);
await core.setTransferLog(true, false);
const conc = arg("conc", "");
if (conc) {
  const [u, d] = conc.split(",").map(Number);
  core.setConcurrency(u || null, d || null);
}

const t0 = Date.now();
const up = await core.uploadPaths([srcPath]);
const upMs = Date.now() - t0;
const node = core.list().rows.find((r) => r.name.startsWith("bench-"))!;
const t1 = Date.now();
const d = await core.downloadToDisk(node.id);
const downMs = Date.now() - t1;
const ok = (await sha(d.path)) === want;
const sessions = f.stats();

// Transfer log → report (the same analysis as `npm run transfer-report`).
const log = (await p.transferLog().text());
writeFileSync(join(OUT, `${LABEL}.jsonl`), log);
const parsed = parseLines(log);
const report = buildReport(parsed.events, { bucketS: 10, bad: parsed.bad }).text;
writeFileSync(join(OUT, `${LABEL}.report.txt`), report);

// Delete what was posted (the vault knows the messages through the client).
if (!argv.includes("--keep")) {
  await core.trash([node.id]).catch(() => null);
  await core.emptyTrash().catch(() => null);
  await core.cleanup(true).catch(() => null);
}
core.close();
f.close();
await srv.close();

const summary = {
  at: new Date().toISOString(),
  label: LABEL,
  node: process.versions.node,
  platform: process.platform,
  channels: hooks.length,
  mb: MB,
  conc: conc || "auto",
  line,
  upload: { MBps: +((MB * 1e6) / (upMs / 1000) / 1e6).toFixed(1), ms: upMs, files: up.files },
  download: { MBps: +((MB * 1e6) / (downMs / 1000) / 1e6).toFixed(1), ms: downMs },
  sha256Ok: ok,
  sessions: { up: sessions.filter((s) => s.role === "up").length, down: sessions.filter((s) => s.role === "down").length, caps: sessions.map((s) => s.cap) },
  sessionEvents: events.filter((e) => !e.startsWith("open")),
};
writeFileSync(join(OUT, `${LABEL}.json`), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log(`\nreport: ${join(OUT, `${LABEL}.report.txt`)}`);
rmSync(work, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
