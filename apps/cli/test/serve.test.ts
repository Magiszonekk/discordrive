// `ddn serve` against real instances with a fake Discord: token required, health, folders, an upload as a
// raw body (job + wait), list, GET whole and Range (middle, suffix, end, 416), HEAD, move/rename, DELETE to the
// trash, two uploads at once, events (SSE), revoked key → health 503, and a stop that lets running uploads end.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ChannelPacer, DiscordWebhookTransport, HttpApi, WebhookVault, createAccountHttp, createApiKey, generateDeviceKey, inspectForVault, newAccountKey } from "@ddv4/metadata-client";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { main, type CliIo } from "../src/cli.js";
import { parseRangeHeader } from "../src/serve.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
const tmp = (p: string) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), p));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
type Mode = "metadata-only" | "e2ee";

async function setup(mode: Mode) {
  const fake = new FakeDiscord();
  const origin = await fake.listen();
  cleanups.push(() => fake.close());
  const dir = tmp(`ddn-serve-${mode}-`);
  let extensions: ConstructorParameters<typeof DdnServer>[0] extends infer O ? (O extends { extensions?: infer X } ? X : never) : never = [];
  let pool: (() => Promise<void>) | null = null;
  if (mode === "e2ee") {
    const { serverBlobsMode, POOL } = await import("@ddv4/server-discord");
    const m = serverBlobsMode({ dataDir: dir, discordApiOrigin: origin, cleanupTickMs: 0, snapshotTickMs: 0, pacer: new ChannelPacer({ perMin: 6000, maxPerMin: 6000, burst: 50 }) });
    extensions = m.extensions;
    pool = async () => {
      for (const c of ["1550000000000000801", "1550000000000000802"]) await m.hooks().add(POOL, fake.addWebhook(c).url, new DiscordWebhookTransport({ apiOrigin: origin }));
    };
  }
  const srv = new DdnServer({ dbPath: join(dir, "ddn.db"), mode, rateLimits: false, signup: "open", extensions });
  const { url } = await srv.listen(0);
  cleanups.push(() => srv.close());
  await pool?.();
  const key = newAccountKey();
  const dk = await generateDeviceKey();
  const a = await createAccountHttp(url, dk, key);
  const api = new HttpApi({ baseUrl: url, accountId: a.accountId, deviceId: a.deviceId, key: dk, instanceId: a.instanceId });
  if (mode === "metadata-only") {
    const v = new WebhookVault(api, key, a.accountId);
    for (const c of ["1550000000000000901", "1550000000000000902"]) await v.addWebhook(await inspectForVault(new DiscordWebhookTransport({ apiOrigin: origin }), fake.addWebhook(c).url));
  }
  const made = await createApiKey(api, { server: url, instanceId: a.instanceId, accountId: a.accountId, key }, "serve test");
  return { origin, api, made };
}

