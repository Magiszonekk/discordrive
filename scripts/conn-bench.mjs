#!/usr/bin/env node
// Connection benchmark (koncept §7.5.4, owner 2026-10-15): is the browser's speed limit the single
// HTTP/2 connection it uses for every request to discord.com / cdn.discordapp.com?
//
// Runs on the user's own computer (Node 22+, no dependencies), with the user's own webhooks, and
// compares the same work over:
//   h2-1  one HTTP/2 connection for everything            (what a browser does)
//   h2-N  one HTTP/2 connection per lane (N connections)  (what a desktop agent could do)
//   h1-N  HTTP/1.1, N parallel sockets                    (what the discordrive server does)
// For each: upload COUNT fragments (random bytes) through the webhooks, then download them from
// the CDN, then delete the messages again. Tokens and URLs are never printed or saved.
//
//   node scripts/conn-bench.mjs webhooks.txt [--count 30] [--conc 24] [--size 10]
//        [--scenarios h2-1,h2-N,h1-N] [--pause 30] [--no-download] [--keep]
//
// webhooks.txt: one webhook URL per line (one webhook per Discord channel; several webhooks in one
// channel share its limit). Upload traffic per scenario = count × size MiB.

import http2 from "node:http2";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// ── arguments ───────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const COUNT = Number(opt("count", 30));
const CONC = Number(opt("conc", 24));
const SIZE = Math.round(Number(opt("size", 10)) * 1024 * 1024) - 28; // like the app: 10 MiB - 28 B
const SCENARIOS = String(opt("scenarios", "h2-1,h2-N,h1-N")).split(",").map((s) => s.trim()).filter(Boolean);
const PAUSE_S = Number(opt("pause", 30));
const NO_DOWNLOAD = flag("no-download");
const KEEP = flag("keep");
const NO_SPEEDTEST = flag("no-speedtest");
const file = argv[0];
if (!file || flag("help")) {
  console.log("usage: node scripts/conn-bench.mjs webhooks.txt [--count 30] [--conc 24] [--size 10] [--scenarios h2-1,h2-N,h1-N] [--pause 30] [--no-download] [--keep] [--no-speedtest]");
  process.exit(file ? 0 : 2);
}
const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  console.error(`Node 22 or newer needed (you have ${process.versions.node}).`);
  process.exit(2);
}

const WEBHOOK_RE = /https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/[A-Za-z0-9_.-]+/g;
const hooks = [...new Set(readFileSync(file, "utf8").match(WEBHOOK_RE) ?? [])].map((url) => ({ url, id: url.split("/").at(-2), channel: null }));
if (!hooks.length) {
  console.error("No webhook URLs found in the file.");
  process.exit(2);
}

// ── helpers ─────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mb = (b) => b / 1e6;
const UA = "DiscordBot (discordrive-next conn-bench, 1)";
let goaways = 0;
/** Why requests failed: "HTTP 503", "ERR_HTTP2_GOAWAY_SESSION", … (no URLs, no tokens). */
const failReasons = new Map();
const noteFail = (r) => {
  // For HTTP/2 stream errors the message carries the RST_STREAM code (e.g. NGHTTP2_REFUSED_STREAM).
  const e = r.err;
  const code = e?.code === "ERR_HTTP2_STREAM_ERROR" ? `${e.code} (${String(e.message).replace(/^.*code /, "")})` : e?.code || e?.message;
  const k = r.status ? `HTTP ${r.status}` : String(code || "network error").slice(0, 100);
  failReasons.set(k, (failReasons.get(k) ?? 0) + 1);
};

