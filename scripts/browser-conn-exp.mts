// Experiment: can a web page get a SECOND, independent connection to
// the same Discord host (cdn.discordapp.com for downloads, discord.com for webhook POSTs) without
// proxying through our server?
//
// It opens a real Chromium with a net log (--log-net-log), serves a small test page on two local
// origins (127.0.0.1 and localhost = two different sites) and issues the same requests from
// different contexts: the page itself, a dedicated worker, a service worker, a cross-site iframe, a
// sandboxed (opaque-origin) iframe, two credentialless iframes, fetch with credentials "include",
// and alias host names. Every request carries a tag (?ddnctx=<context>), so the net log shows
// which context used which HTTP/2 / QUIC session. Then a throughput pass: one context × N vs two
// contexts × N/2 for downloads and uploads.
//
//   npx tsx scripts/browser-conn-exp.mts webhooks.txt [--out dir] [--frag-mib 10] [--n 32]
//        [--no-throughput] [--quic|--no-quic] [--chrome /path/to/chrome | --channel chrome] [--alt sandbox|anon1]
//        [--protos default,h2] [--n-up 16] [--no-upload]
//
// webhooks.txt: webhook URLs of a TEST server (one per channel). Test messages are deleted at the end.
// The net log contains webhook tokens in request paths: it stays in a temp dir and is deleted; only
// the summary (no URLs, no tokens) goes to --out.

