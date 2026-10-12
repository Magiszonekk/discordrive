// plain mode, server side: operations in clear -> the server's replica knows names and keys:
// search, thumbnails (image + video frame, ffmpeg), Range streaming decrypted on the server
// (only overlapping fragments fetched), stream tickets for <video>. Real DdnServer + fake Discord.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelPacer, DiscordWebhookTransport, DriveClient, HttpApi, createAccountHttp, generateDeviceKey, memorySource, newAccountKey, sha256Hex } from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { PlainArbiter, PlainOpCodec } from "@ddv4/metadata-client/plain-ops";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { POOL, serverBlobsMode } from "../src/index.js";
import { PlainExtension, findFfmpeg } from "../src/plain-ext.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});
const FF = findFfmpeg();

async function plainInstance() {
  const fake = new FakeDiscord();
  const origin = await fake.listen();
  cleanups.push(() => fake.close());
  const dir = mkdtempSync(join(tmpdir(), "ddn-plain-"));
  const m = serverBlobsMode({ dataDir: dir, discordApiOrigin: origin, cleanupTickMs: 0, snapshotTickMs: 0, pacer: new ChannelPacer({ perMin: 6000, maxPerMin: 6000, burst: 20 }) });
  const plain = new PlainExtension({ dataDir: dir, blobs: m.blobs });
  const srv = new DdnServer({ dbPath: join(dir, "ddn.db"), mode: "plain", rateLimits: false, extensions: [...m.extensions, plain] });
  const { url } = await srv.listen(0);
  cleanups.push(() => srv.close());
  for (const c of ["1550000000000000401", "1550000000000000402"]) await m.hooks().add(POOL, fake.addWebhook(c).url, new DiscordWebhookTransport({ apiOrigin: origin }));
  const key = newAccountKey();
  const dk = await generateDeviceKey();
  const a = await createAccountHttp(url, dk, key);
  const api = new HttpApi({ baseUrl: url, accountId: a.accountId, deviceId: a.deviceId, key: dk });
  const client = new DriveClient({ device: { id: a.deviceId, name: "p" }, arbiter: new PlainArbiter(new PlainOpCodec(a.accountId), api), blobs: new ServerBlobStore(api), chunkSize: 64 * 1024 });
  return { fake, url, srv, plain, api, client, dir, accountId: a.accountId };
}

