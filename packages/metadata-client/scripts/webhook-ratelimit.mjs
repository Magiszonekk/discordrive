#!/usr/bin/env node
// Stage 0 leftover: webhook rate limits when several independent
// clients (browser tabs, CLI) upload through the same webhook.
//
// Each "client" is a separate OS process with its own state and no shared
// limiter, exactly like separate browser tabs. All run from one IP.
//
// Usage:
//   node webhook-ratelimit.mjs run <scenario-name> <durationSec> <payloadKiB> <mode> <hook>[,<hook>...]...
//     one positional group per client: a comma list = the client round-robins over those hooks
//     mode: naive   - send back to back, only wait on 429 (retry_after)
//           headers - also wait when x-ratelimit-remaining hits 0 (reset-after)
//           paced:<ms> - start one request every <ms> per client (plus naive 429 handling)
//   hook = name of ~/.config/discordrive-next/webhooks/<name>.url (URL is never printed)
//
// Output: one JSON summary per scenario on stdout, raw per-request log in
// $TMPDIR/ratelimit-<scenario>.jsonl (no URLs, no tokens).

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const HOOK_DIR = join(homedir(), ".config/discordrive-next/webhooks");
const MAX_429_PER_CLIENT = 60; // safety: never hammer Discord with a 429 storm

function hookUrl(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("bad hook name");
  return readFileSync(join(HOOK_DIR, `${name}.url`), "utf8").trim();
}