import { chromium, type Browser, type Page } from "playwright";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const OUT = opt("out", "");
const FRAG = Math.round(Number(opt("frag-mib", "10")) * 1024 * 1024) - 28;
const N = Number(opt("n", "32"));
const ROUNDS = Number(opt("rounds", "2"));
const NO_TP = flag("no-throughput");
const ALT = opt("alt", "sandbox")!; // second context for the throughput pass
// Throughput with the browser's default (HTTP/3 = QUIC to Discord when it can) and with QUIC off (HTTP/2 over TCP).
const PROTOS: (boolean | null)[] = String(opt("protos", "default,h2")).split(",").map((x) => (x.trim() === "h2" ? false : null));
const NO_UP = flag("no-upload");
const QUIC = flag("quic") ? true : flag("no-quic") ? false : null; // null = browser default
const CHROME = opt("chrome", process.env.CHROMIUM_PATH ?? "");
// --channel chrome / msedge: the installed browser instead of Playwright's Chromium (the owner's real Chrome).
const CHANNEL = opt("channel", "");
const file = argv[0];
if (!file) {
  console.error("usage: npx tsx scripts/browser-conn-exp.mts webhooks.txt [--out dir] [--frag-mib 10] [--n 32] [--no-throughput] [--quic|--no-quic]");
  process.exit(2);
}
const HOOK_RE = /https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d+)\/[A-Za-z0-9_.-]+/g;
const hooks = [...new Set(readFileSync(file, "utf8").match(HOOK_RE) ?? [])];
if (!hooks.length) throw new Error("no webhook URLs in file");
const log = (s: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
/** Never print tokens or signed CDN links. */
const redact = (s: string) => s.replace(/(webhooks\/\d+\/)[A-Za-z0-9_.-]+/g, "$1***").replace(/(attachments\/)[^\s'"]+/g, "$1***");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── test fragments on the CDN (posted from Node) ────────────────────
const posted: { hook: string; id: string }[] = [];
async function postFromNode(hook: string, bytes: Uint8Array, name = "x.txt"): Promise<string> {
  for (let a = 0; ; a++) {
    const fd = new FormData();
    fd.append("files[0]", new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
    const r = await fetch(`${hook}?wait=true`, { method: "POST", body: fd });
    if (r.status === 429) {
      const j = (await r.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.ceil((j.retry_after ?? 1) * 1000) + 100);
      continue;
    }
    if (!r.ok) {
      if (a < 3) {
        await sleep(1000 * (a + 1));
        continue;
      }
      throw new Error(`post ${r.status}`);
    }
    const j = (await r.json()) as { id: string; attachments: { url: string }[] };
    posted.push({ hook, id: j.id });
    return j.attachments[0]!.url;
  }
}
async function cleanup(ids: { hook: string; id: string }[]) {
  let n = 0;
  for (const p of ids) {
    for (let a = 0; a < 5; a++) {
      const r = await fetch(`${p.hook}/messages/${p.id}`, { method: "DELETE" }).catch(() => null);
      if (r?.status === 429) {
        await sleep(1500);
        continue;
      }
      if (r && (r.ok || r.status === 404)) n++;
      break;
    }
  }
  return n;
}

// ── the test page (same code in every context) ──────────────────────
const JOB = String.raw`
const BUFS = {};
function buf(n){ if(!BUFS[n]){ const b=new Uint8Array(n); for(let o=0;o<n;o+=65536) crypto.getRandomValues(b.subarray(o,Math.min(n,o+65536))); BUFS[n]=b; } return BUFS[n]; }
async function runJob(j){
  const t0=performance.now(); const out=[];
  await Promise.all(j.items.map(async (u)=>{
    const s=performance.now();
    try{
      if(j.kind==='get'){
        const r=await fetch(u,{credentials:j.cred||'same-origin',cache:'no-store'});
        const rd=r.body.getReader(); let n=0, first=0;
        for(;;){ const {done,value}=await rd.read(); if(done)break; if(!first) first=performance.now()-s; n+=value.byteLength; }
        const pe=performance.getEntriesByName(r.url||u).slice(-1)[0]; out.push({ok:r.ok,st:r.status,n,ttfb:first,dur:performance.now()-s,t:s-t0,proto:pe?pe.nextHopProtocol:null,conn:pe?Math.round(pe.connectEnd-pe.connectStart):null});
      }else{
        const fd=new FormData(); fd.append('files[0]', new Blob([buf(j.size)]), 'x.txt');
        const r=await fetch(u,{method:'POST',body:fd,credentials:j.cred||'same-origin'});
        const tx=await r.text(); let id=null; try{ id=JSON.parse(tx).id }catch{}
        out.push({ok:r.ok,st:r.status,n:j.size,dur:performance.now()-s,t:s-t0,id,hook:'https://discord.com'+new URL(u).pathname});
      }
    }catch(e){ out.push({ok:false,err:String(e&&e.message||e).slice(0,120),dur:performance.now()-s,t:s-t0}); }
  }));
  return {wall:performance.now()-t0,out};
}
`;
const FRAME_HTML = `<!doctype html><meta charset=utf-8><script>${JOB}
addEventListener('message', async (e)=>{ if(!e.data||!e.data.job) return; const r=await runJob(e.data.job); (e.source||parent).postMessage({rid:e.data.rid,res:r}, '*'); });
parent.postMessage({ready:location.href}, '*');
</script>`;
const SW_JS = `${JOB}
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',(e)=>e.waitUntil(self.clients.claim()));
self.addEventListener('message',(e)=>{ if(!e.data||!e.data.job) return; e.waitUntil(runJob(e.data.job).then((r)=>e.ports[0].postMessage({rid:e.data.rid,res:r}))); });`;
const WORKER_JS = `${JOB}
onmessage=async(e)=>{ const r=await runJob(e.data.job); postMessage({rid:e.data.rid,res:r}); };`;
const PAGE_HTML = (other: string) => `<!doctype html><meta charset=utf-8><title>conn-exp</title><body><script>${JOB}
let rid=0; const waits=new Map();
addEventListener('message',(e)=>{ if(e.data&&e.data.rid!=null&&waits.has(e.data.rid)){ waits.get(e.data.rid)(e.data.res); waits.delete(e.data.rid); } });
const ctxs={};
function viaWin(w){ return (job)=>new Promise((ok)=>{ const id=++rid; waits.set(id,ok); w.postMessage({rid:id,job},'*'); }); }
function frame(attrs){ return new Promise((ok)=>{ const f=document.createElement('iframe'); for(const [k,v] of Object.entries(attrs)) f.setAttribute(k,v); const h=(e)=>{ if(e.source===f.contentWindow&&e.data&&e.data.ready){ removeEventListener('message',h); ok(viaWin(f.contentWindow)); } }; addEventListener('message',h); document.body.appendChild(f); }); }
window.setup=async()=>{
  ctxs.main=runJob;
  const w=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER_JS).replace(/<\//g, "<\\/")}],{type:'text/javascript'})));
  ctxs.worker=(job)=>new Promise((ok)=>{ const id=++rid; const h=(e)=>{ if(e.data.rid===id){ w.removeEventListener('message',h); ok(e.data.res);} }; w.addEventListener('message',h); w.postMessage({rid:id,job}); });
  try{ const reg=await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; const sw=reg.active||reg.waiting||reg.installing;
    ctxs.sw=(job)=>new Promise((ok)=>{ const ch=new MessageChannel(); ch.port1.onmessage=(e)=>ok(e.data.res); sw.postMessage({rid:++rid,job},[ch.port2]); }); }catch(e){ ctxs.swError=String(e); }
  ctxs.xsite=await frame({src:${JSON.stringify(other + "/frame.html")}});
  ctxs.sandbox=await frame({sandbox:'allow-scripts',srcdoc:${JSON.stringify(FRAME_HTML).replace(/<\//g, "<\\/")}});
  ctxs.anon1=await frame({credentialless:'',src:'/frame.html'});
  ctxs.anon2=await frame({credentialless:'',src:'/frame.html'});
  return Object.keys(ctxs).filter((k)=>typeof ctxs[k]==='function').concat(ctxs.swError?['swError:'+ctxs.swError]:[]);
};
window.run=(ctx,job)=>ctxs[ctx](job);
</script>`;

function serve(other: () => string): Promise<{ srv: Server; port: number }> {
  return new Promise((ok) => {
    const srv = createServer((req, res) => {
      const p = (req.url ?? "/").split("?")[0];
      const h = { "cache-control": "no-store" } as Record<string, string>;
      if (p === "/sw.js") res.writeHead(200, { ...h, "content-type": "text/javascript" }).end(SW_JS);
      else if (p === "/frame.html") res.writeHead(200, { ...h, "content-type": "text/html" }).end(FRAME_HTML);
      else res.writeHead(200, { ...h, "content-type": "text/html" }).end(PAGE_HTML(other()));
    });
    srv.listen(0, "127.0.0.1", () => ok({ srv, port: (srv.address() as { port: number }).port }));
  });
}

// ── net log → which context used which session ─────────────────────
type Sess = { kind: "h2" | "quic" | "h1"; id: number; host: string; tags: Record<string, number> };
function parseNetLog(path: string): Sess[] {
  let txt = readFileSync(path, "utf8").trim();
  if (!txt.endsWith("}")) txt = txt.replace(/,?\s*$/, "") + "]}"; // log cut short
  const j = JSON.parse(txt) as { constants: { logEventTypes: Record<string, number>; logSourceType: Record<string, number> }; events: { type: number; source: { id: number; type: number }; phase: number; params?: Record<string, unknown> }[] };
  const ev = Object.fromEntries(Object.entries(j.constants.logEventTypes).map(([k, v]) => [v, k]));
  const st = Object.fromEntries(Object.entries(j.constants.logSourceType).map(([k, v]) => [v, k]));
  const sessions = new Map<number, Sess>();
  const tagOf = (hs: unknown): string | null => {
    const s = JSON.stringify(hs ?? "");
    const m = /ddnctx=([a-z0-9_-]+)/.exec(s);
    return m ? m[1]! : null;
  };
  for (const e of j.events) {
    const name = ev[e.type];
    const stype = st[e.source.type];
    if (stype === "HTTP2_SESSION" && name === "HTTP2_SESSION" && e.params?.host) sessions.set(e.source.id, { kind: "h2", id: e.source.id, host: String(e.params.host), tags: {} });
    if (stype === "QUIC_SESSION" && name === "QUIC_SESSION" && e.params?.host) sessions.set(e.source.id, { kind: "quic", id: e.source.id, host: String(e.params.host), tags: {} });
    if (name === "HTTP2_SESSION_SEND_HEADERS" || name === "HTTP3_HEADERS_SENT" || name === "QUIC_CHROMIUM_CLIENT_STREAM_SEND_REQUEST_HEADERS") {
      const s = sessions.get(e.source.id);
      const t = tagOf(e.params?.headers);
      if (s && t) s.tags[t] = (s.tags[t] ?? 0) + 1;
    }
  }
  // QUIC request headers are logged on the stream/request source in some versions: map via HTTP_STREAM_REQUEST_BOUND_TO_QUIC_SESSION.
  return [...sessions.values()].filter((s) => /discord/.test(s.host));
}

// ── run ─────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "conn-exp-"));
const result: Record<string, unknown> = { at: new Date().toISOString(), hooks: hooks.length, n: N, fragMiB: (FRAG + 28) / 1048576, quic: QUIC };
let srvA: Server | null = null, srvB: Server | null = null;
let portA = 0, portB = 0;
async function launch(netlog: string, quic: boolean | null = QUIC): Promise<{ browser: Browser; page: Page; contexts: string[] }> {
  const args = [`--log-net-log=${netlog}`, "--net-log-capture-mode=Default"];
  if (quic === false) args.push("--disable-quic");
  if (quic === true) args.push("--enable-quic", "--origin-to-force-quic-on=cdn.discordapp.com:443,discord.com:443");
  const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), ...(CHANNEL ? { channel: CHANNEL } : {}), args });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && process.env.DDN_EXP_CONSOLE && log("console: " + redact(m.text()).slice(0, 300)));
  await page.goto(`http://127.0.0.1:${portA}/`);
  const contexts = (await page.evaluate("setup()")) as string[];
  return { browser, page, contexts };
}
type JobRes = { wall: number; out: { ok: boolean; st?: number; n?: number; dur: number; ttfb?: number; err?: string; id?: string | null; hook?: string; proto?: string | null }[] };
const tag = (u: string, t: string) => u + (u.includes("?") ? "&" : "?") + "ddnctx=" + t;