for (const mode of ["metadata-only", "e2ee"] as Mode[]) {
  describe(`ddn serve on a ${mode} instance`, () => {
    it("token, upload, list, Range, move, trash, parallel uploads, events, revoked key, graceful stop", async () => {
      const S = await setup(mode);
      const cfg = tmp("ddn-serve-cfg-");
      const out: string[] = [];
      const err: string[] = [];
      const stop = new AbortController();
      const io: CliIo = { out: (l) => void out.push(l), err: (l) => void err.push(l), env: { DDN_CONFIG_DIR: cfg, DDN_API_KEY: S.made.text }, discordApiOrigin: S.origin, stop: stop.signal };
      const running = main(["serve", "--listen", "127.0.0.1:0", "--json"], io);
      const deadline = Date.now() + 30_000;
      while (!out.some((l) => l.includes('"listening"')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const hello = JSON.parse(out.find((l) => l.includes('"listening"'))!) as { port: number; tokenFile: string };
      const base = `http://127.0.0.1:${hello.port}`;
      const token = readFileSync(hello.tokenFile, "utf8").trim();
      if (process.platform !== "win32") expect(statSync(hello.tokenFile).mode & 0o777).toBe(0o600);
      const H = { authorization: `Bearer ${token}` };
      const j = async (method: string, path: string, body?: unknown) => {
        const r = await fetch(base + path, { method, headers: { ...H, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: (await r.json()) as Record<string, any> };
      };

      // Without the token, or a wrong one: 401.
      expect((await fetch(base + "/v1/health")).status).toBe(401);
      expect((await fetch(base + "/v1/health", { headers: { authorization: "Bearer " + "x".repeat(token.length) } })).status).toBe(401);
      const h = await j("GET", "/v1/health");
      expect(h.body).toMatchObject({ ok: true, mode, connected: true, canUpload: true });

      expect((await j("POST", "/v1/folders", { path: "/Media/2026" })).status).toBe(201);
      expect((await j("POST", "/v1/folders", { path: "/Media/2026" })).body.created).toBe(false);

      // An upload as the raw body, waited for.
      const data = new Uint8Array(randomBytes(12 * 1024 * 1024 + 4321));
      const up = await fetch(`${base}/v1/files?path=/Media/2026&name=${encodeURIComponent("film ż.mp4")}&wait=1`, { method: "POST", headers: { ...H, "content-type": "application/octet-stream" }, body: data });
      const job = (await up.json()) as Record<string, any>;
      expect(up.status).toBe(201);
      expect(job).toMatchObject({ state: "done", size: data.byteLength, result: { path: "/Media/2026/film ż.mp4", sha256: sha(data) } });
      const fileId = String(job.result.id);

      const ls = await j("GET", "/v1/list?path=/Media/2026");
      expect(ls.body.entries.map((e: { name: string }) => e.name)).toEqual(["film ż.mp4"]);

      // Whole file, HEAD, Range: middle (across a piece boundary), suffix, open end, outside → 416.
      const whole = await fetch(`${base}/v1/files/${fileId}`, { headers: H });
      expect(whole.status).toBe(200);
      expect(sha(new Uint8Array(await whole.arrayBuffer()))).toBe(sha(data));
      const head = await fetch(`${base}/v1/files/Media/2026/${encodeURIComponent("film ż.mp4")}`, { method: "HEAD", headers: H });
      expect(head.headers.get("content-length")).toBe(String(data.byteLength));
      expect(head.headers.get("accept-ranges")).toBe("bytes");
      expect(head.headers.get("content-type")).toBe("video/mp4");
      const mid = 10 * 1024 * 1024 - 1000;
      for (const [hdr, from, to] of [
        [`bytes=${mid}-${mid + 4999}`, mid, mid + 4999],
        ["bytes=-777", data.byteLength - 777, data.byteLength - 1],
        [`bytes=${data.byteLength - 10}-`, data.byteLength - 10, data.byteLength - 1],
      ] as [string, number, number][]) {
        const r = await fetch(`${base}/v1/files/${fileId}`, { headers: { ...H, range: hdr } });
        expect(r.status, hdr).toBe(206);
        expect(r.headers.get("content-range")).toBe(`bytes ${from}-${to}/${data.byteLength}`);
        expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(data.subarray(from, to + 1))), hdr).toBe(true);
      }
      expect((await fetch(`${base}/v1/files/${fileId}`, { headers: { ...H, range: `bytes=${data.byteLength}-` } })).status).toBe(416);

      // Two uploads at once (queued, two in flight), then the events stream saw their jobs.
      const ev = await fetch(`${base}/v1/events`, { headers: H });
      const reader = ev.body!.getReader();
      const seen: string[] = [];
      const readEvents = (async () => {
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) return;
          seen.push(dec.decode(value));
        }
      })();
      const blobs = [new Uint8Array(randomBytes(3 * 1024 * 1024)), new Uint8Array(randomBytes(2 * 1024 * 1024 + 9))];
      const started = await Promise.all(blobs.map((b, i) => fetch(`${base}/v1/files?path=/Media&name=p${i}.bin`, { method: "POST", headers: H, body: b }).then((r) => r.json() as Promise<Record<string, any>>)));
      const ends = await Promise.all(started.map((s) => j("GET", `/v1/jobs/${s.id}?wait=1`)));
      expect(ends.map((e) => e.body.state)).toEqual(["done", "done"]);
      expect(ends.map((e) => e.body.result.sha256)).toEqual(blobs.map(sha));
      await new Promise((r) => setTimeout(r, 300));
      expect(seen.join("")).toMatch(/event: job/);
      void reader.cancel();
      await readEvents;

      // Missing folder → 404, ?parents=1 makes it; conflict skip.
      expect((await fetch(`${base}/v1/files?path=/New/Deep&name=a.txt`, { method: "POST", headers: H, body: "x" })).status).toBe(404);
      expect((await fetch(`${base}/v1/files?path=/New/Deep&name=a.txt&parents=1&wait=1`, { method: "POST", headers: H, body: "x" })).status).toBe(201);
      const skip = (await (await fetch(`${base}/v1/files?path=/New/Deep&name=a.txt&on_conflict=skip&wait=1`, { method: "POST", headers: H, body: "y" })).json()) as Record<string, any>;
      expect(skip.result.skipped).toBe(true);

      // Move + rename, then trash.
      const mv = await j("POST", "/v1/move", { from: "/Media/p0.bin", to: "/New", name: "renamed.bin" });
      expect(mv.body.moved[0].path).toBe("/New/renamed.bin");
      expect((await j("DELETE", `/v1/files/${encodeURIComponent("New/renamed.bin")}`)).status).toBe(200);
      expect((await j("GET", "/v1/list?path=/New")).body.entries.map((e: { name: string }) => e.name)).toEqual(["Deep"]);
      expect((await j("GET", "/v1/list?path=/Nope")).status).toBe(404);

      // Revoked in the app: the service says so (health 503, key_refused for a request).
      await S.api.revokeDevice(S.made.deviceId);
      await new Promise((r) => setTimeout(r, 300));
      const rv = await j("POST", "/v1/folders", { path: "/After" });
      expect(rv.status).toBe(503);
      expect(rv.body.error).toBe("key_refused");

      // Stop: returns 0, the spool folder is gone.
      stop.abort();
      expect(await running).toBe(0);
      expect(err.some((l) => l.includes('"stopped"'))).toBe(true);
      expect(err.join("\n")).not.toContain(S.made.text.slice(10, 40));
      expect(err.join("\n")).not.toContain(token);
      expect(existsSync(join(hello.tokenFile, "..", "serve-spool"))).toBe(false);
      writeFileSync(join(cfg, "done"), "");
    });
  });
}

