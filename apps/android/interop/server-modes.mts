// The phone in an e2ee or plain account (the instance holds the webhooks and posts the blobs), against a REAL
// instance with the server-blobs extensions and a local fake Discord:
//   1. a TS device creates the account, uploads a photo (with its thumbnail) and a file of several fragments
//      through the instance, makes folders;
//   2. the phone (JVM test ServerModeTest, started here through Gradle) pairs, joins from the log (no vault,
//      no client snapshots), reaches the TS device's state hash, reads both files and the thumbnail through
//      the instance (CDN links from it), uploads one (blobs through the instance, a thumbnail as an extra),
//      trashes and purges it and reports the release;
//   3. the TS device downloads the phone's upload and its thumbnail; the instance has the release.
// The webhook URLs never reach the phone (checked: none in anything the instance answered it).
//   npx tsx apps/android/interop/server-modes.mts --mode e2ee|plain
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalState, applyEntry, expiredTrash, initIndex, inTrash, loadSnapshot, MemoryIndexStore, uploadsTouched, RULES_VERSION, ROOT_ID, type IndexSnapshot, type LogEntry, type NodeRecord } from "@ddv4/sync-core";
import { DiscordWebhookTransport, DriveClient, EncryptedArbiter, HttpApi, OpCodec, acceptPairing, createAccountHttp, generateDeviceKey, memorySource, newAccountKey } from "@ddv4/metadata-client";
import { PlainArbiter, PlainOpCodec } from "@ddv4/metadata-client/plain-ops";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { serverBlobsMode, POOL } from "@ddv4/server-discord";

const mi = process.argv.indexOf("--mode");
const MODE = (mi >= 0 ? process.argv[mi + 1] : "e2ee") as "e2ee" | "plain";
const here = dirname(fileURLToPath(import.meta.url));
const androidDir = join(here, "..");
const step = (s: string) => console.error(`[server-mode ${MODE}] ${s}`);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const shaB = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const checks: Record<string, boolean> = {};

const fake = new FakeDiscord();
const origin = await fake.listen();
const instDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-sm-"));
const m = serverBlobsMode({ dataDir: instDir, discordApiOrigin: origin, cleanupTickMs: 0, snapshotTickMs: 0 });
let extensions = m.extensions;
if (MODE === "plain") {
  const { PlainExtension } = await import("@ddv4/server-discord/plain");
  extensions = [...m.extensions, new PlainExtension({ dataDir: instDir, blobs: m.blobs })];
}
const srv = new DdnServer({ rateLimits: false, mode: MODE, extensions });
const { url } = await srv.listen(0, "127.0.0.1");
const pool = [fake.addWebhook("1550000000000000501"), fake.addWebhook("1550000000000000502")];
for (const h of pool) await m.hooks().add(POOL, h.url, new DiscordWebhookTransport({ apiOrigin: origin }));

step("TS device: account, folders, a photo with a thumbnail and a file of several fragments through the instance");
const key = newAccountKey();
const dk = await generateDeviceKey(true);
const r0 = await createAccountHttp(url, dk, key);
const api = new HttpApi({ baseUrl: url, accountId: r0.accountId, deviceId: r0.deviceId, key: dk, instanceId: r0.instanceId });
const arbiter = () => (MODE === "plain" ? new PlainArbiter(new PlainOpCodec(r0.accountId), api) : new EncryptedArbiter(new OpCodec(key, r0.accountId), api));
const mk = () => new DriveClient({ device: { id: r0.deviceId, name: "laptop" }, arbiter: arbiter(), blobs: new ServerBlobStore(api, { fetchCdn: async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer()) }), chunkSize: 64 * 1024 });
let ts = mk();
for (let i = 1; i <= 5; i++) await ts.commitOp({ type: "create", kind: "folder", nodeId: `fold-${String(i).padStart(10, "0")}`, parentId: ROOT_ID, name: `Album ${i}` }, "mkdir");
const photo = new Uint8Array(randomBytes(90_000));
const thumb = new Uint8Array(randomBytes(4_000));
const big = new Uint8Array(randomBytes(300_011));
const ups: Record<string, { sha: string; size: number }> = {};
await ts.upload(memorySource(photo), "Zdjęcie Ż.jpg", "fold-0000000001", { previews: Promise.resolve([{ kind: "t", mime: "image/webp", width: 320, height: 240, data: thumb }] as never) });
ups["Zdjęcie Ż.jpg"] = { sha: shaB(photo), size: photo.byteLength };
await ts.upload(memorySource(big), "duży.bin", "fold-0000000001");
ups["duży.bin"] = { sha: shaB(big), size: big.byteLength };
await ts.commitOp({ type: "trash", nodeId: "fold-0000000005" }, "trash");

