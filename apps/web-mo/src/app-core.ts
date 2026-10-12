// Application core of the metadata-only browser client, running in a
// dedicated Worker (koncept §4.1): the tree lives in SQLite on OPFS (only a
// worker may open it), the UI thread only renders what it asks for, page by page.
// Only the main tab (Web Locks) owns OPFS and writes snapshots; other tabs run
// on an in-memory replica of the same server log (they read, the server
// arbitrates writes, so they stay correct, only slower to start).

import { MemoryIndexStore, ROOT_ID, nameKey, type IndexStore, type LogEntry } from "@ddv4/sync-core";
import {
  DiscordWebhookTransport,
  EncryptedArbiter,
  HttpApi,
  HttpPairingMailbox,
  MetadataClient,
  OpCodec,
  SnapshotScheduler,
  SqlIndexStore,
  WebhookVault,
  accountKeyFromB64,
  acceptPairing,
  clientBlobIO,
  createAccountHttp,
  createPointerMessage,
  decodeRescueKit,
  deviceKeyFromCryptoKey,
  encodeRescueKit,
  generateDeviceKey,
  getChallenge,
  getHealth,
  inspectForVault,
  newAccountKey,
  openDeviceName,
  openShare,
  prepareShare,
  rescueRegisterDevice,
  sealDeviceName,
  sealJson,
  shareLink,
  startPairing,
  toWebhookRefs,
  unsealJson,
  vaultAdvice,
  type AccountKey,
  type ArbiterApi,
  type ByteSource,
  type ChildRow,
  type OpenedShare,
  type PendingPairing,
} from "@ddv4/metadata-client";
import { fromBase64, toBase64 } from "@ddv4/processing";
import { claimLeadership, openOpfsIndexStore, requestPersistentStorage } from "@ddv4/metadata-client/browser";
import { keystore, type StoredAccount } from "./keystore.js";

export interface CoreConfig {
  /** Test hook: send discord.com API calls to a local fake. Never set in production. */
  discordApiOrigin?: string;
  wasmUrl?: string;
}

/** Events pushed from the worker to the UI (not request/response). */
export type CoreEvent =
  | { type: "upload-progress"; token: string; done: number; total: number }
  | { type: "share-progress"; done: number; total: number }
  | { type: "changed" };

function blobSource(b: Blob): ByteSource {
  return { size: b.size, read: async (o, l) => new Uint8Array(await b.slice(o, o + l).arrayBuffer()) };
}

const MIME: Record<string, string> = {
  webm: "video/webm", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain", mp3: "audio/mpeg", zip: "application/zip",
};
const mimeOf = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

const SNAPSHOT_TICK_MS = 15_000;

type PendingPair = {
  p: PendingPairing;
  serverUrl: string;
  deviceName: string;
  dk: Awaited<ReturnType<typeof generateDeviceKey>>;
  result?: StoredAccount & { sas: string };
};

export class AppCore {
  private acct: StoredAccount | null = null;
  private key: AccountKey | null = null;
  private http: HttpApi | null = null;
  private client: MetadataClient | null = null;
  private store: IndexStore | null = null;
  private vault: WebhookVault | null = null;
  private sub: { close(): void } | null = null;
  private scheduler: SnapshotScheduler | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private readonly serverTimes = new Map<number, number>();
  private pending: PendingPair | null = null;
  private shared: { opened: OpenedShare } | null = null;
  leader = false;
  persistent = false;
  /** Bumped on every applied batch; the UI polls it to refresh. */
  version = 0;
  /** Last snapshot outcome, for the status line. */
  lastSnapshot: { at: number; kind: string; written: string } | null = null;
  /** Set by the worker host: push events to the UI. */
  onEvent: (e: CoreEvent) => void = () => {};

  constructor(private readonly cfg: CoreConfig = {}) {}

  private transport() {
    return new DiscordWebhookTransport({ apiOrigin: this.cfg.discordApiOrigin });
  }

  async status() {
    const a = this.acct ?? (await keystore.load()) ?? null;
    const v = this.vault && this.client ? await this.vault.load().catch(() => null) : null;
    return {
      signedIn: !!this.client,
      hasAccount: !!a,
      accountId: a?.accountId ?? null,
      deviceId: a?.deviceId ?? null,
      deviceName: a?.deviceName ?? null,
      leader: this.leader,
      persistent: this.persistent,
      headSeq: this.client?.replica.headSeq ?? 0,
      version: this.version,
      /** Rescue kit confirmed on this device (forced once after the first channel). */
      kitSaved: !!a?.kitSavedAt,
      hasPointer: !!v?.pointer,
      lastSnapshot: this.lastSnapshot,
    };
  }

