// transfer-report: conclusions from transfer logs (JSON Lines, docs/transfer-log.md).
//   npm run transfer-report -- <log.jsonl|log.jsonl.gz> [more files] [--bucket 10] [--csv <prefix>]
//   discordrive transfer-report <files…>
// Text summary on stdout; CSV for a spreadsheet: <prefix>.timeline.csv (throughput per bucket and
// channel) and <prefix>.files.csv (one row per file). Default prefix: the first input without .jsonl(.gz).
// Pure functions here (tests feed lines); the file handling lives in runTransferReport.

export interface LogEvent {
  v: number;
  t: number;
  src: string;
  ev: string;
  dir?: "up" | "down";
  x?: string;
  i?: number | "m";
  a?: number;
  k?: string;
  b?: number;
  pb?: number;
  dur?: number;
  ttfb?: number;
  lim?: number;
  st?: number;
  ra?: number;
  scope?: string | null;
  glob?: boolean;
  cf?: boolean;
  err?: string;
  ch?: string | null;
  hook?: string;
  fl?: number;
  rd?: number;
  enc?: number;
  dec?: number;
  hash?: number;
  put?: number;
  get?: number;
  wr?: number;
  size?: number;
  n?: number;
  ok?: boolean;
  mbps?: number;
  conc?: number;
  ext?: string;
  name?: string;
  mode?: string;
  acct?: string;
  budget?: number;
  body?: number;
  post?: number;
  egress?: number;
  [k: string]: unknown;
}

export function parseLines(text: string): { events: LogEvent[]; bad: number } {
  const events: LogEvent[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as LogEvent;
      if (typeof e.t === "number" && typeof e.ev === "string") events.push(e);
      else bad++;
    } catch {
      bad++;
    }
  }
  events.sort((a, b) => a.t - b.t);
  return { events, bad };
}

export function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const mb = (b: number) => b / 1e6;

export interface Report {
  text: string;
  timelineCsv: string;
  filesCsv: string;
  summary: {
    events: number;
    files: { dir: string; n: number; ok: number; bytes: number; avgMBps: number }[];
    requests: Record<string, { n: number; p50: number; p90: number; p99: number; max: number }>;
    rateLimits: { n429: number; shared: number; cloudflare: number; global: number };
    retries: number;
    peakMBps: Record<string, number>;
    concurrency: Record<string, { avg: number; max: number }>;
    stages: Record<string, Record<string, number>>;
  };
}

/** Bytes of [from, to] spread evenly over buckets of `size` ms starting at `t0`. */
function spread(into: Map<number, number>, t0: number, size: number, from: number, to: number, bytes: number): void {
  if (to <= from) {
    const k = Math.floor((to - t0) / size);
    into.set(k, (into.get(k) ?? 0) + bytes);
    return;
  }
  const rate = bytes / (to - from);
  for (let k = Math.floor((from - t0) / size); k * size + t0 < to; k++) {
    const a = Math.max(from, t0 + k * size);
    const b = Math.min(to, t0 + (k + 1) * size);
    if (b > a) into.set(k, (into.get(k) ?? 0) + rate * (b - a));
  }
}

