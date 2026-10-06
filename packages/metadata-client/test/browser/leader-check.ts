// Main-tab election (koncept §4.1) in headless Chromium: 3 tabs of one origin,
// exactly one leader; closing it hands leadership to another tab; a second
// browser context (another profile) has its own leader.
import { build } from "esbuild";
import { chromium, type Page } from "playwright";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const code = (
  await build({ entryPoints: [join(here, "..", "..", "src", "browser", "leader.ts")], bundle: true, platform: "browser", format: "iife", globalName: "L", write: false, logLevel: "error" })
).outputFiles[0]!.text;
const srv = createServer((_q, r) => (r.writeHead(200, { "content-type": "text/html" }), r.end(`<!doctype html><script>${code}; window.lead = L.claimLeadership("acct-1");</script>`)));
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = false;
try {
  const ctx = await browser.newContext();
  const tabs: Page[] = [];
  for (let i = 0; i < 3; i++) {
    const p = await ctx.newPage();
    await p.goto(origin);
    tabs.push(p);
  }
  const leaders = async (ps: Page[]) => Promise.all(ps.map((p) => p.evaluate(() => (window as unknown as { lead: { isLeader: boolean } }).lead.isLeader)));
  await tabs[0]!.waitForTimeout(200);
  const before = await leaders(tabs);
  const first = before.indexOf(true);
  await tabs[first]!.close();
  const rest = tabs.filter((_, i) => i !== first);
  await rest[0]!.waitForTimeout(300);
  const after = await leaders(rest);
  const ctx2 = await browser.newContext();
  const other = await ctx2.newPage();
  await other.goto(origin);
  await other.waitForTimeout(200);
  const otherLeader = (await leaders([other]))[0];
  const r = { leadersBefore: before.filter(Boolean).length, leadersAfterClose: after.filter(Boolean).length, otherProfileLeader: otherLeader };
  console.log(JSON.stringify(r));
  ok = r.leadersBefore === 1 && r.leadersAfterClose === 1 && r.otherProfileLeader === true;
} finally {
  await browser.close();
  srv.close();
}
process.exit(ok ? 0 : 1);