  /** Instance info (signup policy, sharing) for the sign-up screen. */
  async instance(serverUrl: string) {
    return getHealth(serverUrl);
  }

  /** New account on a server (decision #13: device key + rescue key registered). */
  async createAccount(serverUrl: string, deviceName: string, invite?: string): Promise<void> {
    const key = newAccountKey();
    const dk = await generateDeviceKey(false);
    const r = await createAccountHttp(serverUrl, dk, key, undefined, invite?.trim() || undefined);
    await keystore.save({
      serverUrl,
      instanceId: r.instanceId,
      accountId: r.accountId,
      deviceId: r.deviceId,
      deviceName,
      accountKey: key.rawB64,
      devicePublicKey: dk.publicKey,
      devicePrivateKey: dk.privateKey,
    });
  }

  /** Open the stored account: sign in, open the tree (OPFS if main tab), catch up, subscribe. */
  async open(): Promise<void> {
    const a = await keystore.load();
    if (!a) throw new Error("no account on this device");
    this.acct = a;
    const lead = claimLeadership(a.accountId, (l) => {
      this.leader = l;
      this.onEvent({ type: "changed" });
    });
    await Promise.race([lead.ready, new Promise((r) => setTimeout(r, 200))]);
    if (this.leader) {
      this.persistent = await requestPersistentStorage();
      this.store = await openOpfsIndexStore({ filename: `/index-${a.accountId}.db`, wasmUrl: this.cfg.wasmUrl });
    } else {
      this.store = new MemoryIndexStore();
    }
    this.key = accountKeyFromB64(a.accountKey);
    const dk = await deviceKeyFromCryptoKey(a.devicePrivateKey, a.devicePublicKey);
    this.http = new HttpApi({ baseUrl: a.serverUrl, accountId: a.accountId, deviceId: a.deviceId, key: dk, instanceId: a.instanceId });
    this.vault = new WebhookVault(this.http, this.key, a.accountId);
    await this.rebuildClient();
    this.version++;
    this.sub = this.http.subscribe(() => void this.client!.pull().then(() => (this.version++, this.onEvent({ type: "changed" }))));
    void this.ensureOwnName().catch(() => {});
    this.startSnapshots();
  }

  /** Arbiter that remembers server times of entries (snapshot timing, §6.2). */
  private timedArbiter(inner: ArbiterApi): ArbiterApi {
    const remember = (e: LogEntry) => {
      this.serverTimes.set(e.seq, e.serverTime);
      if (this.serverTimes.size > 20_000) this.serverTimes.delete(this.serverTimes.keys().next().value!);
    };
    return {
      submit: async (env) => {
        const r = await inner.submit(env);
        if ("entry" in r && r.entry) remember(r.entry as LogEntry);
        return r;
      },
      read: async (after, limit) => {
        const es = await inner.read(after, limit);
        es.forEach(remember);
        return es;
      },
      renewLease: (u, d) => inner.renewLease(u, d),
      releaseLease: (u, d) => inner.releaseLease(u, d),
    };
  }

  /** (Re)build the client around the same store and log position (webhooks changed). */
  private async rebuildClient() {
    const a = this.acct!;
    const hooks = toWebhookRefs(await this.vault!.load());
    this.client = new MetadataClient({
      device: { id: a.deviceId, name: a.deviceName },
      arbiter: this.timedArbiter(new EncryptedArbiter(new OpCodec(this.key!, a.accountId), this.http!)),
      transport: this.transport(),
      webhooks: hooks.length ? hooks : [{ id: "0", url: "unset://" }],
      store: this.store!,
    });
    this.scheduler = null;
    await this.client.pull();
  }

  private c(): MetadataClient {
    if (!this.client) throw new Error("not signed in");
    return this.client;
  }

  async addWebhook(url: string) {
    const w = await inspectForVault(this.transport(), url);
    const v = await this.vault!.addWebhook(w);
    await this.rebuildClient();
    this.startSnapshots();
    return vaultAdvice(v);
  }

  async webhooks() {
    const v = await this.vault!.load();
    return { webhooks: v.webhooks.map((w) => ({ id: w.id, channelId: w.channelId, label: w.label })), advice: vaultAdvice(v) };
  }

