// Application core of the metadata-only browser client, running in a
// dedicated Worker (koncept §4.1): the tree lives in SQLite on OPFS (only a
// worker may open it), the UI thread only renders what it asks for, page by page.
// Only the main tab (Web Locks) owns OPFS and writes snapshots; other tabs run
// on an in-memory replica of the same server log (they read, the server
// arbitrates writes, so they stay correct, only slower to start).

import {
  MemoryIndexStore,
  RECOVERED_ID,
  ROOT_ID,
  TRASH_RETENTION_MS,
  inTrash,
  nameKey,
  normalizeName,
  pathOf,
  validateName,
  type ApplyResult,
  type IndexStore,
  type LogEntry,
  type NoticeCode,
  type Operation,
  type Outcome,
} from "@ddv4/sync-core";
import {
  HttpApi,
  HttpPairingMailbox,
  OpFailedError,
  SqlIndexStore,
  accountKeyFromB64,
  acceptPairing,
  createAccountHttp,
  deviceKeyFromCryptoKey,
  generateDeviceKey,
  getChallenge,
  getHealth,
  newAccountKey,
  openDeviceName,
  openShare,
  passwordStrength,
  protectAccountKey,
  signInWithPassword,
  prepareShareWith,
  rescueRegisterDevice,
  sealDeviceName,
  sealJson,
  shareLink,
  startPairing,
  trashCleanupOp,
  unsealJson,
  type AccountKey,
  type ArbiterApi,
  type ByteSource,
  type ChildRow,
  type DriveClient,
  type FolderStats,
  type OpenedShare,
  type PendingPairing,
} from "@ddv4/metadata-client";
import { fromBase64, toBase64 } from "@ddv4/processing";
import { claimLeadership, openOpfsIndexStore, requestPersistentStorage } from "@ddv4/metadata-client/browser";
// Resolved at build time to ONE mode (build.ts): the other modes are not in the bundle.
import { mode } from "ddn:mode";
import type { ChannelsView, ModeCleanup, ModeCtx, MoveStatus, RemovalImpact, StorageRun, StorageStatus, StorageTotals } from "./modes/types.js";
import { keystore, type StoredAccount } from "./keystore.js";

export interface CoreConfig {
  /** Test hook: send discord.com API calls to a local fake. Never set in production. */
  discordApiOrigin?: string;
  wasmUrl?: string;
}

/** A rule notice for the UI (sync-core Notice, with names instead of IDs). */
export interface UiNotice {
  code: NoticeCode;
  /** Name of the node the notice is about (null when it is gone). */
  name: string | null;
  /** Second name: the wanted name (rule 2), the overwritten one (rule 1), the folder (Q1, rule 5). */
  other: string | null;
  /** Q3: nodes kept in the trash. */
  count: number;
}
export interface OpOutcome {
  outcome: Outcome;
  notices: UiNotice[];
}
export interface TrashRow {
  id: string;
  name: string;
  kind: "file" | "folder";
  size: number | null;
  /** Server time of the trash operation (the 30-day clock, restarted by a partial purge, Q3). */
  trashedAt: number;
  purgeAt: number;
  /** Folder path it was in (names from the root), null when unknown. */
  from: string[] | null;
  fromRecovered: boolean;
}

/** Events pushed from the worker to the UI (not request/response). */
export type CoreEvent =
  | { type: "upload-progress"; token: string; done: number; total: number }
  | { type: "share-progress"; done: number; total: number }
  | { type: "changed" }
  | { type: "cleanup"; running: boolean }
  /** Moving a channel (zlecenie 2026-10-13-webhooki): progress of the job (this tab in metadata only, the instance in e2ee/plain). */
  | { type: "channel-move"; status: MoveStatus }
  /** Rule notices about changes of OTHER devices addressed to this one (Q1: your file went to the trash with a folder). */
  | { type: "notices"; notices: UiNotice[] };

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
/** Automatic cleanup (Q4) in the main tab: first check shortly after opening, then hourly. */
const CLEANUP_FIRST_MS = 60_000;
const CLEANUP_EVERY_MS = 60 * 60_000;