export function buildReport(events: LogEvent[], o: { bucketS?: number; bad?: number } = {}): Report {
  const bucket = (o.bucketS ?? 10) * 1000;
  const lines: string[] = [];
  const say = (s = "") => lines.push(s);
  if (!events.length) {
    return { text: "no events\n", timelineCsv: "", filesCsv: "", summary: { events: 0, files: [], requests: {}, rateLimits: { n429: 0, shared: 0, cloudflare: 0, global: 0 }, retries: 0, peakMBps: {}, concurrency: {}, stages: {} } };
  }
  const t0 = events[0]!.t;
  const tEnd = events.at(-1)!.t;
  const srcs = [...new Set(events.map((e) => e.src))].sort();
  say(`Transfer report: ${events.length} events${o.bad ? ` (${o.bad} unreadable lines skipped)` : ""}, ${new Date(t0).toISOString()} .. ${new Date(tEnd).toISOString()} (${r1((tEnd - t0) / 1000)} s), sources: ${srcs.join(", ")}`);
  const modes = [...new Set(events.filter((e) => e.ev === "file_start" && e.mode).map((e) => e.mode))];
  if (modes.length) say(`Mode: ${modes.join(", ")}`);

  // ── files
  const starts = new Map<string, LogEvent>();
  for (const e of events) if (e.ev === "file_start" && e.x) starts.set(`${e.src}|${e.dir}|${e.x}`, e);
  const ends = events.filter((e) => e.ev === "file_end");
  const files: Report["summary"]["files"] = [];
  const fileRows = ["src,dir,transfer,ext,size_bytes,fragments,start_iso,duration_s,avg_MBps,ok,error"];
  say();
  say("Files");
  for (const src of srcs)
    for (const dir of ["up", "down"] as const) {
      const fe = ends.filter((e) => e.src === src && e.dir === dir);
      if (!fe.length) continue;
      const ok = fe.filter((e) => e.ok);
      const bytes = ok.reduce((s, e) => s + (e.size ?? 0), 0);
      const durS = ok.reduce((s, e) => s + (e.dur ?? 0), 0) / 1000;
      const avg = durS > 0 ? mb(bytes) / durS : 0;
      files.push({ dir: `${src}/${dir}`, n: fe.length, ok: ok.length, bytes, avgMBps: r2(avg) });
      const sp = ok.map((e) => e.mbps ?? 0).sort((a, b) => a - b);
      say(`  ${src} ${dir === "up" ? "upload" : "download"}: ${fe.length} file(s), ${ok.length} ok, ${r1(mb(bytes))} MB in ${r1(durS)} s of transfers = ${r2(avg)} MB/s (${r1(avg * 8)} Mb/s); per file MB/s median ${r2(pct(sp, 50))}, min ${r2(sp[0] ?? 0)}, max ${r2(sp.at(-1) ?? 0)}`);
      const errs = new Map<string, number>();
      for (const e of fe) if (!e.ok) errs.set(String(e.err ?? "?"), (errs.get(String(e.err ?? "?")) ?? 0) + 1);
      for (const [k, n] of errs) say(`    failed ${n}×: ${k}`);
    }
  for (const e of ends) {
    const s = starts.get(`${e.src}|${e.dir}|${e.x}`);
    fileRows.push([e.src, e.dir, e.x, s?.ext ?? "", e.size ?? "", s?.n ?? "", new Date(e.t - (e.dur ?? 0)).toISOString(), r1((e.dur ?? 0) / 1000), e.mbps ?? "", e.ok ? 1 : 0, JSON.stringify(e.err ?? "")].join(","));
  }

  // ── requests
  const reqs = events.filter((e) => e.ev === "req");
  const kindOf = (e: LogEvent) => `${e.src}/${e.dir}/${e.k ?? (e.dir === "up" ? "post" : "get")}`;
  const requests: Report["summary"]["requests"] = {};
  say();
  say("Request times (ms): n, p50, p90, p99, max; time to first byte p50; failed");
  for (const k of [...new Set(reqs.map(kindOf))].sort()) {
    const rs = reqs.filter((e) => kindOf(e) === k);
    const d = rs.map((e) => e.dur ?? 0).sort((a, b) => a - b);
    const tt = rs.filter((e) => typeof e.ttfb === "number").map((e) => e.ttfb!).sort((a, b) => a - b);
    const failed = rs.filter((e) => e.err).length;
    requests[k] = { n: rs.length, p50: r1(pct(d, 50)), p90: r1(pct(d, 90)), p99: r1(pct(d, 99)), max: r1(d.at(-1) ?? 0) };
    say(`  ${k.padEnd(22)} n ${String(rs.length).padStart(5)}  p50 ${r1(pct(d, 50))}  p90 ${r1(pct(d, 90))}  p99 ${r1(pct(d, 99))}  max ${r1(d.at(-1) ?? 0)}${tt.length ? `  ttfb p50 ${r1(pct(tt, 50))}` : ""}${failed ? `  failed ${failed}` : ""}`);
  }

  // ── where the time goes (per fragment)
  const stages: Report["summary"]["stages"] = {};
  const frags = events.filter((e) => e.ev === "frag");
  say();
  say("Time per fragment (avg ms): limiter wait vs network vs crypto (sum over fragments in parentheses, s)");
  for (const src of srcs)
    for (const dir of ["up", "down"] as const) {
      const fs = frags.filter((e) => e.src === src && e.dir === dir);
      if (!fs.length) continue;
      const rq = reqs.filter((e) => e.src === src && e.dir === dir);
      const keys = ["rd", "enc", "hash", "put", "get", "dec", "wr", "budget", "body", "post"] as const;
      const st: Record<string, number> = { n: fs.length };
      const parts: string[] = [];
      for (const k of keys) {
        const v = fs.filter((e) => typeof e[k] === "number").map((e) => e[k] as number);
        if (!v.length) continue;
        const sum = v.reduce((a, b) => a + b, 0);
        st[k] = r1(sum / v.length);
        parts.push(`${k} ${r1(sum / v.length)} (${r1(sum / 1000)})`);
      }
      const lim = rq.filter((e) => typeof e.lim === "number").map((e) => e.lim!);
      if (lim.length) {
        const sum = lim.reduce((a, b) => a + b, 0);
        st.limiter = r1(sum / fs.length);
        parts.push(`limiter ${r1(sum / fs.length)} (${r1(sum / 1000)})`);
      }
      const net = rq.map((e) => e.dur ?? 0);
      if (net.length) {
        const sum = net.reduce((a, b) => a + b, 0);
        st.network = r1(sum / fs.length);
        parts.push(`requests ${r1(sum / fs.length)} (${r1(sum / 1000)})`);
      }
      const total = fs.reduce((a, e) => a + (e.dur ?? 0), 0);
      st.total = r1(total / fs.length);
      stages[`${src}/${dir}`] = st;
      say(`  ${src} ${dir}: ${fs.length} fragments, total ${r1(total / fs.length)}: ${parts.join(", ")}`);
    }
  say("  (rd read, enc/dec AES-GCM, hash SHA-256, put/get store call incl. limiter and retries, wr write; server: budget in-flight wait, body read, post to Discord)");

  // ── rate limits, retries, errors
  const r429 = reqs.filter((e) => e.st === 429);
  const rateLimits = { n429: r429.length, shared: r429.filter((e) => e.scope === "shared").length, cloudflare: r429.filter((e) => e.cf).length, global: r429.filter((e) => e.glob).length };
  const retries = reqs.filter((e) => (e.a ?? 0) > 0).length;
  say();
  say(`429: ${r429.length} (shared ${rateLimits.shared}, user/other ${r429.length - rateLimits.shared - rateLimits.cloudflare}, global ${rateLimits.global}, Cloudflare ${rateLimits.cloudflare}); requests that were a retry: ${retries}`);
  if (r429.length) {
    const ra = r429.map((e) => e.ra ?? 0).sort((a, b) => a - b);
    say(`  retry_after ms: p50 ${pct(ra, 50)}, p90 ${pct(ra, 90)}, max ${ra.at(-1)}`);
    const byCh = new Map<string, number>();
    for (const e of r429) byCh.set(e.ch ?? "?", (byCh.get(e.ch ?? "?") ?? 0) + 1);
    say(`  per channel: ${[...byCh].map(([c, n]) => `${short(c)} ${n}`).join(", ")}`);
    const tl = new Map<number, number>();
    for (const e of r429) tl.set(Math.floor((e.t - t0) / 60_000), (tl.get(Math.floor((e.t - t0) / 60_000)) ?? 0) + 1);
    say(`  per minute: ${[...tl].sort((a, b) => a[0] - b[0]).map(([m, n]) => `+${m}m ${n}`).join(", ")}`);
  }
  const errs = new Map<string, number>();
  for (const e of reqs) if (e.err && e.st !== 429) errs.set(`${kindOf(e)} ${e.st ?? ""} ${e.err}`.trim(), (errs.get(`${kindOf(e)} ${e.st ?? ""} ${e.err}`.trim()) ?? 0) + 1);
  if (errs.size) {
    say("Errors (not 429):");
    for (const [k, n] of [...errs].sort((a, b) => b[1] - a[1]).slice(0, 15)) say(`  ${n}× ${k}`);
  }

  // ── concurrency (time-weighted fragments in flight, from frag intervals)
  const concurrency: Report["summary"]["concurrency"] = {};
  say();
  say("Fragments in flight (time-weighted over the time anything was in flight; configured value in file_start)");
  for (const src of srcs)
    for (const dir of ["up", "down"] as const) {
      const fs = frags.filter((e) => e.src === src && e.dir === dir && typeof e.dur === "number");
      if (!fs.length) continue;
      const pts: [number, number][] = [];
      for (const e of fs) pts.push([e.t - e.dur!, 1], [e.t, -1]);
      pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let cur = 0, max = 0, busy = 0, area = 0, last = pts[0]![0];
      for (const [t, d] of pts) {
        if (cur > 0) ((busy += t - last), (area += cur * (t - last)));
        cur += d;
        max = Math.max(max, cur);
        last = t;
      }
      const conf = [...new Set(events.filter((e) => e.ev === "file_start" && e.src === src && e.dir === dir).map((e) => e.conc))].join("/");
      concurrency[`${src}/${dir}`] = { avg: r2(busy ? area / busy : 0), max };
      say(`  ${src} ${dir}: avg ${r2(busy ? area / busy : 0)}, max ${max}${conf ? `, configured ${conf}` : ""}`);
    }

  // ── throughput over time, total and per channel (bytes of successful requests spread over their duration)
  const series = new Map<string, Map<number, number>>();
  const add = (key: string, from: number, to: number, b: number) => {
    let m = series.get(key);
    if (!m) series.set(key, (m = new Map()));
    spread(m, t0, bucket, from, to, b);
  };
  for (const e of reqs) {
    if (e.err || !e.b || typeof e.dur !== "number") continue;
    // client: the store round trip per fragment (metadata only = to Discord; e2ee/plain = to the server); server: to Discord
    const key = `${e.src}/${e.dir}`;
    add(`${key}|all`, e.t - e.dur, e.t, e.b);
    if (e.ch) add(`${key}|${e.ch}`, e.t - e.dur, e.t, e.b);
  }
  const peakMBps: Record<string, number> = {};
  const n429 = new Map<string, number>();
  for (const e of r429) {
    const k = `${e.src}/${e.dir}|${Math.floor((e.t - t0) / bucket)}|${e.ch ?? ""}`;
    n429.set(k, (n429.get(k) ?? 0) + 1);
  }
  const csv = ["t_s,time_iso,src,dir,channel,MBps,Mbps,bytes,n429"];
  const buckets = Math.floor((tEnd - t0) / bucket) + 1;
  say();
  say(`Throughput per ${bucket / 1000} s (MB/s), all channels; per channel in the CSV`);
  for (const [key, m] of [...series].sort()) {
    const [sd, ch] = key.split("|") as [string, string];
    const vals: number[] = [];
    for (let k = 0; k < buckets; k++) {
      const b = m.get(k) ?? 0;
      const v = mb(b) / (bucket / 1000);
      vals.push(v);
      if (b > 0 || ch === "all") csv.push([k * (bucket / 1000), new Date(t0 + k * bucket).toISOString(), ...sd.split("/"), ch, r2(v), r1(v * 8), Math.round(b), ch === "all" ? [...n429].filter(([x]) => x.startsWith(`${sd}|${k}|`)).reduce((s, [, n]) => s + n, 0) : (n429.get(`${sd}|${k}|${ch}`) ?? 0)].join(","));
    }
    if (ch !== "all") continue;
    const active = vals.filter((v) => v > 0);
    peakMBps[sd] = r2(Math.max(0, ...vals));
    say(`  ${sd}: peak ${r2(Math.max(0, ...vals))}, median of active buckets ${r2(pct([...active].sort((a, b) => a - b), 50))}`);
    for (let k = 0; k < vals.length; k += 30) say(`    +${String(Math.round((k * bucket) / 1000)).padStart(5)} s: ${vals.slice(k, k + 30).map((v) => (v >= 10 ? Math.round(v) : r1(v))).join(" ")}`);
    const chans = [...series.keys()].filter((x) => x.startsWith(`${sd}|`) && !x.endsWith("|all"));
    for (const c of chans) {
      const cm = series.get(c)!;
      const total = [...cm.values()].reduce((a, b) => a + b, 0);
      const act = [...cm.values()].filter((b) => b > 0).length;
      say(`    channel ${short(c.split("|")[1]!)}: ${r1(mb(total))} MB, ${r2(act ? mb(total) / (act * (bucket / 1000)) : 0)} MB/s in ${act} active bucket(s)`);
    }
  }

  return { text: lines.join("\n") + "\n", timelineCsv: csv.join("\n") + "\n", filesCsv: fileRows.join("\n") + "\n", summary: { events: events.length, files, requests, rateLimits, retries, peakMBps, concurrency, stages } };
}