  /**
   * One page of a folder (§4.1: only what is visible is in RAM). Keyset
   * paging on (nameKey, id) in both stores: OPFS (main tab) and the in-memory
   * replica (secondary tab), so paging behaves the same in every tab.
   */
  list(parentId = ROOT_ID, after?: string, limit = 200): { rows: ChildRow[]; total: number } {
    const s = this.store;
    if (s instanceof SqlIndexStore) return { rows: s.listChildren(parentId, { after, limit }), total: s.countChildren(parentId) };
    const all: (ChildRow & { k: [string, string] })[] = [];
    for (const id of this.c().store.childIds(parentId)) {
      const n = this.c().store.getNode(id);
      if (!n || n.trashed) continue;
      const k: [string, string] = [nameKey(n.name), id];
      all.push({ id, name: n.name, kind: n.kind as "file" | "folder", size: n.content?.sizeBytes ?? null, trashed: false, cursor: JSON.stringify(k), k });
    }
    const cmp = (x: [string, string], y: [string, string]) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
    all.sort((x, y) => cmp(x.k, y.k));
    const from = after ? (JSON.parse(after) as [string, string]) : null;
    const rows = (from ? all.filter((r) => cmp(r.k, from) > 0) : all).slice(0, limit).map(({ k: _k, ...r }) => r);
    return { rows, total: all.length };
  }

  async mkdir(name: string, parentId = ROOT_ID) {
    const id = crypto.randomUUID().replace(/-/g, "");
    await this.c().commitOp({ type: "create", kind: "folder", nodeId: id, parentId, name: name.normalize("NFC") }, "mkdir");
    this.version++;
    return id;
  }

  /** Upload with byte progress pushed as "upload-progress" events tagged with `token`. */
  async upload(file: Blob, name: string, parentId = ROOT_ID, token = "") {
    let last = 0;
    const r = await this.c().upload(blobSource(file), name, parentId, {
      onProgress: (done, total) => {
        const t = Date.now();
        if (done > 0 && done < total && t - last < 100) return;
        last = t;
        this.onEvent({ type: "upload-progress", token, done, total });
      },
    });
    this.version++;
    void this.snapshotSoon();
    return { nodeId: r.nodeId, chunks: r.chunks, sha256: r.version.plaintextSha256 };
  }

  async download(nodeId: string): Promise<Blob> {
    const parts: Uint8Array[] = [];
    await this.c().download(nodeId, { write: async (d) => void parts.push(new Uint8Array(d)) });
    const n = this.c().store.getNode(nodeId);
    return new Blob(parts as BlobPart[], { type: n ? mimeOf(n.name) : "" });
  }

  async readRange(nodeId: string, start: number, end: number) {
    const r = await this.c().readRange(nodeId, start, end, this.rangeCache);
    const n = this.c().store.getNode(nodeId)!;
    return { ...r, name: n.name };
  }
  private readonly rangeCache = new Map<string, Uint8Array>();

  async trash(nodeId: string) {
    await this.c().commitOp({ type: "trash", nodeId }, "trash");
    this.version++;
  }

  async rename(nodeId: string, name: string) {
    await this.c().commitOp({ type: "rename", nodeId, name: name.normalize("NFC") }, "rename");
    this.version++;
  }

  // ── devices ────────────────────────────────────────────────────────

  /** Pair a new device that shows `code` (§3.8). Returns the 6-digit code to compare. */
  async pairAccept(code: string) {
    const a = this.acct!;
    const http = this.http!;
    const t = code.trim();
    // The QR holds a link (…/#pair=ddn-pair1:…); accept both forms.
    const offer = t.includes("#pair=") ? decodeURIComponent(t.slice(t.indexOf("#pair=") + 6)) : t;
    return acceptPairing(offer, { accountId: a.accountId, accountKey: a.accountKey, fromDevice: a.deviceName }, (pub) => http.addDevice(pub), http.pairingMailbox());
  }

  /** New device, step 1: offer to show as QR/text. The QR carries a link that opens the app on the other device. */
  async pairStart(serverUrl: string, deviceName: string): Promise<{ offer: string; link: string }> {
    const dk = await generateDeviceKey(false);
    const p = await startPairing(dk.publicKey);
    this.pending = { p, serverUrl, deviceName, dk };
    return { offer: p.offer, link: `${serverUrl.replace(/\/$/, "")}/#pair=${p.offer}` };
  }