/** HTTP/1.1 request on an agent: { status, headers, body, ttfb, dur } */
function h1(agent, url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = now();
    let ttfb = 0;
    const req = https.request(url, { method, agent, headers: { "user-agent": UA, ...headers } }, (res) => {
      ttfb = now() - t0;
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ttfb, dur: now() - t0 }));
      res.on("error", reject);
    });
    req.setTimeout(120_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/** HTTP/2 sessions to one origin; lane i uses session i % n. Windows sized like Chromium's. */
class H2 {
  constructor(origin, n) {
    this.origin = origin;
    this.n = n;
    this.sessions = new Array(n).fill(null);
  }
  session(i) {
    const k = i % this.n;
    let s = this.sessions[k];
    if (!s || s.closed || s.destroyed || s.dead) {
      s = http2.connect(this.origin, { settings: { initialWindowSize: 6 * 1024 * 1024 } });
      const fresh = s;
      fresh.on("error", () => (fresh.dead = true));
      fresh.on("goaway", () => {
        fresh.dead = true;
        goaways++;
      });
      fresh.on("close", () => (fresh.dead = true));
      s.on("connect", () => {
        try {
          s.setLocalWindowSize(15 * 1024 * 1024);
        } catch {}
      });
      this.sessions[k] = s;
    }
    return s;
  }
  request(lane, url, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const t0 = now();
      let ttfb = 0;
      let status = 0;
      let hdrs = {};
      const sess = this.session(lane);
      let req;
      try {
        req = sess.request({ ":method": method, ":path": u.pathname + u.search, "user-agent": UA, ...headers });
      } catch (e) {
        sess.dead = true;
        return reject(e);
      }
      req.on("close", () => {
        if (req.rstCode && req.rstCode !== http2.constants.NGHTTP2_NO_ERROR && !status) reject(new Error(`stream reset (code ${req.rstCode})`));
      });
      req.setTimeout(120_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on("response", (h) => {
        ttfb = now() - t0;
        status = Number(h[":status"]);
        hdrs = h;
      });
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve({ status, headers: hdrs, body: Buffer.concat(chunks), ttfb, dur: now() - t0 }));
      req.on("error", reject);
      req.end(body);
    });
  }
  close() {
    for (const s of this.sessions) s?.close();
  }
}

/** One transport per scenario: request(lane, url, init). */
function transport(kind, origin) {
  if (kind === "h2-1") {
    const p = new H2(origin, 1);
    return { request: (lane, url, init) => p.request(lane, url, init), close: () => p.close() };
  }
  if (kind === "h2-N") {
    const p = new H2(origin, CONC);
    return { request: (lane, url, init) => p.request(lane, url, init), close: () => p.close() };
  }
  if (kind === "h1-N") {
    const agent = new https.Agent({ keepAlive: true, maxSockets: CONC });
    return { request: (_lane, url, init) => h1(agent, url, init), close: () => agent.destroy() };
  }
  throw new Error(`unknown scenario ${kind}`);
}

// Per-channel pacing like the app (koncept §7: ~30 posts/min per channel, small burst).
const buckets = new Map();
async function takeToken(channel) {
  let b = buckets.get(channel);
  if (!b) buckets.set(channel, (b = { tokens: 4, last: now() }));
  for (;;) {
    const t = now();
    b.tokens = Math.min(4, b.tokens + ((t - b.last) * 30) / 60_000);
    b.last = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    await sleep(((1 - b.tokens) * 60_000) / 30 + 5);
  }
}

function multipart(bytes) {
  const boundary = "----ddnbench" + randomBytes(8).toString("hex");
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="bench.txt"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), type: `multipart/form-data; boundary=${boundary}` };
}

async function retry429(fn, stats) {
  for (let attempt = 0; ; attempt++) {
    const r = await fn().catch((e) => ({ status: 0, err: e }));
    if (r.status === 429) {
      stats.n429++;
      let wait = 1000;
      try {
        wait = Math.ceil(Number(JSON.parse(r.body.toString()).retry_after) * 1000) || 1000;
      } catch {}
      await sleep(Math.min(wait, 60_000) + 50);
      continue;
    }
    if (r.status !== 200 && r.status !== 204) noteFail(r);
    if ((r.status === 0 || r.status >= 500) && attempt < 3) {
      stats.retries++;
      await sleep(1000 * (attempt + 1));
      continue;
    }
    return r;
  }
}

/** Run tasks with CONC workers; each worker is a lane (its own connection in h2-N). */
async function runPool(tasks, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONC, tasks.length) }, async (_, lane) => {
      for (;;) {
        const i = next++;
        if (i >= tasks.length) return;
        await worker(tasks[i], lane);
      }
    }),
  );
}

// ── the benchmark ───────────────────────────────────────────────────
const posted = []; // { hook, messageId } for cleanup
let rr = 0;