try {
  ({ srv: srvA, port: portA } = await serve(() => `http://localhost:${portB}`));
  ({ srv: srvB, port: portB } = await serve(() => `http://127.0.0.1:${portA}`));
  log(`page on 127.0.0.1:${portA}, cross-site frame on localhost:${portB}`);

  // 1) small fragments for the connection map
  log("posting small test fragments from Node…");
  const small: string[] = [];
  for (let i = 0; i < 16; i++) small.push(await postFromNode(hooks[i % hooks.length]!, randomBytes(256 * 1024)));
  const netlog1 = join(tmp, "map.json");
  const { browser, page, contexts } = await launch(netlog1);
  log(`contexts: ${contexts.join(", ")}`);
  const map: Record<string, unknown> = { contexts };
  const ctxList = contexts.filter((c) => !c.startsWith("swError"));
  const variants: { name: string; ctx: string; kind: "get" | "post"; cred?: string; host?: (u: string) => string }[] = [];
  for (const c of ctxList) variants.push({ name: `${c}`, ctx: c, kind: "get" }, { name: `${c}`, ctx: c, kind: "post" });
  variants.push({ name: "main-include", ctx: "main", kind: "get", cred: "include" }, { name: "main-include", ctx: "main", kind: "post", cred: "include" });
  variants.push({ name: "main-omit", ctx: "main", kind: "get", cred: "omit" }, { name: "main-omit", ctx: "main", kind: "post", cred: "omit" });
  variants.push({ name: "alias-dot", ctx: "main", kind: "get", host: (u) => u.replace("cdn.discordapp.com/", "cdn.discordapp.com./") });
  variants.push({ name: "alias-ptb", ctx: "main", kind: "post", host: (u) => u.replace("://discord.com/", "://ptb.discord.com/") });
  variants.push({ name: "alias-canary", ctx: "main", kind: "post", host: (u) => u.replace("://discord.com/", "://canary.discord.com/") });
  variants.push({ name: "alias-dapp", ctx: "main", kind: "post", host: (u) => u.replace("://discord.com/", "://discordapp.com/") });
  variants.push({ name: "alias-dot", ctx: "main", kind: "post", host: (u) => u.replace("://discord.com/", "://discord.com./") });
  const outcome: Record<string, { get?: string; post?: string }> = {};
  for (let round = 0; round < ROUNDS; round++) {
    // all variants at the same time (as if two pools were used at once), each with 4 requests
    let postNo = 0;
    await Promise.all(
      variants.map(async (v) => {
        // one POST per variant, spread over the channels (a channel allows a burst of ~4)
        const hook = hooks[postNo++ % hooks.length]!;
        const items = (v.kind === "get" ? small.slice(0, 4) : [hook]).map((u) => tag((v.host ?? ((x) => x))(v.kind === "get" ? u : `${u}?wait=true`), v.name.replace(/[^a-z0-9-]/g, "")));
        const res = (await page.evaluate(([c, j]) => (window as unknown as { run: (c: string, j: unknown) => Promise<unknown> }).run(c as string, j), [v.ctx, { kind: v.kind, items, cred: v.cred, size: 64 * 1024 }] as const)) as JobRes;
        for (const o of res.out) if (o.id) posted.push({ hook: o.hook ?? hook, id: o.id });
        const ok = res.out.filter((o) => o.ok).length;
        const errs = [...new Set(res.out.filter((o) => !o.ok).map((o) => o.err ?? `HTTP ${o.st}`))];
        const protos = [...new Set(res.out.map((o) => o.proto).filter((x) => x != null))];
        (outcome[v.name] ??= {})[v.kind] = `${ok}/${res.out.length} ok${errs.length ? " — " + errs.join("; ") : ""}${protos.length ? ` (nextHopProtocol ${protos.map((x) => x || '""').join(",")})` : ""}`;
      }),
    );
    await sleep(10_000);
  }
  await page.close();
  await browser.close();
  const sess = parseNetLog(netlog1);
  map.outcome = outcome;
  map.sessions = sess.map((s) => ({ kind: s.kind, host: s.host, tags: s.tags }));
  // context → sessions it used, per host
  const usage: Record<string, Record<string, number[]>> = {};
  for (const s of sess) for (const t of Object.keys(s.tags)) ((usage[t] ??= {})[s.host] ??= []).push(s.id);
  map.usage = usage;
  result.map = map;
  log("connection map:");
  for (const s of sess) log(`  ${s.kind} #${s.id} ${s.host}: ${Object.entries(s.tags).map(([k, v]) => `${k}×${v}`).join(" ")}`);
  for (const [k, v] of Object.entries(outcome)) log(`  ${k}: get ${v.get ?? "-"} | post ${v.post ?? "-"}`);

  // 2) throughput: one context × N vs two contexts × N/2 (main + the best candidate)
  if (!NO_TP) {
    const alt = ALT;
    log(`throughput: posting ${N} fragments of ${((FRAG + 28) / 1048576).toFixed(0)} MiB from Node…`);
    const big: string[] = [];
    await Promise.all(
      Array.from({ length: 4 }, async (_, w) => {
        for (let i = w; i < N; i += 4) big[i] = await postFromNode(hooks[i % hooks.length]!, randomBytes(FRAG));
      }),
    );
    const tp: Record<string, unknown>[] = [];
    const pass = async (label: string, quic: boolean | null, plan: { ctx: string; items: string[]; kind: "get" | "post" }[]) => {
      const nl = join(tmp, `tp-${label}.json`);
      const b = await launch(nl, quic);
      // warm the connections first (as in the app: the page has talked to Discord before a transfer starts)
      await Promise.all([...new Set(plan.map((p) => p.ctx))].map((c) => b.page.evaluate(([c, j]) => (window as unknown as { run: (c: string, j: unknown) => Promise<unknown> }).run(c as string, j), [c, { kind: "get", items: [tag(small[0]!, c)] }] as const)));
      const t0 = Date.now();
      const rs = await Promise.all(plan.map((p) => b.page.evaluate(([c, j]) => (window as unknown as { run: (c: string, j: unknown) => Promise<unknown> }).run(c as string, j), [p.ctx, { kind: p.kind, items: p.items, size: FRAG }] as const) as Promise<JobRes>));
      const wall = (Date.now() - t0) / 1000;
      await b.browser.close();
      const outs = rs.flatMap((r) => r.out);
      for (const o of outs) if (o.id && o.hook) posted.push({ hook: o.hook, id: o.id });
      const bytes = outs.filter((o) => o.ok).reduce((a, o) => a + (o.n ?? 0), 0);
      const s = parseNetLog(nl).filter((x) => Object.keys(x.tags).length);
      const durs = outs.map((o) => o.dur).sort((a, b) => a - b);
      const row = { label, quic: quic === false ? "off" : "default", wall: +wall.toFixed(1), MBps: +(bytes / 1e6 / wall).toFixed(1), ok: outs.filter((o) => o.ok).length, of: outs.length, errors: [...new Set(outs.filter((o) => !o.ok).map((o) => o.err ?? `HTTP ${o.st}`))], sessions: s.map((x) => `${x.kind}:${x.host}:${Object.entries(x.tags).map(([k, v]) => `${k}×${v}`).join("+")}`), medDur: +(durs[durs.length >> 1]! / 1000).toFixed(2), medTtfb: +((outs.map((o) => o.ttfb ?? 0).sort((a, b) => a - b)[outs.length >> 1] ?? 0) / 1000).toFixed(2) };
      tp.push(row);
      log(`  ${label}: ${row.MBps} MB/s (${row.ok}/${row.of}, ${row.wall} s, fragment median ${row.medDur} s, first byte ${row.medTtfb} s) ${row.sessions.join(" | ")}`);
    };
    const half = N >> 1;
    const NU = Math.min(N, Number(opt("n-up", "16")));
    const hookFor = (i: number) => `${hooks[i % hooks.length]}?wait=true`;
    for (const quic of PROTOS) {
      const q = quic === false ? "h2" : "dflt";
      for (const rep of [0, 1]) {
        for (const o of rep === 0 ? ["one", "two"] : ["two", "one"]) {
          if (o === "one") await pass(`${q}-down-1x${N}-r${rep}`, quic, [{ ctx: "main", kind: "get", items: big.map((u) => tag(u, "main")) }]);
          else await pass(`${q}-down-2x${half}-r${rep}`, quic, [{ ctx: "main", kind: "get", items: big.slice(0, half).map((u) => tag(u, "main")) }, { ctx: alt, kind: "get", items: big.slice(half).map((u) => tag(u, alt)) }]);
        }
      }
      if (NO_UP) continue;
      for (const o of ["one", "two"]) {
        if (o === "one") await pass(`${q}-up-1x${NU}`, quic, [{ ctx: "main", kind: "post", items: Array.from({ length: NU }, (_, i) => tag(hookFor(i), "main")) }]);
        else await pass(`${q}-up-2x${NU >> 1}`, quic, [{ ctx: "main", kind: "post", items: Array.from({ length: NU >> 1 }, (_, i) => tag(hookFor(i), "main")) }, { ctx: alt, kind: "post", items: Array.from({ length: NU >> 1 }, (_, i) => tag(hookFor(i + (NU >> 1)), alt)) }]);
        await sleep(Math.max(5000, (NU / hooks.length) * 2500)); // let the channel limits refill
      }
    }
    result.throughput = tp;
  }
} finally {
  log(`deleting ${posted.length} test messages…`);
  result.deleted = await cleanup(posted).catch(() => 0);
  srvA?.close();
  srvB?.close();
  if (OUT) {
    if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `browser-conn-exp-${Date.now()}.json`), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result, null, 2));
  if (!process.env.DDN_KEEP_NETLOG) rmSync(tmp, { recursive: true, force: true });
  else log(`net logs kept in ${tmp} (contain webhook tokens!)`);
}
