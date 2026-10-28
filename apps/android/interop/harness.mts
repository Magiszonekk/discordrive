// Live interop between the phone's account layer (Kotlin, apps/android/core/ddn) and the TypeScript client
// against a REAL instance (DdnServer) and a local fake Discord, both on 127.0.0.1:
//   1. a TS device creates the account, a vault with two channels, 40 folders, a snapshot (base + segment);
//   2. the phone (JVM test InteropTest, started by this script through Gradle) pairs as a NEW device with
//      the QR offer: the TS device accepts it, both show the same code;
//   3. the phone joins: vault, pointer, base from Discord, the log tail from the instance; its state must
//      hash like the TS device's; it names itself, makes a folder, adds a channel to the vault;
//   4. the TS device pulls: sees the phone's folder, the phone's channel, the phone's name.
// The JVM test has no JS engine (that is :syncjs, checked on a device), so its sync core calls come back
// here over a small JSON RPC on 127.0.0.1 (the same sync core the phone runs in its engine), together with
// the steps the TS device does (accept the pairing offer, check the phone's changes).
//   npx tsx apps/android/interop/harness.mts            JVM (Gradle :core:ddn InteropTest; needs JDK 17)
//   npx tsx apps/android/interop/harness.mts --device   the phone: the installed :syncjs test APK, its own JS
//        engine (adb reverse to these servers; ANDROID_SERIAL picks the device; --engine quickjs forces QuickJS)
//   --app   the app's browsing screens on the device (BrowseUiTest of the installed app + its test APK);
//        screenshots: adb pull /sdcard/Android/data/io.github.magiszonekk.discordrive/files/shots
//   --discord-hooks <file>   real Discord instead of the fake: a file with 3 webhook URLs of a test server
//        (2 for the account, 1 the phone adds); every message posted is deleted at the end
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { takeSnapshot, nameKey, RULES_VERSION, canonicalState, ROOT_ID, GALLERY_ID, applyEntry, expiredTrash, initIndex, inTrash, loadSnapshot, MemoryIndexStore, uploadsTouched, rulesVersionFor, spaceOf, WRITE_RULES_VERSION, type IndexSnapshot, type LogEntry, type NodeRecord } from "@ddv4/sync-core";
import {
  ChannelPacer,
  DiscordWebhookTransport,
  EncryptedArbiter,
  HttpApi,
  MetadataClient,
  OpCodec,
  WebhookVault,
  acceptPairing,
  clientBlobIO,
  createAccountHttp,
  createPointerMessage,
  decodeManifestRef,
  searchItems,
  AccountSettingsStore,
  generateDeviceKey,
  inspectForVault,
  newAccountKey,
  openDeviceName,
  sealDeviceName,
  toWebhookRefs,
  writeSnapshot,
} from "@ddv4/metadata-client";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";

const here = dirname(fileURLToPath(import.meta.url));
const androidDir = join(here, "..");
const step = (s: string) => console.error(`[interop] ${s}`);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const checks: Record<string, boolean> = {};
const check = (k: string, v: boolean) => ((checks[k] = v), v || console.error(`[interop] FAIL ${k}`));