describe("plain: the server reads the index", () => {
  it("operations are in clear for the server; search by name; another account cannot read them", async () => {
    const I = await plainInstance();
    await I.client.commitOp({ type: "create", kind: "folder", nodeId: "folderPPPPPPPPPPPPPPPPP", parentId: "root", name: "Wakacje 2026" }, "mkdir");
    await I.client.upload(memorySource(new TextEncoder().encode("hello")), "Zażółć notatki.txt", "folderPPPPPPPPPPPPPPPPP");
    // What the server stores: the payload decodes to the operation, names readable (plain mode).
    const raw = JSON.stringify(I.srv.db.prepare("SELECT entry FROM log").all());
    const decoded = (I.srv.db.prepare("SELECT entry FROM log").all() as { entry: string }[]).map((r) => Buffer.from(JSON.parse(r.entry).payload, "base64").toString("utf8")).join("\n");
    expect(decoded).toContain("Wakacje 2026");
    expect(raw).not.toContain("Wakacje 2026"); // base64 in the row, but trivially readable: no encryption
    const s = await I.api.json<{ hits: { name: string; kind: string }[] }>("GET", `/v1/plain/search?q=${encodeURIComponent("zazolc")}`);
    expect(s.body.hits.map((h) => h.name)).toEqual([]); // nameKey is NFC + case fold, not accent folding
    const s2 = await I.api.json<{ hits: { name: string; kind: string }[] }>("GET", `/v1/plain/search?q=${encodeURIComponent("ŻÓŁĆ")}`);
    expect(s2.body.hits.map((h) => h.name)).toEqual(["Zażółć notatki.txt"]);
    const s3 = await I.api.json<{ hits: { name: string }[] }>("GET", "/v1/plain/search?q=wakacje");
    expect(s3.body.hits.map((h) => h.name)).toEqual(["Wakacje 2026"]);
    // A second account sees nothing of the first.
    const key = newAccountKey();
    const dk = await generateDeviceKey();
    const b = await createAccountHttp(I.url, dk, key);
    const apiB = new HttpApi({ baseUrl: I.url, accountId: b.accountId, deviceId: b.deviceId, key: dk });
    expect((await apiB.json<{ hits: unknown[] }>("GET", "/v1/plain/search?q=wakacje")).body.hits).toEqual([]);
  });

  it("Range streaming on the server: exact bytes, 206 + content-range, only overlapping fragments fetched; ticket for <video>", async () => {
    const I = await plainInstance();
    const data = new Uint8Array(64 * 1024 * 5 + 333).map((_, i) => (i * 7 + (i >> 9)) & 255);
    const up = await I.client.upload(memorySource(data), "film.webm");
    // A .webm starts a thumbnail job in the background (here: not a real video, it fails quietly); let it finish first.
    I.plain.replica(I.accountId);
    await I.plain.idle;
    const before = I.fake.cdnGets;
    const r = await I.api.request("GET", `/v1/plain/file/${up.nodeId}`, { headers: { range: "bytes=200000-200099" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 200000-200099/${data.byteLength}`);
    expect(r.headers.get("content-type")).toBe("video/webm");
    expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(data.subarray(200000, 200100)))).toBe(true);
    // manifest (1) + one fragment (200000 is inside fragment 3): 2 CDN reads, not the whole file
    expect(I.fake.cdnGets - before).toBeLessThanOrEqual(2);
    const whole = await I.api.request("GET", `/v1/plain/file/${up.nodeId}`);
    expect(whole.status).toBe(200);
    expect(await sha256Hex(new Uint8Array(await whole.arrayBuffer()))).toBe(await sha256Hex(data));
    const bad = await I.api.request("GET", `/v1/plain/file/${up.nodeId}`, { headers: { range: `bytes=${data.byteLength + 5}-` } });
    expect(bad.status).toBe(416);
    // <video src> cannot send headers: a ticket URL works without a session, only for that file.
    const t = await I.api.json<{ url: string }>("POST", `/v1/plain/stream/${up.nodeId}`, {});
    const v = await fetch(`${I.url}${t.body.url}`, { headers: { range: "bytes=0-9" } });
    expect(v.status).toBe(206);
    expect(Buffer.from(await v.arrayBuffer()).equals(Buffer.from(data.subarray(0, 10)))).toBe(true);
    expect((await fetch(`${I.url}${t.body.url.replace(up.nodeId, "AAAAAAAAAAAAAAAAAAAAAA")}`)).status).toBe(403);
    expect((await fetch(`${I.url}/v1/plain/file/${up.nodeId}`)).status).toBe(401);
  });

  it.skipIf(!FF)("thumbnails: an image and a video frame, made in the background after the upload (ffmpeg)", async () => {
    const I = await plainInstance();
    const dir = mkdtempSync(join(tmpdir(), "ddn-media-"));
    execFileSync(FF!.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x480:rate=1", "-frames:v", "1", join(dir, "a.png")]);
    execFileSync(FF!.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4", "-c:v", "libvpx-vp9", "-b:v", "200k", "-deadline", "realtime", "-cpu-used", "8", join(dir, "v.webm")]);
    const png = await I.client.upload(memorySource(readFileSync(join(dir, "a.png"))), "zdjęcie.png");
    const vid = await I.client.upload(memorySource(readFileSync(join(dir, "v.webm"))), "klip.webm");
    await I.client.upload(memorySource(new Uint8Array(10)), "dane.bin");
    I.plain.replica(I.accountId);
    await I.plain.idle;
    for (const id of [png.nodeId, vid.nodeId]) {
      const r = await I.api.request("GET", `/v1/plain/thumb/${id}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/jpeg");
      const b = Buffer.from(await r.arrayBuffer());
      expect(b.subarray(0, 2).toString("hex")).toBe("ffd8"); // JPEG
      const dim = execFileSync(FF!.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", "-"], { input: b }).toString().trim();
      const [w, h] = dim.split(",").map(Number);
      expect(Math.max(w!, h!)).toBeLessThanOrEqual(320);
    }
    expect(I.plain.stats.thumbs).toBe(2);
    expect(I.plain.stats.thumbErrors).toBe(0);
  });
});