async function upload(kind) {
  const t = transport(kind, "https://discord.com");
  const stats = { kind, dir: "up", n: 0, bytes: 0, durs: [], ttfbs: [], n429: 0, retries: 0, errors: 0, t0: 0, t1: 0 };
  const results = [];
  const tasks = Array.from({ length: COUNT }, (_, i) => i);
  stats.t0 = now();
  await runPool(tasks, async (_i, lane) => {
    const hook = hooks[rr++ % hooks.length];
    await takeToken(hook.channel);
    const { body, type } = multipart(randomBytes(SIZE));
    const r = await retry429(() => t.request(lane, `${hook.url}?wait=true`, { method: "POST", headers: { "content-type": type, "content-length": String(body.length) }, body }), stats);
    if (r.status !== 200) {
      stats.errors++;
      return;
    }
    const j = JSON.parse(r.body.toString());
    posted.push({ hook, messageId: j.id });
    results.push({ url: j.attachments?.[0]?.url, size: j.attachments?.[0]?.size });
    stats.n++;
    stats.bytes += SIZE;
    stats.durs.push(r.dur);
    stats.ttfbs.push(r.ttfb);
  });
  stats.t1 = now();
  t.close();
  return { stats, results };
}

async function download(kind, items) {
  const t = transport(kind, "https://cdn.discordapp.com");
  const stats = { kind, dir: "down", n: 0, bytes: 0, durs: [], ttfbs: [], n429: 0, retries: 0, errors: 0, t0: 0, t1: 0 };
  stats.t0 = now();
  await runPool(items.filter((x) => x.url), async (it, lane) => {
    const r = await retry429(() => t.request(lane, it.url), stats);
    if (r.status !== 200 || r.body.length !== it.size) {
      stats.errors++;
      return;
    }
    stats.n++;
    stats.bytes += r.body.length;
    stats.durs.push(r.dur);
    stats.ttfbs.push(r.ttfb);
  });
  stats.t1 = now();
  t.close();
  return stats;
}

async function cleanup() {
  if (KEEP || !posted.length) return;
  process.stdout.write(`Deleting ${posted.length} test messages… `);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 2 });
  const stats = { n429: 0, retries: 0 };
  let left = 0;
  const list = posted.splice(0);
  await runPoolN(list, 2, async (p) => {
    const r = await retry429(() => h1(agent, `${p.hook.url}/messages/${p.messageId}`, { method: "DELETE" }), stats);
    if (r.status !== 204 && r.status !== 404) left++;
  });
  agent.destroy();
  console.log(left ? `${left} could not be deleted (delete them in Discord by hand).` : "done.");
}
async function runPoolN(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }));
}

function row(s) {
  const wall = (s.t1 - s.t0) / 1000;
  return {
    scenario: s.kind,
    dir: s.dir,
    ok: `${s.n}/${s.dir === "up" ? COUNT : s.n + s.errors}`,
    "MB/s": wall ? +(mb(s.bytes) / wall).toFixed(1) : 0,
    "Mb/s": wall ? Math.round((mb(s.bytes) * 8) / wall) : 0,
    "% of line": line && wall && (s.dir === "up" ? line.upMBps : line.downMBps) > 0 ? Math.round((100 * mb(s.bytes)) / wall / (s.dir === "up" ? line.upMBps : line.downMBps)) : null,
    "time s": +wall.toFixed(1),
    "req p50 s": +(pct(s.durs, 50) / 1000).toFixed(2),
    "req p90 s": +(pct(s.durs, 90) / 1000).toFixed(2),
    "1st byte p50 s": +(pct(s.ttfbs, 50) / 1000).toFixed(2),
    "MB/s per req": s.durs.length ? +(mb(SIZE) / (pct(s.durs, 50) / 1000)).toFixed(2) : 0,
    retries: s.retries,
    errors: s.errors,
    "n429": s.n429,
  };
}

let interrupted = false;
process.on("SIGINT", async () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log("\nInterrupted — cleaning up (Ctrl+C again to quit without cleanup).");
  await cleanup();
  process.exit(130);
});