const hi = process.argv.indexOf("--discord-hooks");
const realHooks = hi >= 0 ? (await import("node:fs")).readFileSync(process.argv[hi + 1]!, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : null;
if (realHooks && realHooks.length < 3) throw new Error("--discord-hooks: 3 webhook URLs");
const fake = new FakeDiscord();
// Real Discord: no origin mapping (an empty origin tells the phone to use discord.com itself).
const discordOrigin = realHooks ? "" : await fake.listen();
// "settingsOff": the instance answers as one without account settings (an older server: 404).
let settingsOff = false;
const srv = new DdnServer({ rateLimits: false, extensions: [{ name: "old-server", route: async (r) => (settingsOff && r.path === "/v1/settings" ? (r.send(404, { error: "not_found" }), true) : false) }] });
const { url } = await srv.listen(0, "127.0.0.1");
const transport = new DiscordWebhookTransport(realHooks ? {} : { apiOrigin: discordOrigin });
const hookUrl = (i: number, ch: string) => (realHooks ? { url: realHooks[i]!, id: realHooks[i]!.split("/").at(-2)!, channelId: "" } : fake.addWebhook(ch));

step("TS device: account, vault with two channels, 40 folders, snapshot");
const key = newAccountKey();
const dk = await generateDeviceKey(true);
const r0 = await createAccountHttp(url, dk, key);
const api = new HttpApi({ baseUrl: url, accountId: r0.accountId, deviceId: r0.deviceId, key: dk, instanceId: r0.instanceId });
const vault = new WebhookVault(api, key, r0.accountId);
const h1 = hookUrl(0, "1550000000000000301");
const h2 = hookUrl(1, "1550000000000000302");
for (const h of [h1, h2]) await vault.addWebhook(await inspectForVault(transport, h.url));
const pacer = new ChannelPacer(realHooks ? {} : { perMin: 1e6, maxPerMin: 1e6, burst: 1e6 });
// Messages posted per webhook (real Discord: deleted at the end).
const postedOn = new Map<string, string[]>();
const post0 = transport.postFile.bind(transport);
transport.postFile = async (h, d, f, ...r) => {
  const x = await post0(h, d, f, ...r);
  postedOn.set(h.id, [...(postedOn.get(h.id) ?? []), x.messageId]);
  return x;
};
const mk = async () => new MetadataClient({ device: { id: r0.deviceId, name: "laptop" }, arbiter: new EncryptedArbiter(new OpCodec(key, r0.accountId), api), transport, webhooks: toWebhookRefs(await vault.load()), pacer, chunkSize: 64 * 1024 });
let ts = await mk();
const io = clientBlobIO(ts, transport, 4096);
const loc = await createPointerMessage(io, key, r0.accountId, ts.webhook(h1.id));
await vault.update((x) => ((x.pointer = loc), x));
for (let i = 1; i <= 40; i++) await ts.commitOp({ type: "create", kind: "folder", nodeId: `fold-${String(i).padStart(10, "0")}`, parentId: ROOT_ID, name: `Zdjęcia ${i}` }, "mkdir");
await writeSnapshot({ io, key, accountId: r0.accountId, pointer: loc, log: api, store: ts.store, now: () => Date.now() }, "base");
// Files the phone reads: a photo with its thumbnail and preview (made here, as the web app does), a video,
// a file of several fragments (chunkSize 64 KiB). Their bytes and hashes go to the phone through "files".
const { createHash: ch } = await import("node:crypto");
const { memorySource } = await import("@ddv4/metadata-client");
const execFile = (await import("node:child_process")).execFileSync;
const tmp = (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "ddn-interop-"));
const fsx = await import("node:fs");
let haveFfmpeg = true;
try {
  execFile("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x480", "-frames:v", "1", join(tmp, "p.jpg")]);
  execFile("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240", "-frames:v", "1", "-c:v", "libwebp", join(tmp, "t.webp")]);
  execFile("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=4", "-c:v", "libvpx-vp9", "-b:v", "400k", "-deadline", "realtime", "-cpu-used", "8", join(tmp, "v.webm")]);
} catch {
  haveFfmpeg = false;
  step("no ffmpeg: random bytes instead of a photo and a video (no thumbnail checks)");
}
const { randomBytes } = await import("node:crypto");
const rnd = (n: number) => new Uint8Array(randomBytes(n));
const photo = haveFfmpeg ? new Uint8Array(fsx.readFileSync(join(tmp, "p.jpg"))) : rnd(90_000);
const thumb = haveFfmpeg ? new Uint8Array(fsx.readFileSync(join(tmp, "t.webp"))) : null;
const video = haveFfmpeg ? new Uint8Array(fsx.readFileSync(join(tmp, "v.webm"))) : rnd(150_000);
const big = rnd(300_011);
const shaHex = (b: Uint8Array) => ch("sha256").update(b).digest("hex");
const ups: Record<string, { nodeId: string; sha: string; size: number }> = {};
for (const [name, data, pv] of [
  ["Wakacje Ż.jpg", photo, thumb ? [{ kind: "t" as const, mime: "image/webp", width: 320, height: 240, data: thumb }, { kind: "p" as const, mime: "image/webp", width: 320, height: 240, data: thumb }] : null],
  ["film.webm", video, null],
  ["duży.bin", big, null],
] as const) {
  // The photo as picked in the browser: its lastModified (2024-05-17) goes into the manifest (search by date).
  const taken = name === "Wakacje Ż.jpg" ? { takenAt: Date.UTC(2024, 4, 17, 10, 0, 0) } : {};
  const r = await ts.upload(memorySource(data), name, "fold-0000000001", { ...(pv ? { previews: Promise.resolve(pv as never) } : {}), ...taken });
  ups[name] = { nodeId: r.nodeId, sha: shaHex(data), size: data.byteLength };
}
// After the base: entries the phone gets from the instance (the tail), not from the snapshot.
await ts.commitOp({ type: "rename", nodeId: "fold-0000000003", name: "Dokumenty" }, "rename");
await ts.commitOp({ type: "trash", nodeId: "fold-0000000004" }, "trash");