  /** New device, step 2 (poll every ~2 s): null until the other device answered, then the SAS to compare. */
  async pairPoll(): Promise<{ sas: string } | null> {
    const pd = this.pending;
    if (!pd) throw new Error("no pairing in progress");
    if (pd.result) return { sas: pd.result.sas };
    const r = await pd.p.complete(new HttpPairingMailbox(pd.serverUrl, null));
    if (!r) return null;
    const c = await getChallenge(pd.serverUrl);
    pd.result = {
      serverUrl: pd.serverUrl,
      instanceId: c.instanceId,
      accountId: r.bundle.accountId,
      deviceId: r.bundle.deviceCredential.deviceId,
      deviceName: pd.deviceName,
      accountKey: r.bundle.accountKey,
      devicePublicKey: pd.dk.publicKey,
      devicePrivateKey: pd.dk.privateKey,
      // The account already has a confirmed kit (first device); this one can show it any time.
      kitSavedAt: Date.now(),
      sas: r.sas,
    };
    return { sas: r.sas };
  }

  /** New device, step 3: the user confirmed the codes match. */
  async pairConfirm(): Promise<void> {
    const r = this.pending?.result;
    if (!r) throw new Error("pairing not finished");
    const { sas: _sas, ...acct } = r;
    await keystore.save(acct);
    this.pending = null;
  }

  pairCancel(): void {
    this.pending = null;
  }

  /** New device from the rescue kit (§3.5): registers this device with the rescue key. */
  async joinWithKit(serverUrl: string, kitText: string, deviceName: string): Promise<void> {
    const kit = decodeRescueKit(kitText);
    const key = accountKeyFromB64(kit.key);
    const dk = await generateDeviceKey(false);
    const c = await getChallenge(serverUrl);
    const { deviceId } = await rescueRegisterDevice(serverUrl, key, kit.accountId, dk);
    await keystore.save({
      serverUrl,
      instanceId: c.instanceId,
      accountId: kit.accountId,
      deviceId,
      deviceName,
      accountKey: kit.key,
      devicePublicKey: dk.publicKey,
      devicePrivateKey: dk.privateKey,
      kitSavedAt: Date.now(),
    });
  }

  /** Devices with their names (sealed with the account key; the server cannot read them). */
  async devices() {
    const list = await this.http!.listDevices();
    const a = this.acct!;
    return Promise.all(
      list.map(async (d) => ({
        deviceId: d.deviceId,
        createdAt: d.createdAt,
        addedBy: d.addedBy ?? null,
        name: await openDeviceName(this.key!, a.accountId, d.deviceId, d.nameSealed),
        me: d.deviceId === a.deviceId,
      })),
    );
  }

  async renameDevice(deviceId: string, name: string) {
    const a = this.acct!;
    await this.http!.setDeviceName(deviceId, await sealDeviceName(this.key!, a.accountId, deviceId, name));
    if (deviceId === a.deviceId) {
      a.deviceName = name;
      await keystore.save(a);
    }
  }

  private async ensureOwnName() {
    const a = this.acct!;
    const me = (await this.http!.listDevices()).find((d) => d.deviceId === a.deviceId);
    if (me && !me.nameSealed) await this.renameDevice(a.deviceId, a.deviceName);
  }

  async revokeDevice(id: string) {
    await this.http!.revokeDevice(id);
  }

  // ── rescue kit + snapshots (§3.5, §6.2) ────────────────────────────

  /** Make sure the pointer message exists (needs a channel); returns it. */
  private async ensurePointer() {
    let v = await this.vault!.load();
    if (v.pointer) return v.pointer;
    const hooks = toWebhookRefs(v);
    if (!hooks.length) throw new Error("need_channel: add a channel with a webhook first");
    const io = clientBlobIO(this.c(), this.transport());
    const mine = await createPointerMessage(io, this.key!, this.acct!.accountId, hooks[0]!);
    v = await this.vault!.update((x) => {
      x.pointer ??= mine;
      return x;
    });
    // Another device won the race: drop ours.
    if (v.pointer!.messageId !== mine.messageId) await this.transport().deleteMessage(this.c().webhook(mine.webhookId), mine.messageId).catch(() => {});
    return v.pointer!;
  }

  /** The rescue kit text (secret): account key + pointer webhook + pointer message. */
  async rescueKit(): Promise<{ kit: string; accountId: string }> {
    const ptr = await this.ensurePointer();
    const v = await this.vault!.load();
    const hook = v.webhooks.find((w) => w.id === ptr.webhookId);
    if (!hook) throw new Error("pointer_hook_gone: the pointer message channel was removed from the vault");
    const a = this.acct!;
    this.startSnapshots();
    void this.snapshotSoon(true);
    return { kit: encodeRescueKit({ v: 1, accountId: a.accountId, key: a.accountKey, webhookUrl: hook.url, pointerMessageId: ptr.messageId }), accountId: a.accountId };
  }

