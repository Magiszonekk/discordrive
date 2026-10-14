// Transfer logs (zlecenie 2026-10-13-transfer §2): every event of an upload and a download through the
// real fetch transport against the fake Discord (with a per-channel 429 so the limiter shows up), no
// secret in any line (webhook token / URL, CDN signatures, file name unless asked), and the report
// built from the log. Also the CLI flag --transfer-log.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Sequencer } from "@ddv4/sync-core";
import { ChannelPacer, DiscordWebhookTransport, LocalArbiter, MemoryLogSink, MetadataClient, TransferLog, memorySource, scrubText, sha256Hex, type ByteSink } from "../src/index.js";
import { FakeDiscord } from "../src/node/index.js";
import { buildReport, parseLines, runTransferReport } from "../src/transfer-report.js";

let fake: FakeDiscord | null = null;
afterEach(async () => void (await fake?.close()));

function sink(): ByteSink & { data(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (d) => void parts.push(new Uint8Array(d)), data: () => Buffer.concat(parts) };
}

/** Everything that must never be in a log line. */
function secretsOf(hooks: { url: string }[], name: string): (string | RegExp)[] {
  return [...hooks.flatMap((h) => [h.url, h.url.split("/").at(-1)!]), name, /\/webhooks\/\d+\/[A-Za-z0-9_.-]{20,}/, /[?&](ex|is|hm)=/, /attachments\/\d+\/\d+\//];
}

async function run(names = false) {
  fake = new FakeDiscord();
  const origin = await fake.listen();
  const h1 = fake.addWebhook("1550000000000000301");
  const h2 = fake.addWebhook("1550000000000000302");
  const t = new DiscordWebhookTransport({ apiOrigin: origin });
  const mem = new MemoryLogSink();
  const log = new TransferLog(mem.write, { src: "cli", names, mode: "metadata-only" });
  // Fast pacer, but the fake answers 429 shared after 4 posts/min per channel: the limiter + retries show up.
  // Virtual clock for the pacer: a 429's retry_after (up to 60 s here) passes at once.
  let skew = 0;
  const pacer = new ChannelPacer({ perMin: 6000, maxPerMin: 6000, burst: 20, now: () => Date.now() + skew, sleep: async (ms) => void ((skew += ms), await new Promise((r) => setTimeout(r, 2))) });
  const c = new MetadataClient({ device: { id: "dev-l", name: "l" }, arbiter: new LocalArbiter(new Sequencer()), transport: t, webhooks: [h1, h2].map((h) => ({ id: h.id, url: h.url })), chunkSize: 50_000, pacer, sleep: async () => {} });
  c.setTransferLog(log);
  fake.perChannelPerMin = 4;
  const data = new Uint8Array(420_000);
  crypto.getRandomValues(data.subarray(0, 65536));
  const name = "tajny-raport-Q3.pdf";
  const p = c.upload(memorySource(data), name);
  const t0 = Date.now();
  while (pacer.stats.shared429 === 0 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 5));
  fake.perChannelPerMin = 0;
  const up = await p;
  const s = sink();
  await c.download(up.nodeId, s);
  expect(await sha256Hex(s.data())).toBe(await sha256Hex(data));
  return { mem, hooks: [h1, h2], name, up, pacer };
}