const row = (n: NodeRecord) => ({ id: n.id, name: n.name, kind: n.kind, parent: n.parentId, size: n.content?.sizeBytes ?? null, ref: n.content?.manifestRef ?? null, sha: n.content?.plaintextSha256 ?? null, at: n.content?.createdAt ?? 0, up: n.content?.uploadId ?? null });
// The phone's sync core over the RPC (InteropTest.RpcReplica implements IndexReplica with it).
type Req = { id: number; m: string; a?: unknown };
let store = initIndex(new MemoryIndexStore());
function core(q: Req): unknown {
  switch (q.m) {
    case "reset": store = initIndex(new MemoryIndexStore()); return null;
    // The Safe's tree (JsIndexReplica __ddnSafe): a snapshot in, the rules applied, a snapshot out.
    case "safeEmpty": return JSON.stringify(takeSnapshot(initIndex(new MemoryIndexStore())));
    case "safeApply": {
      const a = q.a as { tree: string; entry: LogEntry };
      const t = loadSnapshot(JSON.parse(a.tree) as IndexSnapshot, new MemoryIndexStore());
      const before = new Map<string, string>();
      for (const n of t.allNodes()) if (n.kind === "file" && n.content) before.set(n.content.uploadId, n.content.manifestRef);
      const result = applyEntry(t, { ...a.entry, rulesVersion: RULES_VERSION });
      const released = [...t.allUploads()].filter((u) => u.status === "released" && u.ended?.seq === a.entry.seq && before.has(u.id)).map((u) => [u.id, before.get(u.id)!]);
      return JSON.stringify({ tree: takeSnapshot(t), result, released });
    }
    case "safeChildren": {
      const a = q.a as { tree: string; parent: string };
      const t = loadSnapshot(JSON.parse(a.tree) as IndexSnapshot, new MemoryIndexStore());
      return [...t.childIds(a.parent)].map((id) => t.getNode(id)!).filter((n) => !n.trashed).sort((x, y) => (x.kind !== y.kind ? (x.kind === "folder" ? -1 : 1) : nameKey(x.name) < nameKey(y.name) ? -1 : nameKey(x.name) > nameKey(y.name) ? 1 : x.id < y.id ? -1 : 1)).map(row);
    }
    case "rules": return WRITE_RULES_VERSION;
    case "rulesFor": return rulesVersionFor(store, q.a as never, WRITE_RULES_VERSION);
    case "space": return store.getNode(q.a as string) ? spaceOf(store, q.a as string) : "drive";
    case "head": return store.getMeta().headSeq;
    case "load": store = loadSnapshot(q.a as IndexSnapshot, new MemoryIndexStore()); return null;
    case "apply": return (q.a as LogEntry[]).map((e) => applyEntry(store, e));
    case "guard": return uploadsTouched(q.a as never);
    case "sha": return sha(canonicalState(store));
    case "children": return [...store.childIds(q.a as string)].map((id) => store.getNode(id)!).filter((n) => !n.trashed).map(row);
    case "media": {
      const { e: ex, s: sp } = Array.isArray(q.a) ? { e: q.a as string[], s: undefined } : (q.a as { e: string[]; s?: string });
      return [...store.allNodes()].filter((n) => n.kind === "file" && n.content && !inTrash(store, n.id) && ex.some((e) => n.name.toLowerCase().endsWith(e)) && (!sp || spaceOf(store, n.id) === sp)).sort((a, b) => b.content!.createdAt - a.content!.createdAt).map(row);
    }
    case "trash":
      return [...store.allNodes()]
        .filter((n) => n.trashed && !(n.parentId !== null && inTrash(store, n.parentId)))
        .sort((a, b) => b.trashed!.at - a.trashed!.at || (a.id < b.id ? -1 : 1))
        .map((n) => ({ ...row(n), tat: n.trashed!.at }));
    case "expired": return expiredTrash(store, q.a as number);
    case "node": { const n = store.getNode(q.a as string); return n ? [{ ...row(n), ...(inTrash(store, n.id) ? { tat: n.trashed?.at ?? 0 } : {}) }] : []; }
    case "released": return [...store.allUploads()].filter((u) => u.status === "released" && u.ended && u.ended.seq > (q.a as number)).map((u) => [u.id, u.ended!.at, u.ended!.seq]).sort((a, b) => (a[2] as number) - (b[2] as number));
    case "albums": {
      const { e: ex, s: sp } = Array.isArray(q.a) ? { e: q.a as string[], s: undefined } : (q.a as { e: string[]; s?: string });
      const files = [...store.allNodes()]
        .filter((n) => n.kind === "file" && n.content && !inTrash(store, n.id) && ex.some((e) => n.name.toLowerCase().endsWith(e)) && (!sp || spaceOf(store, n.id) === sp) && !(sp === "gallery" && n.parentId === GALLERY_ID))
        .sort((a, b) => b.content!.createdAt - a.content!.createdAt || (a.id < b.id ? -1 : 1));
      const by = new Map<string, { id: string; name: string; count: number; cover: ReturnType<typeof row> }>();
      for (const n of files) {
        const f = store.getNode(n.parentId!);
        if (!f) continue;
        const a = by.get(f.id) ?? { id: f.id, name: f.name, count: 0, cover: row(n) };
        a.count++;
        by.set(f.id, a);
      }
      return [...by.values()];
    }
    default: throw new Error(`unknown ${q.m}`);
  }
}