  async confirmKitSaved() {
    const a = this.acct!;
    a.kitSavedAt = Date.now();
    await keystore.save(a);
  }

  private startSnapshots() {
    if (this.snapTimer || !this.client) return;
    this.snapTimer = setInterval(() => void this.snapshotSoon(), SNAPSHOT_TICK_MS);
  }

  /** One scheduler tick (main tab only; writes when §6.2 says so, or now if forced). */
  async snapshotSoon(force = false) {
    if (!this.leader || !this.client) return null;
    const v = await this.vault!.load();
    if (!v.pointer) return null;
    if (!this.scheduler) {
      const nav = (globalThis as unknown as { navigator?: { userAgent?: string; connection?: { type?: string; saveData?: boolean } } }).navigator;
      // §6.2: phones (metered) write only segments, bases come from desktops.
      const metered = /Android|iPhone|iPad|Mobile/i.test(nav?.userAgent ?? "") || nav?.connection?.type === "cellular" || !!nav?.connection?.saveData;
      const c = this.c();
      this.scheduler = new SnapshotScheduler({
        io: clientBlobIO(c, this.transport()),
        key: this.key!,
        accountId: this.acct!.accountId,
        pointer: v.pointer,
        log: this.http!,
        store: this.store!,
        now: () => Date.now(),
        isPrimary: () => this.leader,
        unmetered: () => !metered,
        serverTimeOf: (seq) => this.serverTimes.get(seq),
      });
    }
    try {
      const r = await this.scheduler.tick(force);
      if (r && r.kind !== "none") this.lastSnapshot = { at: Date.now(), kind: r.kind, written: r.written };
      return r ? { kind: r.kind, written: r.written, toSeq: r.pointer.toSeq } : null;
    } catch {
      return null;
    }
  }

  // ── sharing (§3.7) ─────────────────────────────────────────────────

  async shareFile(nodeId: string, origin: string): Promise<{ link: string; shareId: string }> {
    const c = this.c();
    const n = c.store.getNode(nodeId);
    if (!n || n.kind !== "file" || !n.content) throw new Error("not a file");
    const prep = await prepareShare(
      { transport: this.transport(), hook: (id) => c.webhook(id), loadManifest: (ref) => c.loadManifest(ref) },
      n.content.manifestRef,
      { name: n.name, size: n.content.sizeBytes, sha256: n.content.plaintextSha256 ?? "", mime: mimeOf(n.name) },
    );
    const note = toBase64(await sealJson(await this.key!.subkey("share-note"), { name: n.name, nodeId }, `ddn-share-note-v1|${this.acct!.accountId}`));
    const { shareId } = await this.http!.createShare({ attachments: prep.attachments, meta: prep.meta, ownerNote: note });
    return { shareId, link: shareLink(origin, shareId, prep.fileKey) };
  }

  async shares() {
    const list = await this.http!.listShares();
    const k = await this.key!.subkey("share-note");
    return Promise.all(
      list.map(async (s) => {
        let name: string | null = null;
        try {
          name = (await unsealJson<{ name: string }>(k, fromBase64(s.ownerNote), `ddn-share-note-v1|${this.acct!.accountId}`)).name;
        } catch {
          /* damaged note: show without a name */
        }
        return { shareId: s.shareId, createdAt: s.createdAt, revoked: s.revoked, name };
      }),
    );
  }

  async revokeShare(shareId: string) {
    await this.http!.revokeShare(shareId);
  }

  /** Recipient (no account needed): metadata of a shared file. */
  async shareOpen(serverUrl: string, shareId: string, keyB64u: string) {
    const fetchVia: typeof fetch = (input, init) => fetch(String(input), init);
    let k = keyB64u.replace(/-/g, "+").replace(/_/g, "/");
    while (k.length % 4) k += "=";
    const opened = await openShare(serverUrl, shareId, k, fetchVia);
    this.shared = { opened };
    return opened.meta;
  }

  /** Recipient: download and verify (SHA-256) the shared file. */
  async shareDownload(): Promise<Blob> {
    const s = this.shared;
    if (!s) throw new Error("no share open");
    const parts: Uint8Array[] = [];
    let last = 0;
    await s.opened.download({ write: async (d) => void parts.push(new Uint8Array(d)) }, (done, total) => {
      const t = Date.now();
      if (done < total && t - last < 100) return;
      last = t;
      this.onEvent({ type: "share-progress", done, total });
    });
    return new Blob(parts as BlobPart[], { type: s.opened.meta.mime ?? "" });
  }

  close() {
    this.sub?.close();
    if (this.snapTimer) clearInterval(this.snapTimer);
  }
}