/** Phone or metered link (§6.2, Q4: no bases, no automatic cleanup). */
function meteredLink(): boolean {
  const nav = (globalThis as unknown as { navigator?: { userAgent?: string; connection?: { type?: string; saveData?: boolean } } }).navigator;
  return /Android|iPhone|iPad|Mobile/i.test(nav?.userAgent ?? "") || nav?.connection?.type === "cellular" || !!nav?.connection?.saveData;
}

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
  private client: DriveClient | null = null;
  private store: IndexStore | null = null;
  private ctx: ModeCtx | null = null;
  private sub: { close(): void } | null = null;
  private uploads = new Map<string, AbortController>();
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private gcTimer: ReturnType<typeof setTimeout> | null = null;
  private gc: ModeCleanup | null = null;
  /** Last cleanup run of this tab (automatic or manual), for Settings → Storage. */
  lastCleanup: (StorageRun & { at: number; manual: boolean }) | null = null;
  cleaning = false;
  private readonly serverTimes = new Map<number, number>();
  private pending: PendingPair | null = null;
  private shared: { opened: OpenedShare } | null = null;
  leader = false;
  persistent = false;
  /** Bumped on every applied batch; the UI polls it to refresh. */
  version = 0;
  /** Settings: show files that cannot be read now (default off: hidden from lists, search, counters, preview, sharing). */
  showUnavailable = false;
  private unavailTimer: ReturnType<typeof setInterval> | null = null;
  private unavailSeen = "";
  /** Last snapshot outcome, for the status line. */
  lastSnapshot: { at: number; kind: string; written: string } | null = null;
  /** Set by the worker host: push events to the UI. */
  onEvent: (e: CoreEvent) => void = () => {};

  constructor(private readonly cfg: CoreConfig = {}) {}

  async status() {
    const a = this.acct ?? (await keystore.load()) ?? null;
    return {
      /** Build-time mode of this app (the instance runs the same one). */
      mode: mode.mode,
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
      lastSnapshot: this.lastSnapshot,
      /** Who writes snapshots: this browser (metadata only) or the instance (e2ee/plain). */
      snapshotsBy: mode.clientSnapshots ? "client" : "server",
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
    this.ctx = {
      acct: a,
      key: this.key,
      http: this.http,
      store: this.store,
      timed: (x) => this.timedArbiter(x),
      leader: () => this.leader,
      discordApiOrigin: this.cfg.discordApiOrigin,
      serverTimeOf: (seq) => this.serverTimes.get(seq),
    };
    await this.rebuildClient();
    this.version++;
    this.sub = this.http.subscribe(
      () =>
        void this.client!.pull().then((rs) => {
          this.version++;
          this.onEvent({ type: "changed" });
          const mine = this.uiNotices(rs, false);
          if (mine.length) this.onEvent({ type: "notices", notices: mine });
        }),
    );
    void this.ensureOwnName().catch(() => {});
    this.startSnapshots();
    this.scheduleCleanup(CLEANUP_FIRST_MS);
    this.startUpkeep();
  }

  // ── cleanup (§6.2, Q4; zlecenie 2026-10-13 p. 2) ────────────────────

  /** Automatic run in the main tab (the Q4 gates decide inside; other tabs only when nobody cleaned for 7 days). */
  private scheduleCleanup(ms: number) {
    if (this.gcTimer) clearTimeout(this.gcTimer);
    this.gcTimer = setTimeout(() => {
      void this.cleanup(false)
        .catch(() => null)
        .finally(() => this.scheduleCleanup(CLEANUP_EVERY_MS));
    }, ms);
  }

  async storageStatus(): Promise<StorageStatus & { last: AppCore["lastCleanup"]; running: boolean; metered: boolean }> {
    const st = await this.gc!.status();
    return { ...st, last: this.lastCleanup, running: this.cleaning, metered: meteredLink() };
  }

  /** One cleanup run; manual = "Clean up now". Pushes "cleanup" events (start/end) for the progress. */
  async cleanup(manual = true): Promise<StorageRun> {
    if (!this.gc) throw new Error("not signed in");
    this.cleaning = true;
    this.onEvent({ type: "cleanup", running: true });
    try {
      const r = await this.gc.run(manual);
      this.lastCleanup = { ...r, at: Date.now(), manual };
      if (r.purged) this.version++;
      return r;
    } finally {
      this.cleaning = false;
      this.onEvent({ type: "cleanup", running: false });
    }
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

  /** (Re)build the client around the same store and log position (channels changed). */
  private async rebuildClient() {
    this.client = await mode.client(this.ctx!);
    this.gc = mode.cleanup(this.ctx!, this.client, { primary: () => this.leader, metered: meteredLink });
    await this.client.pull();
  }

  /**
   * Background upkeep of the derived tables (main tab): versions written without piece locations get
   * them from their manifests (metadata only, a few per minute), unavailability is recomputed (e2ee/plain:
   * the instance may have removed or got back a channel), an interrupted channel move resumes.
   */
  private startUpkeep() {
    if (this.unavailTimer) return;
    const tick = async () => {
      if (!this.client) return;
      if (this.leader && mode.mode === "metadata-only") {
        const { backfillPieces } = await import("@ddv4/metadata-client");
        const s = this.store;
        if (s instanceof SqlIndexStore) await backfillPieces(this.client as never, s, 50).catch(() => null);
        const st = await mode.moveStatus(this.ctx!, this.client).catch(() => null);
        if (st && (st.state === "paused" || st.state === "running") && st.error !== "cancelled") void this.moveWebhook(st.webhookId).catch(() => {});
      }
      await this.refreshUnavailable().catch(() => {});
    };
    void tick();
    this.unavailTimer = setInterval(() => void tick(), 60_000);
  }

  private c(): DriveClient {
    if (!this.client) throw new Error("not signed in");
    return this.client;
  }

  async addWebhook(url: string) {
    await mode.addChannel(this.ctx!, url);
    await this.rebuildClient();
    this.startSnapshots();
    // Pasting a removed webhook again makes its files readable at once.
    await this.refreshUnavailable().catch(() => {});
    return (await mode.channels(this.ctx!, this.client ?? undefined)).advice;
  }

  /** Channels of this account: own webhooks (vault or instance) + the instance pool (e2ee/plain), with stats and flags. */
  async webhooks(): Promise<ChannelsView> {
    return mode.channels(this.ctx!, this.client ?? undefined);
  }

  // ── removing a channel (zlecenie 2026-10-13-webhooki p. 1) ─────────

  /** The remove dialog: what lies on the channel, whether it is critical, whether a move is possible. */
  async channelImpact(id: string): Promise<RemovalImpact> {
    await this.c().pull();
    return mode.removalImpact(this.ctx!, this.c(), id);
  }

  /** Option 1 and its undo. */
  async retireWebhook(id: string, retired = true) {
    await mode.retireChannel(this.ctx!, id, retired);
    await this.rebuildClient();
  }

  /** Option 2: move everything off it, then remove it. Progress as "channel-move" events. */
  async moveWebhook(id: string): Promise<MoveStatus> {
    const push = (status: MoveStatus) => this.onEvent({ type: "channel-move", status });
    const r = await mode.moveChannel(this.ctx!, this.c(), id, push);
    if (r.state === "done") {
      await this.rebuildClient();
      this.startSnapshots();
    }
    // e2ee/plain: the instance runs it; poll until it ends (the UI also asks moveStatus()).
    if (!mode.clientSnapshots && r.state === "running") void this.pollMove();
    this.version++;
    return r;
  }

  private polling = false;
  private async pollMove() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await mode.moveStatus(this.ctx!, this.c()).catch(() => null);
        if (!st) return;
        this.onEvent({ type: "channel-move", status: st });
        if (st.state !== "running") {
          await this.refreshUnavailable().catch(() => {});
          this.version++;
          return;
        }
      }
    } finally {
      this.polling = false;
    }
  }

  async moveStatus(): Promise<MoveStatus | null> {
    return mode.moveStatus(this.ctx!, this.c());
  }

  /** Option 3: remove anyway (refused for a critical channel and for the last one). */
  async removeWebhook(id: string) {
    await mode.removeChannel(this.ctx!, id, this.c());
    await this.rebuildClient();
    await this.refreshUnavailable().catch(() => {});
    this.version++;
  }

  /** e2ee/plain with an instance bot: read the files of a removed channel with the bot and move them to active channels. */
  async recoverWebhook(id: string): Promise<MoveStatus> {
    if (!mode.recoverWithBot) throw new Error("not supported in this mode");
    const r = await mode.recoverWithBot(this.ctx!, this.c(), id);
    void this.pollMove();
    return r;
  }

  /**
   * Recompute which files cannot be read now and store it in the local index (lists hide them by
   * default). metadata only: from the vault and the piece locations (local, instant); e2ee/plain:
   * asks the instance. Never written to the log.
   */
  async refreshUnavailable(): Promise<number> {
    const rows = await mode.unavailable(this.ctx!, this.c());
    const s = this.store;
    if (s instanceof SqlIndexStore) s.setUnavailable(rows.map((r) => ({ uploadId: r.uploadId, locs: r.webhookIds })));
    const key = rows.map((r) => r.uploadId).sort().join(",");
    if (key !== this.unavailSeen) {
      this.unavailSeen = key;
      this.version++;
      this.onEvent({ type: "changed" });
    }
    return rows.length;
  }

  /** Settings switch "Show unavailable files" (kept in the browser by the UI). */
  setShowUnavailable(on: boolean) {
    this.showUnavailable = !!on;
    this.version++;
  }

  /** Unavailable files with the channel(s) they wait for (the explanation in the list and the preview). */
  unavailableInfo(nodeId: string): { webhookIds: string[]; labels: string[] } | null {
    const s = this.store;
    const ids = s instanceof SqlIndexStore ? s.isUnavailable(nodeId) : null;
    return ids ? { webhookIds: ids, labels: ids.map((x) => `#…${x.slice(-6)}`) } : null;
  }

  /** Settings → Storage: totals from the local index (SQL; measured on 50 000 files / 2 M pieces in storage-stats.test.ts). */
  async storageTotals(): Promise<StorageTotals> {
    const t0 = performance.now();
    const s = this.store;
    if (!(s instanceof SqlIndexStore)) {
      // Secondary tab (in memory): a plain pass over the tree.
      const st: StorageTotals = { files: 0, bytes: 0, trashFiles: 0, trashBytes: 0, unavailableFiles: 0, unavailableBytes: 0, discordBytes: null, tookMs: 0 };
      for (const n of this.c().store.allNodes()) {
        if (n.kind !== "file" || !n.content) continue;
        if (inTrash(this.c().store, n.id)) ((st.trashFiles++), (st.trashBytes += n.content.sizeBytes));
        else ((st.files++), (st.bytes += n.content.sizeBytes));
      }
      st.tookMs = Math.round(performance.now() - t0);
      return st;
    }
    const t = s.storageTotals();
    const discord = mode.discordUsage ? await mode.discordUsage(this.ctx!, this.c()).catch(() => null) : null;
    return { files: t.files, bytes: t.bytes, trashFiles: t.trashFiles, trashBytes: t.trashBytes, unavailableFiles: t.unavailableFiles, unavailableBytes: t.unavailableBytes, discordBytes: discord, tookMs: Math.round(performance.now() - t0) };
  }

  /**
   * One page of a folder (§4.1: only what is visible is in RAM). Keyset
   * paging on (nameKey, id) in both stores: OPFS (main tab) and the in-memory
   * replica (secondary tab), so paging behaves the same in every tab.
   */
  list(parentId = ROOT_ID, after?: string, limit = 200): { rows: ChildRow[]; total: number } {
    const s = this.store;
    const hide = !this.showUnavailable;
    if (s instanceof SqlIndexStore) return { rows: s.listChildren(parentId, { after, limit, hideUnavailable: hide }), total: s.countChildren(parentId, hide) };
    const all: (ChildRow & { k: [string, string] })[] = [];
    for (const id of this.c().store.childIds(parentId)) {
      const n = this.c().store.getNode(id);
      if (!n || n.trashed) continue;
      const k: [string, string] = [nameKey(n.name), id];
      all.push({ id, name: n.name, kind: n.kind as "file" | "folder", size: n.content?.sizeBytes ?? null, modifiedAt: n.content?.createdAt ?? null, trashed: false, cursor: JSON.stringify(k), k });
    }
    const cmp = (x: [string, string], y: [string, string]) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
    all.sort((x, y) => cmp(x.k, y.k));
    const from = after ? (JSON.parse(after) as [string, string]) : null;
    const rows = (from ? all.filter((r) => cmp(r.k, from) > 0) : all).slice(0, limit).map(({ k: _k, ...r }) => r);
    return { rows, total: all.length };
  }

  /** Counters for the folder heading ("3 folders · 8 files · 72 GB"). */
  folderStats(parentId = ROOT_ID): FolderStats {
    const s = this.store;
    if (s instanceof SqlIndexStore) return s.folderStats(parentId, !this.showUnavailable);
    const st: FolderStats = { folders: 0, files: 0, bytes: 0 };
    for (const id of this.c().store.childIds(parentId)) {
      const n = this.c().store.getNode(id);
      if (!n || n.trashed) continue;
      if (n.kind === "folder") st.folders++;
      else ((st.files++), (st.bytes += n.content?.sizeBytes ?? 0));
    }
    return st;
  }

  /**
   * Path from the root to a folder (breadcrumb after a reload of /folder/<id>). A path under
   * „Recovered” (rule 4) starts with { id: "recovered" }. null when the folder no longer exists
   * or is in the trash (another device removed it).
   */
  folderPath(nodeId: string): { id: string; name: string }[] | null {
    const out: { id: string; name: string }[] = [];
    let id: string | null = nodeId;
    for (let i = 0; id && id !== ROOT_ID && i < 256; i++) {
      const n = this.c().store.getNode(id);
      if (!n || n.kind !== "folder" || n.trashed) return null;
      out.unshift({ id: n.id, name: n.name });
      if (n.id === RECOVERED_ID) return out;
      id = n.parentId;
    }
    return id === ROOT_ID ? out : null;
  }

  async mkdir(name: string, parentId = ROOT_ID) {
    const id = crypto.randomUUID().replace(/-/g, "");
    await this.c().commitOp({ type: "create", kind: "folder", nodeId: id, parentId, name: name.normalize("NFC") }, "mkdir");
    this.version++;
    return id;
  }

  /** Upload with byte progress pushed as "upload-progress" events tagged with `token`. Cancel: cancelUpload(token). */
  async upload(file: Blob, name: string, parentId = ROOT_ID, token = "") {
    let last = 0;
    const ac = new AbortController();
    if (token) this.uploads.set(token, ac);
    const r = await this.c().upload(blobSource(file), name, parentId, {
      signal: ac.signal,
      onProgress: (done, total) => {
        const t = Date.now();
        if (done > 0 && done < total && t - last < 100) return;
        last = t;
        this.onEvent({ type: "upload-progress", token, done, total });
      },
    }).finally(() => this.uploads.delete(token));
    this.version++;
    void this.snapshotSoon();
    return { nodeId: r.nodeId, chunks: r.chunks, sha256: r.version.plaintextSha256 };
  }

  /** What the instance does with plaintext (plain mode): the UI shows thumbnails/search only then. */
  features() {
    return mode.serverFeatures ?? { thumbnails: false, search: false, streaming: false };
  }

  /** plain: thumbnail of a file (JPEG), null when there is none (yet) or the mode has none. */
  async thumbnail(nodeId: string): Promise<Blob | null> {
    return mode.thumbnail ? mode.thumbnail(this.ctx!, nodeId) : null;
  }

  /** plain: search by name on the server. */
  async search(q: string) {
    if (!mode.search) throw new Error("not supported in this mode");
    const hits = await mode.search(this.ctx!, q);
    // Unavailable files are hidden from search too unless the Settings switch is on.
    if (this.showUnavailable) return hits.map((h) => ({ ...h, unavailable: this.unavailableInfo(h.id)?.webhookIds }));
    return hits.filter((h) => h.kind !== "file" || !this.unavailableInfo(h.id));
  }

  /** plain: a URL the <video> element can play straight from the server (Range, ticket in the URL). */
  async streamUrl(nodeId: string): Promise<string | null> {
    return mode.streamUrl ? mode.streamUrl(this.ctx!, nodeId) : null;
  }

  /** Stop an upload in progress (the fragment in flight is aborted; e2ee/plain: the server deletes what was sent). */
  cancelUpload(token: string): boolean {
    const ac = this.uploads.get(token);
    ac?.abort();
    return !!ac;
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

  // ── rename, move, trash (sync-core rules 1–6, Q1–Q3, Q9) ───────────

  /**
   * Commit one operation and translate the rule notices for the UI. A rule that skips the
   * operation (5, 6, Q2) is an answer, not an error: the caller shows the notice.
   */
  private async commit(op: Operation, what: string): Promise<OpOutcome> {
    let r: ApplyResult;
    try {
      r = await this.c().commitOp(op, what);
    } catch (e) {
      if (!(e instanceof OpFailedError) || !("outcome" in e.result) || e.result.outcome !== "skipped") throw e;
      r = e.result;
    }
    this.version++;
    return { outcome: r.outcome, notices: this.uiNotices([r], true) };
  }

  /** Rule notices this device should see: its own operations, and changes of others addressed to it (Q1). */
  private uiNotices(results: ApplyResult[], own: boolean): UiNotice[] {
    const me = this.acct?.deviceId;
    const out: UiNotice[] = [];
    const nameOf = (id?: string) => (id ? (this.client?.store.getNode(id)?.name ?? null) : null);
    for (const r of results)
      for (const n of r.notices) {
        if (n.silent || n.code === "group_members_skipped") continue;
        const forMe = n.notifyDeviceId ? n.notifyDeviceId === me : own;
        if (!forMe) continue;
        out.push({
          code: n.code,
          name: nameOf(n.nodeId),
          // name_suffixed / rename_overrode_unseen: the wanted / overwritten name; moves: the target folder
          other: n.code === "name_suffixed" || n.code === "rename_overrode_unseen" ? (n.reason ?? null) : (nameOf(n.relatedNodeId) ?? nameOf(n.reason) ?? null),
          count: n.items?.length ?? 0,
        });
      }
    return out;
  }

  async rename(nodeId: string, name: string): Promise<OpOutcome & { name: string | null; before: string | null }> {
    const nfc = normalizeName(name.trim());
    const bad = validateName(nfc);
    if (bad) throw new Error(`invalid_name: ${bad}`);
    const before = this.c().store.getNode(nodeId)?.name ?? null;
    const r = await this.commit({ type: "rename", nodeId, name: nfc }, "rename");
    return { ...r, name: this.c().store.getNode(nodeId)?.name ?? null, before };
  }

  /** Move one or more nodes into a folder (one group op, Q9: members a rule skips are left out). */
  async move(nodeIds: string[], parentId: string): Promise<OpOutcome & { from: Record<string, string> }> {
    const from: Record<string, string> = {};
    for (const id of nodeIds) {
      const n = this.c().store.getNode(id);
      if (n?.parentId) from[id] = n.parentId;
    }
    const ops = nodeIds.map((nodeId) => ({ type: "move" as const, nodeId, parentId }));
    const r = await this.commit(ops.length === 1 ? ops[0]! : { type: "group", ops }, "move");
    return { ...r, from };
  }

  /** Undo of a move: every node back where it was. */
  async moveBack(from: Record<string, string>): Promise<OpOutcome> {
    const ops = Object.entries(from).map(([nodeId, parentId]) => ({ type: "move" as const, nodeId, parentId }));
    if (!ops.length) return { outcome: "noop", notices: [] };
    return this.commit(ops.length === 1 ? ops[0]! : { type: "group", ops }, "move back");
  }

  async trash(nodeIds: string | string[]): Promise<OpOutcome> {
    const ops = (Array.isArray(nodeIds) ? nodeIds : [nodeIds]).map((nodeId) => ({ type: "trash" as const, nodeId }));
    return this.commit(ops.length === 1 ? ops[0]! : { type: "group", ops }, "trash");
  }

  /** Restore from the trash; a node whose folder is still in the trash lands in „Recovered” (rule 4). */
  async restore(nodeIds: string[]): Promise<OpOutcome> {
    const ops = nodeIds.map((nodeId) => ({ type: "restore" as const, nodeId }));
    return this.commit(ops.length === 1 ? ops[0]! : { type: "group", ops }, "restore");
  }

  /** Delete for good (Q3: what another device changed unseen stays in the trash, 30 days again). */
  async purge(nodeIds: string[]): Promise<OpOutcome> {
    if (!nodeIds.length) return { outcome: "noop", notices: [] };
    const r = await this.commit(trashCleanupOp(nodeIds), "purge");
    void this.snapshotSoon();
    // e2ee/plain: tell the instance what was released (its background cleanup waits 30 days).
    if (!mode.clientSnapshots) void this.gc?.run(false).catch(() => {});
    return r;
  }

  async emptyTrash(): Promise<OpOutcome> {
    return this.purge(this.trashList().map((x) => x.id));
  }

  /**
   * The trash: nodes trashed on their own whose folder is not in the trash (purging the folder
   * covers the rest), newest first, with the day they go for good (30 days, §6.2).
   */
  trashList(): TrashRow[] {
    const s = this.c().store;
    const own = this.store instanceof SqlIndexStore ? this.store.trashedNodes() : [...s.allNodes()].filter((n) => n.trashed);
    const out: TrashRow[] = [];
    for (const n of own) {
      if (!n.trashed || n.parentId === null || inTrash(s, n.parentId)) continue;
      const from = pathOf(s, n.parentId);
      out.push({
        id: n.id,
        name: n.name,
        kind: n.kind as "file" | "folder",
        size: n.content?.sizeBytes ?? null,
        trashedAt: n.trashed.at,
        purgeAt: n.trashed.at + TRASH_RETENTION_MS,
        from: from === null ? null : from,
        fromRecovered: this.underRecovered(n.parentId),
      });
    }
    return out.sort((a, b) => b.trashedAt - a.trashedAt || (a.id < b.id ? -1 : 1));
  }

  private underRecovered(id: string): boolean {
    let cur = this.c().store.getNode(id);
    for (let i = 0; cur && i < 4096; i++) {
      if (cur.parentId === null) return cur.id === RECOVERED_ID;
      cur = this.c().store.getNode(cur.parentId);
    }
    return false;
  }

  /** Number of items in „Recovered” (the sidebar shows the folder only when it has something). */
  recoveredCount(): number {
    const s = this.store;
    if (s instanceof SqlIndexStore) return s.countChildren(RECOVERED_ID, !this.showUnavailable);
    let n = 0;
    for (const id of this.c().store.childIds(RECOVERED_ID)) if (!this.c().store.getNode(id)?.trashed) n++;
    return n;
  }

  /** Move to… picker: live sub-folders of a folder. */
  subfolders(parentId = ROOT_ID): { id: string; name: string }[] {
    const s = this.store;
    if (s instanceof SqlIndexStore) return s.childFolders(parentId);
    const out: { id: string; name: string; k: string }[] = [];
    for (const id of this.c().store.childIds(parentId)) {
      const n = this.c().store.getNode(id);
      if (n && !n.trashed && n.kind === "folder") out.push({ id, name: n.name, k: nameKey(n.name) });
    }
    return out.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.id < b.id ? -1 : 1)).map(({ k: _k, ...x }) => x);
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

  // ── optional password-protected account key (§3.8, zlecenie 2026-10-13 p. 3) ──

  async passwordKeyStatus() {
    return this.http!.passwordKeyStatus();
  }

  /** Turn on or change: the key is sealed here with Argon2id(password); the server gets only the result. */
  async setPasswordKey(login: string, password: string) {
    const a = this.acct!;
    return this.http!.setPasswordKey(await protectAccountKey(this.key!, a.accountId, login, password));
  }

  async removePasswordKey() {
    await this.http!.removePasswordKey();
    return this.http!.passwordKeyStatus();
  }

  passwordStrength(pw: string) {
    return passwordStrength(pw);
  }

  /** New device: login + password -> account key opened here -> device registered with the rescue key. */
  async joinWithPassword(serverUrl: string, login: string, password: string, deviceName: string): Promise<void> {
    const dk = await generateDeviceKey(false);
    const r = await signInWithPassword(serverUrl, login, password, dk);
    await keystore.save({
      serverUrl,
      instanceId: r.instanceId,
      accountId: r.accountId,
      deviceId: r.deviceId,
      deviceName,
      accountKey: r.key.rawB64,
      devicePublicKey: dk.publicKey,
      devicePrivateKey: dk.privateKey,
      // The account already confirmed its rescue kit on the first device.
      kitSavedAt: Date.now(),
    });
  }

  /** New device from the rescue kit (§3.5): registers this device with the rescue key. */
  async joinWithKit(serverUrl: string, kitText: string, deviceName: string): Promise<void> {
    const kit = mode.decodeKit(kitText);
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

  /** The rescue kit text (secret): metadata only = key + pointer webhook + message; e2ee/plain = key + instance. */
  async rescueKit(): Promise<{ kit: string; accountId: string }> {
    const kit = await mode.rescueKit(this.ctx!, this.c());
    this.startSnapshots();
    void this.snapshotSoon(true);
    return { kit, accountId: this.acct!.accountId };
  }

  async confirmKitSaved() {
    const a = this.acct!;
    a.kitSavedAt = Date.now();
    await keystore.save(a);
  }

  private startSnapshots() {
    // e2ee/plain: the instance writes snapshots in the background (no tab needed).
    if (this.snapTimer || !this.client || !mode.clientSnapshots) return;
    this.snapTimer = setInterval(() => void this.snapshotSoon(), SNAPSHOT_TICK_MS);
  }

  /** One scheduler tick (main tab only, metadata only; writes when §6.2 says so, or now if forced). */
  async snapshotSoon(force = false) {
    if (!this.leader || !this.client || !mode.snapshotTick) return null;
    try {
      const r = await mode.snapshotTick(this.ctx!, this.client, force);
      if (r && r.kind !== "none") this.lastSnapshot = { at: Date.now(), kind: r.kind, written: r.written };
      return r;
    } catch {
      return null;
    }
  }

  // ── sharing (§3.7) ─────────────────────────────────────────────────

  async shareFile(nodeId: string, origin: string): Promise<{ link: string; shareId: string }> {
    if (this.unavailableInfo(nodeId)) throw new Error("file_unavailable");
    const c = this.c();
    const n = c.store.getNode(nodeId);
    if (!n || n.kind !== "file" || !n.content) throw new Error("not a file");
    const prep = await prepareShareWith(
      { loadManifest: (ref) => c.loadManifest(ref), attachments: () => mode.shareAttachments(this.ctx!, c, n.content!.manifestRef) },
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
    if (this.gcTimer) clearTimeout(this.gcTimer);
    if (this.unavailTimer) clearInterval(this.unavailTimer);
  }
}