const tsState = () => sha(canonicalState(ts.store));
let savedHooks: Map<string, unknown> | null = null;
let paired: { sas: string; deviceId: string } | null = null;

async function handle(q: Req): Promise<unknown> {
  if (q.m === "offer") {
    // The phone showed its QR: the TS device accepts it (registers the key, leaves the sealed bundle).
    const a = await acceptPairing(q.a as string, { accountId: r0.accountId, accountKey: key.rawB64, fromDevice: "laptop" }, (pub) => api.addDevice(pub), api.pairingMailbox());
    paired = a;
    return { sas: a.sas };
  }
  if (q.m === "expect") {
    // What the phone must reach: the TS device's state (its log, pulled).
    await ts.pull();
    return { sha: tsState(), head: ts.store.getMeta().headSeq };
  }
  if (q.m === "verify") {
    // The phone made changes: the TS device pulls and checks them.
    ts = await mk();
    await ts.pull();
    const v = await vault.load();
    const kids = ts.list(ROOT_ID);
    const devs = await api.listDevices();
    const me = devs.find((d) => d.deviceId === paired?.deviceId);
    return {
      sha: tsState(),
      head: ts.store.getMeta().headSeq,
      phoneFolder: kids.some((k) => k.name === "Z telefonu ż" && k.kind === "folder"),
      webhooks: v.webhooks.map((w) => w.id),
      phoneName: me ? await openDeviceName(key, r0.accountId, me.deviceId, me.nameSealed) : null,
      devices: devs.length,
    };
  }
  if (q.m === "bigMb") return Number(process.env.DDN_INTEROP_BIG_MB ?? 0);
  // The phone used the Gallery: the TS device sees the photo in the Gallery (not under Files) and the rules
  // versions it was written with.
  if (q.m === "gallery") {
    const t2 = await mk();
    await t2.pull();
    const a = q.a as { name: string; album: string };
    const s = t2.store;
    const hit = [...s.allNodes()].find((n) => n.name === a.name && n.content && !inTrash(s, n.id));
    const album = [...s.childIds(GALLERY_ID)].map((id) => s.getNode(id)!).find((n) => n.name === a.album && n.kind === "folder");
    // The envelope's rules version is in clear for the server: read it from the raw log.
    const raw: { rulesVersion: number }[] = [];
    for (let after = 0; ; ) {
      const b = await api.read(after, 1000);
      if (!b.length) break;
      raw.push(...b);
      after = b.at(-1)!.seq;
    }
    return {
      inGallery: !!hit && spaceOf(s, hit.id) === "gallery" && hit.parentId === album?.id,
      notUnderFiles: !!hit && ![...s.childIds(ROOT_ID)].some((id) => id === hit.id),
      rules4: raw.filter((e) => e.rulesVersion === 4).length,
    };
  }
  if (q.m === "speed") {
    const x = q.a as { mb: number; ms: number; chunks: number; r429: number };
    step(`phone upload: ${x.mb} MiB in ${x.chunks} fragments, ${(x.ms / 1000).toFixed(1)} s = ${((x.mb * 1.048576 * 1000) / x.ms).toFixed(1)} MB/s, 429: ${x.r429}`);
    return null;
  }
  if (q.m === "messages") return realHooks ? -1 : (fake as unknown as { messages: Map<string, unknown> }).messages.size;
  if (q.m === "phoneUpload") {
    // The phone uploaded a file: the TS device downloads it and opens its thumbnail.
    const a = q.a as { folder: string; name: string; sha: string; thumbSha: string };
    const t2 = await mk();
    await t2.pull();
    const node = t2.list(a.folder).find((k) => k.name === a.name);
    if (!node) return { sha: false, thumb: false, why: "not listed" };
    const parts: Uint8Array[] = [];
    await t2.download(node.id, { write: async (d) => void parts.push(d.slice()) });
    const h = ch("sha256");
    for (const x of parts) h.update(x);
    const pv = await t2.readPreview((t2.store.getNode(node.id)!.content as { manifestRef: string }).manifestRef, "t");
    return { sha: h.digest("hex") === a.sha, thumb: !!pv && shaHex(pv.data) === a.thumbSha && pv.width === 320, thumbW: pv ? Math.min(pv.width, pv.height) : 0 };
  }
  // The web client opens a file's thumbnail (after the phone edited its message): its SHA-256.
  // The web client reads the AI description the phone stored with a file (the same name and key derivation).
  if (q.m === "aiCalls") return aiCalls;
  if (q.m === "settingsOff") return (settingsOff = q.a === true);
  // The web client reads the account's settings the phone stored (the AI endpoint, without the key).
  if (q.m === "aiSettings") {
    const st = await new AccountSettingsStore(api, key, r0.accountId).load();
    return st.ai ? { url: st.ai.url, model: st.ai.model, hasKey: !!st.ai.key } : null;
  }
  // The manifest of a file the phone uploaded, as the web client reads it: its takenAt.
  if (q.m === "takenOf") {
    const t2 = await mk();
    await t2.pull();
    const n = [...t2.store.allNodes()].find((x) => x.name === (q.a as string) && x.content);
    if (!n) return null;
    return (await t2.loadManifest(n.content!.manifestRef)).manifest.takenAt ?? null;
  }
  if (q.m === "aiPolish") return aiPolish;
  // The web client reads the AI description the phone stored with a file (metadata-client readDescription)
  // and finds the file with its search (the same code the web app runs).
  if (q.m === "descriptionOf") {
    const t2 = await mk();
    await t2.pull();
    const n = t2.store.getNode(q.a as string)!;
    const d = await t2.readDescription((n.content as { manifestRef: string }).manifestRef);
    if (!d) return null;
    const hit = searchItems([{ id: n.id, name: n.name, date: 0, record: d }], d.tags[0] ?? d.description).length === 1;
    return { ...d, webSearchFinds: hit };
  }

  if (q.m === "thumbOf") {
    const t2 = await mk();
    await t2.pull();
    const pv = await t2.readPreview((t2.store.getNode(q.a as string)!.content as { manifestRef: string }).manifestRef, "t");
    return pv ? shaHex(pv.data) : "";
  }
  if (q.m === "files") return { folder: "fold-0000000001", files: ups, thumbSha: thumb ? shaHex(thumb) : null };
  // The webhooks of the account removed on Discord and back (the phone's failed upload, then Retry).
  if (q.m === "hooksOff" || q.m === "hooksOn") {
    const hooks = (fake as unknown as { hooks: Map<string, unknown> }).hooks;
    if (q.m === "hooksOff") {
      savedHooks = new Map(hooks);
      const only = q.a as string[] | null;
      if (Array.isArray(only)) for (const id of only) hooks.delete(id); else hooks.clear();
    }
    else if (savedHooks) for (const [k, v] of savedHooks) hooks.set(k, v);
    return realHooks ? -1 : hooks.size;
  }
  if (q.m === "newHook") {
    const h = hookUrl(2, "1550000000000000303");
    return realHooks ? { ...h, channelId: (await inspectForVault(transport, h.url)).channelId } : h;
  }
  // The Safe the phone made (metadata only: its pieces on the account's webhooks): the web opens it with the
  // password and reads the file the phone moved in.
  if (q.m === "safeWeb") {
    const a = q.a as { password: string; file: string; sha: string };
    const { SafeStore, SafeTree, safeChildren } = await import("@ddv4/metadata-client");
    ts = await mk();
    const store = new SafeStore<import("@ddv4/metadata-client").SafeTreeState>(api, key, r0.accountId);
    const tree = new SafeTree(store, { id: r0.deviceId, name: "laptop" });
    const u = await store.unlock(a.password);
    const f = safeChildren(u, "root").find((n) => n.name === a.file);
    if (!f) return { fileSame: false };
    const parts: Uint8Array[] = [];
    await tree.download(u, ts, f.id, { write: async (d) => void parts.push(d.slice()) });
    const h = createHash("sha256");
    for (const x of parts) h.update(x);
    return { fileSame: h.digest("hex") === a.sha };
  }
  if (q.m === "rulesNewer") {
    // Another device, on a newer app, writes an entry with a rules version this build does not replay (the
    // instance of this build would refuse it, so it goes straight into its log, as a newer instance would keep it).
    const head = (srv.db.prepare("SELECT MAX(seq) AS s FROM log WHERE account_id = ?").get(r0.accountId) as { s: number }).s;
    const env = await new OpCodec(key, r0.accountId).encrypt({ opId: `newer${Date.now()}`, rulesVersion: RULES_VERSION + 1, baseSeq: head, device: { id: r0.deviceId, name: "laptop" }, createdAt: Date.now(), op: { type: "rename", nodeId: "fold-0000000002", name: "Nowsza" } } as never);
    const entry = { ...env, seq: head + 1, serverTime: Date.now() };
    srv.db.prepare("INSERT INTO log (account_id, seq, op_id, entry) VALUES (?, ?, ?, ?)").run(r0.accountId, entry.seq, entry.opId, JSON.stringify(entry));
    (srv as unknown as { seqs: Map<string, unknown> }).seqs.delete(r0.accountId);
    return entry.seq;
  }
  if (q.m === "done") {
    Object.assign(checks, q.a as Record<string, boolean>);
    return null;
  }
  return core(q);
}