async function client(clientId, durationSec, payloadKiB, mode, hookNames) {
  const hooks = hookNames.map((n) => ({ name: n, url: hookUrl(n) }));
  const payload = randomBytes(payloadKiB * 1024);
  const end = Date.now() + durationSec * 1000;
  let n429 = 0;
  let i = 0;
  const waitUntil = new Map();
  while (Date.now() < end && n429 < MAX_429_PER_CLIENT) {
    const h = hooks[i++ % hooks.length];
    if (mode.startsWith("paced:")) {
      const gap = Number(mode.slice(6));
      const next = (client.last ?? 0) + gap;
      if (next > Date.now()) await sleep(next - Date.now());
      client.last = Date.now();
    }
    const w = (waitUntil.get(h.name) ?? 0) - Date.now();
    if (w > 0) await sleep(w);
    if (Date.now() >= end) break;
    const fd = new FormData();
    fd.append("payload_json", JSON.stringify({ content: "" }));
    fd.append("files[0]", new Blob([payload]), "blob.bin");
    const t0 = Date.now();
    let status = 0;
    let rec = {};
    try {
      const res = await fetch(`${h.url}?wait=true`, { method: "POST", body: fd });
      status = res.status;
      const hd = (k) => res.headers.get(k);
      rec = {
        limit: hd("x-ratelimit-limit"),
        remaining: hd("x-ratelimit-remaining"),
        resetAfter: hd("x-ratelimit-reset-after"),
        bucket: hd("x-ratelimit-bucket")?.slice(0, 8) ?? null,
        scope: hd("x-ratelimit-scope"),
        via: hd("via"),
        cf: hd("cf-ray") ? 1 : 0,
      };
      const text = await res.text();
      if (status === 429) {
        n429++;
        let body = {};
        try {
          body = JSON.parse(text);
        } catch {
          body = { nonJson: true };
        }
        rec.retryAfter = body.retry_after ?? hd("retry-after");
        rec.global = body.global ?? null;
        rec.code = body.code ?? null;
        rec.message = typeof body.message === "string" ? body.message.slice(0, 80) : null;
        const ra = Number(rec.retryAfter);
        waitUntil.set(h.name, Date.now() + (Number.isFinite(ra) ? ra * 1000 : 2000) + 50);
      } else if (mode === "headers" && rec.remaining === "0" && rec.resetAfter) {
        waitUntil.set(h.name, Date.now() + Number(rec.resetAfter) * 1000 + 20);
      }
    } catch (e) {
      rec.error = String(e?.message ?? e).slice(0, 80);
    }
    process.stdout.write(
      JSON.stringify({ c: clientId, hook: h.name, t0, ms: Date.now() - t0, status, ...rec }) + "\n",
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pct(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function run(name, durationSec, payloadKiB, mode, groups) {
  const out = join(process.env.TMPDIR || tmpdir(), `ratelimit-${name}.jsonl`);
  writeFileSync(out, "");
  const rows = [];
  await Promise.all(
    groups.map(
      (g, idx) =>
        new Promise((resolve) => {
          const p = spawn(process.execPath, [process.argv[1], "client", String(idx), String(durationSec), String(payloadKiB), mode, g], {
            stdio: ["ignore", "pipe", "inherit"],
          });
          let buf = "";
          p.stdout.on("data", (d) => {
            buf += d;
            let k;
            while ((k = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, k);
              buf = buf.slice(k + 1);
              if (!line) continue;
              appendFileSync(out, line + "\n");
              rows.push(JSON.parse(line));
            }
          });
          p.on("close", resolve);
        }),
    ),
  );
  const ok = rows.filter((r) => r.status >= 200 && r.status < 300);
  const r429 = rows.filter((r) => r.status === 429);
  const t0 = Math.min(...rows.map((r) => r.t0));
  const t1 = Math.max(...rows.map((r) => r.t0 + r.ms));
  const spanS = (t1 - t0) / 1000;
  const perHook = {};
  for (const r of ok) perHook[r.hook] = (perHook[r.hook] ?? 0) + 1;
  const perClient = {};
  for (const r of ok) perClient[r.c] = (perClient[r.c] ?? 0) + 1;
  const scopes = {};
  for (const r of r429) {
    const k = `${r.scope ?? "-"}/global=${r.global}/cf=${r.cf}`;
    scopes[k] = (scopes[k] ?? 0) + 1;
  }
  const limits = [...new Set(ok.map((r) => `${r.limit}@${r.bucket}`))];
  const resetAfters = [...new Set(ok.map((r) => r.resetAfter))].slice(0, 6);
  const retryAfters = r429.map((r) => Number(r.retryAfter)).filter(Number.isFinite);
  const other = rows.filter((r) => !(r.status >= 200 && r.status < 300) && r.status !== 429).map((r) => r.status || r.error);
  // Sustained rate: successes in the second half (after the initial burst bucket drained).
  const mid = t0 + (t1 - t0) / 2;
  const okLate = ok.filter((r) => r.t0 >= mid).length;
  const summary = {
    scenario: name,
    clients: groups.length,
    hooks: [...new Set(groups.flatMap((g) => g.split(",")))].length,
    mode,
    payloadKiB,
    spanS: Math.round(spanS * 10) / 10,
    requests: rows.length,
    ok: ok.length,
    okPerMin: Math.round((ok.length / spanS) * 60 * 10) / 10,
    okPerMinSecondHalf: Math.round((okLate / (spanS / 2)) * 60 * 10) / 10,
    n429: r429.length,
    share429: Math.round((r429.length / Math.max(1, rows.length)) * 1000) / 10,
    scopes429: scopes,
    retryAfterS: retryAfters.length ? { min: Math.min(...retryAfters), p50: pct(retryAfters, 50), max: Math.max(...retryAfters) } : null,
    other,
    limitAtBucket: limits,
    resetAfterSamples: resetAfters,
    latencyMs: { p50: pct(ok.map((r) => r.ms), 50), p95: pct(ok.map((r) => r.ms), 95) },
    perHook,
    perClient,
    messages429: [...new Set(r429.map((r) => r.message).filter(Boolean))],
    raw: out,
  };
  console.log(JSON.stringify(summary));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "client") {
  const [id, dur, kib, mode, hooks] = rest;
  await client(Number(id), Number(dur), Number(kib), mode, hooks.split(","));
} else if (cmd === "run") {
  const [name, dur, kib, mode, ...groups] = rest;
  await run(name, Number(dur), Number(kib), mode, groups);
} else {
  console.error("usage: see header");
  process.exit(2);
}