// ── line speed first (Cloudflare speed test, like speed.cloudflare.com): N parallel streams ~8 s
// each way, so the Discord numbers below can be compared with what the line itself does now.
async function speedtest(dir, streams = 8, seconds = 8) {
  const end = now() + seconds * 1000;
  let bytes = 0;
  const t0 = now();
  const chunk = new Uint8Array(25_000_000);
  await Promise.all(
    Array.from({ length: streams }, async () => {
      while (now() < end) {
        try {
          if (dir === "down") {
            const r = await fetch("https://speed.cloudflare.com/__down?bytes=25000000", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(Math.max(1000, Math.ceil(end - now()))) });
            if (!r.ok) break; // the speed test refused (e.g. too large a request): stop this stream
            for await (const c of r.body) {
              bytes += c.length;
              if (now() >= end) break;
            }
          } else {
            const tq = now();
            const r = await fetch("https://speed.cloudflare.com/__up", { method: "POST", body: chunk, headers: { "user-agent": UA, "content-type": "application/octet-stream" }, signal: AbortSignal.timeout(60_000) });
            await r.arrayBuffer();
            if (r.ok) bytes += chunk.length;
            if (now() - tq > 30_000) break;
          }
        } catch {
          /* timeout at the end of the window, or a network error: stop this stream */
          if (dir === "down") break;
        }
      }
    }),
  );
  return { MBps: mb(bytes) / ((now() - t0) / 1000) };
}

// Validate the webhooks (GET returns the channel, no message is sent).
{
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  const stats = { n429: 0, retries: 0 };
  await runPoolN(hooks, 4, async (h) => {
    const r = await retry429(() => h1(agent, h.url), stats);
    if (r.status !== 200) throw new Error(`webhook …${h.id.slice(-6)}: HTTP ${r.status}`);
    h.channel = JSON.parse(r.body.toString()).channel_id;
  });
  agent.destroy();
}
const channels = new Set(hooks.map((h) => h.channel));
console.log(`Webhooks: ${hooks.length}, channels: ${channels.size}${channels.size < hooks.length ? " (some webhooks share a channel and its limit)" : ""}`);
console.log(`Per scenario: ${COUNT} × ${(SIZE / 1024 / 1024).toFixed(1)} MiB, ${CONC} in flight; scenarios: ${SCENARIOS.join(", ")}${NO_DOWNLOAD ? " (upload only)" : ""}`);
console.log(`Discord limit for ${channels.size} channels ≈ ${(channels.size * 30 * SIZE / 60 / 1e6).toFixed(0)} MB/s sustained (after a short burst).\n`);

let line = null;
if (!NO_SPEEDTEST) {
  process.stdout.write("Line speed (speed.cloudflare.com, 8 streams, ~8 s each way): ");
  const d = await speedtest("down");
  const u = await speedtest("up");
  line = { downMBps: +d.MBps.toFixed(1), upMBps: +u.MBps.toFixed(1) };
  console.log(`download ${line.downMBps} MB/s (${Math.round(line.downMBps * 8)} Mb/s), upload ${line.upMBps} MB/s (${Math.round(line.upMBps * 8)} Mb/s)\n`);
}

const rows = [];
const upSets = [];
try {
  for (const [k, sc] of SCENARIOS.entries()) {
    if (k) {
      process.stdout.write(`(pause ${PAUSE_S} s so Discord's limits refill)\n`);
      await sleep(PAUSE_S * 1000);
    }
    process.stdout.write(`upload   ${sc} … `);
    const u = await upload(sc);
    rows.push(row(u.stats));
    upSets.push(u.results);
    console.log(`${rows.at(-1)["MB/s"]} MB/s`);
  }
  if (!NO_DOWNLOAD) {
    // Each download scenario reads a different set (the CDN would cache a set read twice).
    for (const [k, sc] of SCENARIOS.entries()) {
      process.stdout.write(`download ${sc} … `);
      const d = await download(sc, upSets[k]);
      rows.push(row(d));
      console.log(`${rows.at(-1)["MB/s"]} MB/s`);
    }
  }
} finally {
  console.log("");
  console.table(rows);
  if (failReasons.size || goaways) {
    console.log(`Failed attempts by reason: ${[...failReasons].map(([k, n]) => `${k} × ${n}`).join(", ") || "none"}; HTTP/2 GOAWAY received: ${goaways}`);
  }
  const out = `conn-bench-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), node: process.versions.node, platform: process.platform, webhooks: hooks.length, channels: channels.size, count: COUNT, conc: CONC, sizeBytes: SIZE, line, rows, failReasons: Object.fromEntries(failReasons), goaways }, null, 1));
  console.log(`Saved ${out} (no tokens or URLs in it).`);
  await cleanup();
}