describe("docs/local-api.openapi.json", () => {
  it("is JSON and lists every endpoint the service answers", () => {
    const spec = JSON.parse(readFileSync(new URL("../../../docs/local-api.openapi.json", import.meta.url), "utf8")) as { paths: Record<string, unknown> };
    const src = readFileSync(new URL("../src/serve.ts", import.meta.url), "utf8");
    for (const p of ["/v1/health", "/v1/list", "/v1/folders", "/v1/files", "/v1/move", "/v1/jobs", "/v1/events"]) {
      expect(src, p).toContain(`"${p}`);
      expect(Object.keys(spec.paths), p).toContain(p);
    }
    expect(Object.keys(spec.paths)).toContain("/v1/files/{ref}");
    expect(Object.keys(spec.paths)).toContain("/v1/jobs/{id}");
  });
});

describe("Range header", () => {
  it("parses one range, suffix, open end; refuses outside", () => {
    expect(parseRangeHeader(undefined, 100)).toBeNull();
    expect(parseRangeHeader("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRangeHeader("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRangeHeader("bytes=-5", 100)).toEqual({ start: 95, end: 99 });
    expect(parseRangeHeader("bytes=50-", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRangeHeader("items=0-1", 100)).toBeNull();
    expect(() => parseRangeHeader("bytes=100-", 100)).toThrow();
    expect(() => parseRangeHeader("bytes=-0", 100)).toThrow();
  });
});