const rpc = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    const q = JSON.parse(body) as Req;
    try {
      const r = await handle(q);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, r: r ?? null }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, e: String((e as Error)?.stack ?? e) }));
    }
  });
});
await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
const rpcUrl = `http://127.0.0.1:${(rpc.address() as { port: number }).port}`;

// A fake of the GitHub releases API for the app's update check (--updates-apk <path to an APK of a higher
// versionCode> --updates-code N): android-main-build with android-build.json and the APK.
const ua = process.argv.indexOf("--updates-apk");
let updatesApi = "";
if (ua >= 0) {
  const apk = fsx.readFileSync(process.argv[ua + 1]!);
  const code = Number(process.argv[process.argv.indexOf("--updates-code") + 1] ?? 999999);
  const sha = ch("sha256").update(apk).digest("hex");
  const up = createServer((req, res) => {
    const base = `http://127.0.0.1:${(up.address() as { port: number }).port}`;
    if (req.url === "/repos/Magiszonekk/discordrive/releases/tags/android-main-build")
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ published_at: new Date().toISOString(), body: "test", assets: [{ name: "android-build.json", browser_download_url: `${base}/a/info`, size: 100 }, { name: "app-b.apk", browser_download_url: `${base}/a/apk`, size: apk.length }] }));
    if (req.url === "/a/info") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ versionCode: code, versionName: `0.1.0-${code}`, commit: "test", apk: "app-b.apk", sha256: sha }));
    if (req.url === "/a/apk") return res.writeHead(200, { "content-type": "application/vnd.android.package-archive", "content-length": String(apk.length) }).end(apk);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  updatesApi = `http://127.0.0.1:${(up.address() as { port: number }).port}`;
  step(`fake releases API for the update check: versionCode ${code}, ${apk.length} B`);
}