const short = (id: string) => (id.length > 8 ? `…${id.slice(-6)}` : id);

/** CLI: read files (.jsonl or .jsonl.gz), print the report, write the CSVs. */
export async function runTransferReport(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { gunzipSync } = await import("node:zlib");
  const files: string[] = [];
  let bucketS = 10;
  let prefix: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--bucket") bucketS = Number(argv[++i]);
    else if (a === "--csv") prefix = argv[++i]!;
    else if (a === "-h" || a === "--help") {
      out("usage: transfer-report <log.jsonl|log.jsonl.gz> [more…] [--bucket <s>] [--csv <prefix>]\n");
      return 0;
    } else files.push(a);
  }
  if (!files.length || !(bucketS > 0)) {
    out("usage: transfer-report <log.jsonl|log.jsonl.gz> [more…] [--bucket <s>] [--csv <prefix>]\n");
    return 2;
  }
  let text = "";
  for (const f of files) {
    const raw = readFileSync(f);
    text += (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString("utf8") + "\n";
  }
  const { events, bad } = parseLines(text);
  const r = buildReport(events, { bucketS, bad });
  out(r.text);
  const p = prefix ?? files[0]!.replace(/\.jsonl(\.gz)?$/, "").replace(/\.gz$/, "");
  writeFileSync(`${p}.timeline.csv`, r.timelineCsv);
  writeFileSync(`${p}.files.csv`, r.filesCsv);
  out(`\nCSV: ${p}.timeline.csv, ${p}.files.csv\n`);
  return 0;
}