describe("transfer logs", () => {
  it("upload + download: per-fragment and per-file events, limiter state, 429 with scope, no secrets", async () => {
    const { mem, hooks, name, up, pacer } = await run();
    const text = mem.text();
    for (const s of secretsOf(hooks, name)) {
      if (typeof s === "string") expect(text.includes(s), `secret ${s.slice(0, 12)}… in the log`).toBe(false);
      else expect(s.test(text), `pattern ${s} in the log`).toBe(false);
    }
    const { events, bad } = parseLines(text);
    expect(bad).toBe(0);
    expect(events.every((e) => e.v === 1 && e.src === "cli" && typeof e.t === "number")).toBe(true);
    const of = (ev: string, dir: string) => events.filter((e) => e.ev === ev && e.dir === dir);
    // Upload: file start/end with the extension only, 9 fragments (420 000 / 50 000), each with its stages.
    const fs = of("file_start", "up")[0]!;
    expect(fs).toMatchObject({ x: up.uploadId, size: 420_000, n: 9, ext: "pdf", mode: "metadata-only" });
    expect(fs.name).toBeUndefined();
    const fe = of("file_end", "up")[0]!;
    expect(fe).toMatchObject({ ok: true, b: 420_000 });
    expect(fe.mbps).toBeGreaterThan(0);
    const frags = of("frag", "up");
    expect(frags.map((e) => e.i).sort((a, b) => Number(a) - Number(b))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const f of frags) for (const k of ["rd", "enc", "hash", "put", "dur", "b", "pb", "hook", "ch", "fl"]) expect(f[k], `frag.${k}`).toBeDefined();
    // Requests: every post with its limiter wait and the limiter state; the 429s with scope and retry_after; retries counted.
    const reqs = of("req", "up");
    expect(reqs.length).toBe(up.posts);
    for (const r of reqs) {
      expect(typeof r.lim).toBe("number");
      expect(r.lst).toMatchObject({ pm: expect.any(Number), tok: expect.any(Number), blk: expect.any(Number), q: expect.any(Number) });
      expect(String(r.hook)).toMatch(/^\d+$/);
    }
    const r429 = reqs.filter((r) => r.st === 429);
    expect(r429.length).toBe(pacer.stats.shared429);
    expect(r429[0]).toMatchObject({ scope: "shared", glob: false });
    expect(r429[0]!.ra).toBeGreaterThan(0);
    expect(reqs.some((r) => (r.a ?? 0) > 0)).toBe(true);
    expect(events.some((e) => e.ev === "commit")).toBe(true);
    // Download: link + CDN request per fragment (host only), fragment stages, file end.
    const dl = of("req", "down");
    expect(dl.filter((r) => r.k === "cdn").length).toBe(9);
    expect(dl.filter((r) => r.k === "link").length).toBe(9);
    expect(dl.find((r) => r.k === "cdn")!.host).toMatch(/^127\.0\.0\.1:\d+$/);
    for (const f of of("frag", "down")) for (const k of ["get", "hash", "dec", "wr"]) expect(f[k], `down frag.${k}`).toBeDefined();
    expect(of("file_end", "down")[0]).toMatchObject({ ok: true, b: 420_000 });

    // The report reads it: both directions, the 429s, the limiter vs requests split, CSV rows.
    const rep = buildReport(events, { bucketS: 1 });
    expect(rep.summary.rateLimits.n429).toBe(r429.length);
    expect(rep.summary.rateLimits.shared).toBe(r429.length);
    expect(rep.summary.files.map((f) => f.dir).sort()).toEqual(["cli/down", "cli/up"]);
    expect(rep.summary.stages["cli/up"]!.limiter).toBeGreaterThanOrEqual(0);
    expect(rep.summary.stages["cli/up"]!.network).toBeGreaterThan(0);
    expect(rep.summary.requests["cli/up/post"]!.n).toBe(up.posts);
    expect(rep.text).toMatch(/429: \d+ \(shared \d+/);
    expect(rep.timelineCsv.split("\n")[0]).toBe("t_s,time_iso,src,dir,channel,MBps,Mbps,bytes,n429");
    expect(rep.timelineCsv).toContain(",cli,up,all,");
    expect(rep.filesCsv.split("\n").filter(Boolean).length).toBe(3);
  });

  it("file names only when asked; the report CLI writes text + CSV", async () => {
    const { mem, name } = await run(true);
    const { events } = parseLines(mem.text());
    expect(events.find((e) => e.ev === "file_start" && e.dir === "up")!.name).toBe(name);
    const dir = mkdtempSync(join(tmpdir(), "ddn-tlog-"));
    const f = join(dir, "t.jsonl");
    writeFileSync(f, mem.text() + "not json\n");
    let out = "";
    expect(await runTransferReport([f, "--bucket", "2"], (s) => void (out += s))).toBe(0);
    expect(out).toMatch(/1 unreadable lines skipped/);
    expect(out).toMatch(/cli upload: 1 file\(s\), 1 ok/);
    expect(readFileSync(join(dir, "t.timeline.csv"), "utf8")).toMatch(/^t_s,/);
    expect(readFileSync(join(dir, "t.files.csv"), "utf8")).toMatch(/,up,/);
  });

  it("errors are scrubbed: URLs reduced to the host, long tokens cut", () => {
    const s = scrubText("webhook post: fetch failed https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklmnop?wait=true and https://cdn.discordapp.com/attachments/1/2/x.txt?ex=1&hm=abc");
    expect(s).not.toMatch(/AbCdEf|hm=|ex=|attachments/);
    expect(s).toContain("<url:discord.com>");
    expect(s).toContain("<url:cdn.discordapp.com>");
  });
});