// A fake AI endpoint in the OpenAI format for the app's AI descriptions: /v1/models, /v1/chat/completions
// (an answer per picture; the key "bad" is refused; the first call of a run answers 429 once).
let aiApi = "";
let aiCalls = 0;
let aiPolish = 0;
{
  let first429 = true;
  const ai = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer good-key") return res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad key"}');
      if (req.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fake-vision" }, { id: "fake-text" }] }));
      if (req.url === "/v1/chat/completions") {
        if (first429 && aiCalls > 0) { first429 = false; return res.writeHead(429, { "retry-after": "1" }).end("{}"); }
        aiCalls++;
        if (body.includes("po polsku")) aiPolish++;
        const hasImage = body.includes("data:image/jpeg;base64,");
        const content = hasImage ? JSON.stringify({ description: `Obraz testowy numer ${aiCalls}`, tags: ["test", "pasy"], text: "DISCORDRIVE 42" }) : "no image";
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content } }] }));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => ai.listen(0, "127.0.0.1", r));
  aiApi = `http://127.0.0.1:${(ai.address() as { port: number }).port}`;
}

const appUi = process.argv.includes("--app");
const onDevice = process.argv.includes("--device") || appUi;
const ei = process.argv.indexOf("--engine");
const engine = ei >= 0 ? process.argv[ei + 1] : "";
let child;
if (onDevice) {
  step("phone: InteropDeviceTest on the device (adb reverse to the servers here)");
  const port = (u: string) => new URL(u).port;
  for (const u of [url, discordOrigin, rpcUrl, updatesApi, aiApi].filter(Boolean)) spawnSync("adb", ["reverse", `tcp:${port(u)}`, `tcp:${port(u)}`], { stdio: "inherit" });
  const target = appUi ? ["com.discordrive.gallery.BrowseUiTest", "io.github.magiszonekk.discordrive.test"] : ["io.github.magiszonekk.discordrive.syncjs.InteropDeviceTest", "io.github.magiszonekk.discordrive.syncjs.test"];
  child = spawn("adb", ["shell", "am", "instrument", "-w", "-e", "class", target[0]!, "-e", "ddnRpc", rpcUrl, "-e", "ddnServer", url, "-e", "ddnDiscord", discordOrigin || "none", ...(updatesApi ? ["-e", "ddnUpdates", updatesApi] : []), "-e", "ddnAi", aiApi, ...(engine ? ["-e", "ddnEngine", engine] : []), `${target[1]}/androidx.test.runner.AndroidJUnitRunner`], { stdio: ["ignore", "pipe", "inherit"] });
} else {
  step("phone: JVM InteropTest through Gradle (pairing, join, operations)");
  child = spawn(process.platform === "win32" ? "gradlew.bat" : "./gradlew", ["--no-daemon", "-q", ":core:ddn:test", "--tests", "*InteropTest*", "-PddnInterop=1", "--rerun-tasks"], {
    cwd: androidDir,
    env: { ...process.env, DDN_INTEROP_SERVER: url, DDN_INTEROP_DISCORD: discordOrigin, DDN_INTEROP_RPC: rpcUrl },
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
  });
}
// Ended early (Ctrl+C, a timeout): the device keeps no reverse ports to servers that are gone.
const cleanup = () => { if (onDevice) spawnSync("adb", ["reverse", "--remove-all"], { stdio: "ignore" }); };
process.on("SIGINT", () => (cleanup(), process.exit(130)));
process.on("SIGTERM", () => (cleanup(), process.exit(143)));
let childOut = "";
child.stdout!.on("data", (d: Buffer) => ((childOut += d.toString()), process.stderr.write(d)));
const code: number = await new Promise((res) => child.on("close", (c) => res(c ?? 1)));
// am instrument exits 0 even when a test fails: its report says OK or FAILURES.
check(onDevice ? "deviceTestPassed" : "jvmTestPassed", code === 0 && (!onDevice || /\nOK \(1 test\)/.test(childOut)));
if (onDevice) for (const u of [url, discordOrigin, rpcUrl, updatesApi, aiApi].filter(Boolean)) spawnSync("adb", ["reverse", "--remove", `tcp:${new URL(u).port}`], { stdio: "ignore" });
check("pairedSameCode", !!paired);
void sealDeviceName;
rpc.close();
if (realHooks) {
  // Delete what this run posted (snapshot objects, the pointer).
  let n = 0;
  for (const u of realHooks) {
    const hook = { id: u.split("/").at(-2)!, url: u };
    for (const m of postedOn.get(hook.id) ?? []) await transport.deleteMessage(hook, m).then(() => n++).catch(() => {});
  }
  step(`deleted ${n} messages from Discord`);
}
await srv.close();
await fake.close();
const ok = Object.values(checks).every(Boolean) && Object.keys(checks).length > 3;
console.log(JSON.stringify({ ok, checks }, null, 1));
process.exit(ok ? 0 : 1);