const row = (n: NodeRecord) => ({ id: n.id, name: n.name, kind: n.kind, parent: n.parentId, size: n.content?.sizeBytes ?? null, ref: n.content?.manifestRef ?? null, sha: n.content?.plaintextSha256 ?? null, at: n.content?.createdAt ?? 0, up: n.content?.uploadId ?? null, ...(n.trashed ? { tat: n.trashed.at } : {}) });
type Req = { id: number; m: string; a?: unknown };
let store = initIndex(new MemoryIndexStore());
let paired: { sas: string; deviceId: string } | null = null;
// Everything the instance answered the phone is not seen here; the phone reports what it saw (no webhook URL).
function core(q: Req): unknown {
  switch (q.m) {
    case "reset": store = initIndex(new MemoryIndexStore()); return null;
    case "rules": return RULES_VERSION;
    case "head": return store.getMeta().headSeq;
    case "load": store = loadSnapshot(q.a as IndexSnapshot, new MemoryIndexStore()); return null;
    case "apply": return (q.a as LogEntry[]).map((e) => applyEntry(store, e));
    case "guard": return uploadsTouched(q.a as never);
    case "sha": return sha(canonicalState(store));
    case "children": return [...store.childIds(q.a as string)].map((id) => store.getNode(id)!).filter((n) => !n.trashed).map(row);
    case "node": { const n = store.getNode(q.a as string); return n ? [{ ...row(n), ...(inTrash(store, n.id) ? { tat: n.trashed?.at ?? 0 } : {}) }] : []; }
    case "media": return [...store.allNodes()].filter((n) => n.kind === "file" && n.content && !inTrash(store, n.id)).sort((a, b) => b.content!.createdAt - a.content!.createdAt).map(row);
    case "trash": return [...store.allNodes()].filter((n) => n.trashed && !(n.parentId !== null && inTrash(store, n.parentId))).map((n) => ({ ...row(n), tat: n.trashed!.at }));
    case "expired": return expiredTrash(store, q.a as number);
    case "released": return [...store.allUploads()].filter((u) => u.status === "released" && u.ended && u.ended.seq > (q.a as number)).map((u) => [u.id, u.ended!.at, u.ended!.seq]);
    case "albums": return [];
    default: throw new Error(`unknown ${q.m}`);
  }
}
async function handle(q: Req): Promise<unknown> {
  if (q.m === "mode") return MODE;
  if (q.m === "offer") {
    paired = await acceptPairing(q.a as string, { accountId: r0.accountId, accountKey: key.rawB64, fromDevice: "laptop" }, (pub) => api.addDevice(pub), api.pairingMailbox());
    return { sas: paired.sas };
  }
  if (q.m === "expect") {
    await ts.pull();
    return { sha: sha(canonicalState(ts.store)), head: ts.store.getMeta().headSeq };
  }
  if (q.m === "files") return { folder: "fold-0000000001", files: ups, thumbSha: shaB(thumb) };
  if (q.m === "phoneUpload") {
    const a = q.a as { folder: string; name: string; sha: string; thumbSha: string };
    ts = mk();
    await ts.pull();
    const node = ts.list(a.folder).find((k) => k.name === a.name);
    if (!node) return { sha: false, thumb: false };
    const parts: Uint8Array[] = [];
    await ts.download(node.id, { write: async (d) => void parts.push(d.slice()) });
    const h = createHash("sha256");
    for (const x of parts) h.update(x);
    const pv = await ts.readPreview((ts.store.getNode(node.id)!.content as { manifestRef: string }).manifestRef, "t");
    return { sha: h.digest("hex") === a.sha, thumb: !!pv && shaB(pv.data) === a.thumbSha };
  }
  // The instance's record of an upload (its state: "released" after the phone reported it).
  if (q.m === "uploadState") {
    const row = srv.db.prepare("SELECT state FROM s_uploads WHERE account_id = ? AND upload_id = ?").get(r0.accountId, q.a as string) as { state: string } | undefined;
    return row?.state ?? null;
  }
  if (q.m === "secrets") return pool.map((h) => h.url.split("/").pop()!);
  if (q.m === "done") return (Object.assign(checks, q.a as Record<string, boolean>), null);
  return core(q);
}
const rpc = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    try {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, r: (await handle(JSON.parse(body) as Req)) ?? null }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, e: String((e as Error)?.stack ?? e) }));
    }
  });
});
await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
const rpcUrl = `http://127.0.0.1:${(rpc.address() as { port: number }).port}`;

step("phone: JVM ServerModeTest through Gradle");
const child = spawn("./gradlew", ["--no-daemon", "-q", ":core:ddn:test", "--tests", "*ServerModeTest*", "-PddnInterop=1", "--rerun-tasks"], {
  cwd: androidDir,
  env: { ...process.env, DDN_INTEROP_SERVER: url, DDN_INTEROP_DISCORD: origin, DDN_INTEROP_RPC: rpcUrl },
  stdio: ["ignore", "inherit", "inherit"],
});
const code: number = await new Promise((res) => child.on("close", (c) => res(c ?? 1)));
checks.jvmTestPassed = code === 0;
checks.paired = !!paired;
rpc.close();
await srv.close();
await fake.close();
const ok = Object.values(checks).every(Boolean) && Object.keys(checks).length > 5;
console.log(JSON.stringify({ ok, mode: MODE, checks }, null, 1));
process.exit(ok ? 0 : 1);
