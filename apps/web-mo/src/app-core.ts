// Application core of the metadata-only browser client, running in a
// dedicated Worker: the tree lives in SQLite on OPFS (only a
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
  parseCursor,
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
  type ListSort,
  type OpenedShare,
  type PendingPairing,
  TransferLog,
  type UploadStages,
  type PreviewImage,
  type PreviewKind,
} from "@ddv4/metadata-client";
import { NetControl, type BaselineData, type LaneFetch, type NetUiState } from "@ddv4/metadata-client";
import { fromBase64, toBase64 } from "@ddv4/processing";
// Resolved at build time to ONE mode (build.ts): the other modes are not in the bundle.
import { mode } from "ddn:mode";

/** How long an upload waits for the page's previews when the manifest goes out (none by then: without). */
const PREVIEW_WAIT_MS = 20_000;
/** Names the thumbnail backfill looks at (what the page can make previews from). */
const PREVIEW_NAMES = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|mp4|m4v|webm|mov|mkv|ogv)$/i;

/** Build of this app (build.ts define: version + source hash + commit); "dev" when run unbuilt. */
declare const __DDN_BUILD__: string | undefined;
export const BUILD = typeof __DDN_BUILD__ === "string" ? __DDN_BUILD__ : "dev";
import type { ChannelsView, ModeCleanup, ModeCtx, MoveStatus, RemovalImpact, StorageRun, StorageStatus, StorageTotals } from "./modes/types.js";
import type { StoredAccount } from "./keystore.js";
import type { CorePlatform, DiskFiles, PlatformResumeStore, TransferLogStore } from "./platform.js";

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
  | { type: "upload-progress"; token: string; done: number; total: number; stages?: UploadStages; name?: string }
  | { type: "download-progress"; token: string; done: number; total: number; name?: string }
  /** Network state for the transfer panels: ok / weak (slowing down) / offline (waiting) / resumed. */
  | { type: "net"; state: NetUiState }
  /** The reference speed changed (the UI keeps it in localStorage for the next session). */
  | { type: "net-baseline"; data: BaselineData }
  | { type: "net-tune"; data: { up: number; down: number } }
  | { type: "share-progress"; done: number; total: number }
  /** "Make thumbnails for existing photos": the UI makes them (it has the decoder), the core stores them. */
  | { type: "backfill"; state: BackfillState }
  | { type: "changed" }
  | { type: "cleanup"; running: boolean }
  /** Moving a channel: progress of the job (this tab in metadata only, the instance in e2ee/plain). */
  | { type: "channel-move"; status: MoveStatus }
  /** Rule notices about changes of OTHER devices addressed to this one (Q1: your file went to the trash with a folder). */
  | { type: "notices"; notices: UiNotice[] }
  /** The server no longer accepts this device: the account was blocked or deleted, or the device revoked. */
  | { type: "auth-lost"; code: AuthLost };

/** Thumbnails for files uploaded without them: progress (kept across restarts by `after`). */
export interface BackfillState {
  running: boolean;
  done: number;
  made: number;
  failed: number;
  /** Files left, as far as the index knows (image and video names without known previews). */
  left: number;
  /** Stopped because the link is metered (it continues only when started by hand). */
  metered?: boolean;
}

export interface AdminAccount {
  accountId: string;
  createdAt: number;
  lastSeenAt: number | null;
  devices: number;
  serverBytes: number;
  poolBytes: number | null;
  state: "active" | "blocked";
  blockedAt: number | null;
  blockedReason: string | null;
  inviteNote: string | null;
  admin: boolean;
}
export interface AdminDeletion {
  accountId: string;
  state: "pending" | "running" | "done" | "failed";
  total: number;
  done: number;
  error: string | null;
}
export interface AdminInvite {
  id: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
  revokedAt: number | null;
  note: string;
  createdBy: string;
  state: "active" | "used" | "expired" | "revoked";
}
export interface AdminLogRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
}
export interface AdminInstance {
  health: { version: string; mode: string; signup: string; uptimeS: number; rulesVersion: number; shares: boolean };
  accounts: number;
  admins: number;
  deletions: AdminDeletion[];
  pool?: { id: string; channelId: string; label: string; alive: boolean; retired: boolean; files: number; bytes: number; accounts: { accountId: string; bytes: number }[] }[];
}

/** Resume point of a download to disk (desktop), under `dl:<versionId>:<folder>` in the resume store. */
interface DiskDownloadJournal {
  v: 1;
  nodeId: string;
  versionId: string;
  dir: string;
  name: string;
  size: number;
  /** Plaintext bytes of one fragment (set once the first one is written). */
  chunk?: number;
  /** Fragments written and covered by `hash`. */
  next: number;
  /** Whole-file SHA-256 state after `next` fragments (base64). */
  hash: string;
  at: number;
}

/** Resume key of an upload from disk: the same file (path, size, modification time) into the same folder. */
const diskResumeKey = (folder: string, path: string, size: number, mtimeMs: number) => `disk|${folder}|${size}|${Math.floor(mtimeMs)}|${path}`;

/** Why the server stopped accepting this device. */
export type AuthLost = "blocked" | "gone";

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

type NavConn = { userAgent?: string; onLine?: boolean; connection?: { type?: string; saveData?: boolean; effectiveType?: string } };
const nav = () => (globalThis as unknown as { navigator?: NavConn }).navigator;
/** Settings → "Save data" (this browser's choice, sent by the UI). */
let saveDataOn = false;
/** Phone or metered link (no snapshot bases, no automatic cleanup), or "Save data" on. */
function meteredLink(): boolean {
  return leanWhy() !== null;
}
/**
 * Why data is being saved right now (the panels say it): the switch in Settings, the browser reporting a
 * metered link (Save-Data / cellular), or a phone; null = not saving.
 */
function leanWhy(): "setting" | "metered" | "phone" | null {
  const n = nav();
  if (saveDataOn) return "setting";
  if (n?.connection?.type === "cellular" || n?.connection?.saveData) return "metered";
  if (/Android|iPhone|iPad|Mobile/i.test(n?.userAgent ?? "")) return "phone";
  return null;
}
/** Network type when the browser tells it (Chromium: wifi / ethernet / cellular …); "" elsewhere. */
const netType = () => nav()?.connection?.type ?? "";

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
  private downloads = new Map<string, AbortController>();
  /** Transfer logs (Settings → Diagnostics): the OPFS writer and the logger handed to the client. */
  private tlogStore: TransferLogStore | null = null;
  private tlog: TransferLog | null = null;
  /** Settings → Diagnostics → fragments in flight (null = automatic / default); kept by the UI, applied to every client. */
  private conc: { upload: number | null; download: number | null } = { upload: null, download: null };
  /**
   * Network state of this tab, shared by every client it builds:
   * the no-network gate, adaptive windows, the stuck-connection guard and its reference speed.
   */
  readonly net = new NetControl({ metered: () => meteredLink(), netType });
  private lanes: LaneFetch[] = [];
  private resume: PlatformResumeStore | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private gcTimer: ReturnType<typeof setTimeout> | null = null;
  private gc: ModeCleanup | null = null;
  /** Last cleanup run of this tab (automatic or manual), for Settings → Storage. */
  lastCleanup: (StorageRun & { at: number; manual: boolean }) | null = null;
  cleaning = false;
  private readonly serverTimes = new Map<number, number>();
  private pending: PendingPair | null = null;
  private shared: { opened: OpenedShare } | null = null;
  /** Set when the server refused this device (blocked account, deleted account, revoked device). */
  authLost: AuthLost | null = null;
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
  /** `src` of this device's transfer log lines: the browser, or the desktop app's agent. */
  private get logSrc(): "web" | "agent" {
    return this.platform.kind === "desktop" ? "agent" : "web";
  }
  /** Set by the worker host: push events to the UI. */
  onEvent: (e: CoreEvent) => void = () => {};

  constructor(
    private readonly cfg: CoreConfig,
    private readonly platform: CorePlatform,
  ) {
    this.net.onState = (state) => this.onEvent({ type: "net", state });
    if (platform.cdnLanes?.length) {
      this.lanes = [...platform.cdnLanes];
      this.net.laneCount = 1 + this.lanes.length;
    }
    this.net.baseline.onSave = (data) => this.onEvent({ type: "net-baseline", data });
    // The automatic pieces in flight a check settled on: remembered by the UI, the next session starts there.
    const tuned = () => this.onEvent({ type: "net-tune", data: { up: this.net.tune.up.accepted, down: this.net.tune.down.accepted } });
    this.net.tune.up.onAccept = tuned;
    this.net.tune.down.onAccept = tuned;
    // The worker sees the browser's online/offline events too (dedicated workers get them in Chromium/Firefox).
    const g = globalThis as unknown as { addEventListener?: (t: string, f: () => void) => void };
    g.addEventListener?.("online", () => this.net.gate.setOnline(true));
    g.addEventListener?.("offline", () => this.net.gate.setOnline(false));
    if (nav()?.onLine === false) this.net.gate.setOnline(false);
  }

  /** Uploads a reload or a lost network left unfinished (the UI asks to pick the files again). */
  async unfinishedUploads(): Promise<{ key: string; name: string; size: number; have: number; n: number; folder: string }[]> {
    const list = (await this.resume?.uploads().catch(() => [])) ?? [];
    const out = [];
    for (const { key, j, have } of list) {
      // Only uploads still open in the index can continue; the rest is forgotten here.
      if (this.store?.getUpload(j.uploadId)?.status !== "open") {
        await this.resume!.forget(key).catch(() => {});
        continue;
      }
      out.push({ key, name: j.name, size: j.size, have, n: Math.max(1, Math.ceil(j.size / j.chunk)), folder: j.parentId });
    }
    return out;
  }

  /** "Forget": the unfinished upload is dropped (its pieces are cleaned up with the expired lease). */
  async forgetUnfinished(key: string) {
    await this.resume?.forget(key);
  }

  // ── network ──

  /** Settings: "Save data" and the stuck-connection guard; the reference speed kept by the UI. */
  setNetPrefs(p: { saveData?: boolean; guard?: boolean; baseline?: unknown; tune?: { up?: number; down?: number } | null }) {
    if (p.saveData !== undefined) saveDataOn = !!p.saveData;
    if (p.guard !== undefined) this.net.guardOn = !!p.guard;
    if (p.baseline !== undefined) this.net.baseline.load(p.baseline);
    if (p.tune) {
      if (typeof p.tune.up === "number") this.net.tune.up.seed(p.tune.up);
      if (typeof p.tune.down === "number") this.net.tune.down.seed(p.tune.down);
    }
    this.net.saveData = saveDataOn;
    this.client?.syncWindows();
    return this.netStatus();
  }

  /** Diagnostics/tests: send new downloads over connection `lane` (0 = own, 1 = the iframe) as if the guard had switched. */
  netUseLane(lane: number) {
    this.net.guard.lane = Math.max(0, Math.min(this.net.laneCount - 1, lane));
    return this.net.guard.lane;
  }

  /** The UI's online/offline events (the page always gets them; a worker may not). */
  setOnline(on: boolean) {
    this.net.gate.setOnline(on);
  }

  netStatus() {
    const now = Date.now();
    return {
      state: this.net.uiState(),
      metered: meteredLink(),
      saveData: saveDataOn,
      browserMetered: meteredLink() && !saveDataOn,
      /** Why data is saved (panels: "Saving data: at most 2 at once" + the reason); null = not saving. */
      leanWhy: leanWhy(),
      guard: this.net.guardOn,
      lanes: this.net.laneCount,
      window: { up: this.net.win.up.limit, upMax: this.net.win.up.max, down: this.net.win.down.limit, downMax: this.net.win.down.max },
      baseline: { up: this.net.baseline.value("up", now, netType()), down: this.net.baseline.value("down", now, netType()) },
      guardStats: { ...this.net.guard.stats },
    };
  }

  /**
   * A second connection to the CDN (lane.ts in a sandboxed iframe, handed over by the UI as a MessagePort):
   * the stuck-connection guard may move NEW downloads there. Several ports = several lanes.
   */
  attachLane(port: MessagePort) {
    let seq = 0;
    const wait = new Map<number, { ok: (r: Response) => void; err: (e: unknown) => void }>();
    port.onmessage = (e: MessageEvent<{ id: number; st?: number; ttfb?: number; buf?: ArrayBuffer; err?: string; aborted?: boolean }>) => {
      const w = wait.get(e.data?.id);
      if (!w) return;
      wait.delete(e.data.id);
      if (e.data.err !== undefined) {
        const x = e.data.aborted ? Object.assign(new Error("aborted"), { name: "AbortError" }) : new TypeError(`lane: ${e.data.err}`);
        return w.err(x);
      }
      w.ok(new Response(e.data.buf ?? null, { status: e.data.st ?? 0, headers: { "x-ddn-ttfb": String(e.data.ttfb ?? 0) } }));
    };
    const lf: LaneFetch = (url, init) =>
      new Promise<Response>((ok, err) => {
        const id = ++seq;
        if (init?.signal?.aborted) return err(Object.assign(new Error("aborted"), { name: "AbortError" }));
        wait.set(id, { ok, err });
        init?.signal?.addEventListener("abort", () => {
          if (!wait.has(id)) return;
          wait.delete(id);
          port.postMessage({ id, abort: true });
          err(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
        port.postMessage({ id, url });
      });
    this.lanes = [...this.lanes, lf];
    this.client?.blobs.setCdnLanes?.(this.lanes);
    this.net.laneCount = 1 + this.lanes.length;
    return { lanes: this.net.laneCount };
  }

  async status() {
    const a = this.acct ?? (await this.platform.keys.load()) ?? null;
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
      authLost: this.authLost,
    };
  }

  /** Instance info (signup policy, sharing) for the sign-up screen. */
  async instance(serverUrl: string) {
    return getHealth(serverUrl);
  }

  /** New account on a server (decision #13: device key + rescue key registered). */
  async createAccount(serverUrl: string, deviceName: string, invite?: string): Promise<void> {
    const key = newAccountKey();
    const dk = await generateDeviceKey(this.platform.extractableDeviceKey);
    const r = await createAccountHttp(serverUrl, dk, key, undefined, invite?.trim() || undefined);
    await this.platform.keys.save({
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
    const a = await this.platform.keys.load();
    if (!a) throw new Error("no account on this device");
    this.acct = a;
    const lead = this.platform.leadership(a.accountId, (l) => {
      this.leader = l;
      this.onEvent({ type: "changed" });
    });
    await Promise.race([lead.ready, new Promise((r) => setTimeout(r, 200))]);
    if (this.leader) {
      const ix = await this.platform.openIndex(a.accountId);
      this.persistent = ix.persistent;
      this.store = ix.store;
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
      discordFetch: this.platform.discordFetch,
      serverTimeOf: (seq) => this.serverTimes.get(seq),
      net: this.net,
      resume: (this.resume = this.platform.resume(a.accountId)),
    };
    this.authLost = null;
    try {
      await this.rebuildClient();
    } catch (e) {
      // Blocked or deleted account / revoked device: keep the keys, show why (the UI asks what to do).
      this.noteAuthError(e);
      if (this.authLost) return;
      throw e;
    }
    this.version++;
    this.sub = this.http.subscribe(
      () =>
        void this.client!.pull().then((rs) => {
          this.version++;
          this.onEvent({ type: "changed" });
          const mine = this.uiNotices(rs, false);
          if (mine.length) this.onEvent({ type: "notices", notices: mine });
        }),
      { onAuthLost: (code) => this.lostAuth(code === "account_blocked" ? "blocked" : "gone") },
    );
    void this.ensureOwnName().catch(() => {});
    this.startSnapshots();
    this.scheduleCleanup(CLEANUP_FIRST_MS);
    this.startUpkeep();
  }

  /** The server refused this device: stop background work and tell the UI (the keys stay in this browser). */
  private lostAuth(why: AuthLost) {
    if (this.authLost) return;
    this.authLost = why;
    this.sub?.close();
    if (this.snapTimer) clearInterval(this.snapTimer);
    if (this.gcTimer) clearTimeout(this.gcTimer);
    this.onEvent({ type: "auth-lost", code: why });
  }

  /** Try again after "blocked" (the admin may have unblocked the account): sign in afresh. */
  async retryAuth(): Promise<boolean> {
    try {
      await this.http!.session(true);
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      if (/account_blocked/.test(m)) return false;
      if (/bad_signature/.test(m)) return (this.authLost = "gone"), false;
      throw e;
    }
    this.close();
    this.client = null;
    await this.open();
    return true;
  }

  /** Remove the account from this browser (after it was deleted on the server). */
  async forgetThisBrowser(): Promise<void> {
    this.close();
    this.client = null;
    this.http = null;
    this.acct = null;
    this.authLost = null;
    await this.platform.keys.clear();
  }

  // ── instance administration (only for accounts with the admin flag; the server checks it on every call)

  /** What this account may do on the instance. */
  async accountInfo(): Promise<{ admin: boolean }> {
    try {
      return (await this.http!.json<{ admin: boolean }>("GET", "/v1/account")).body;
    } catch (e) {
      this.noteAuthError(e);
      return { admin: false };
    }
  }

  /** A call failed: was it because the server no longer accepts this device? (Then the UI shows why.) */
  async authProblem(message: string): Promise<boolean> {
    this.noteAuthError(message);
    return !!this.authLost;
  }

  private noteAuthError(e: unknown) {
    const m = String((e as Error)?.message ?? e);
    if (/account_blocked/.test(m)) this.lostAuth("blocked");
    else if (/HTTP 401 bad_signature/.test(m)) this.lostAuth("gone");
  }

  private async adm<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.http!.json<T>(method, path, body)).body;
  }

  adminAccounts() {
    return this.adm<{ accounts: AdminAccount[]; deletions: AdminDeletion[] }>("GET", "/v1/admin/accounts");
  }
  adminAccount(id: string) {
    return this.adm<{ account: AdminAccount; devices: { deviceId: string; createdAt: number; lastSeenAt: number | null; addedBy: string }[]; deletion: AdminDeletion | null }>("GET", `/v1/admin/accounts/${id}`);
  }
  adminBlock(id: string, reason: string) {
    return this.adm("POST", `/v1/admin/accounts/${id}/block`, { reason });
  }
  adminUnblock(id: string) {
    return this.adm("POST", `/v1/admin/accounts/${id}/unblock`, {});
  }
  /** Signed again by this device (not only the session). */
  adminSetAdmin(id: string, on: boolean) {
    return this.http!.adminSigned("POST", `/v1/admin/accounts/${id}/admin`, on ? "admin-on" : "admin-off", id, { on });
  }
  adminDelete(id: string) {
    return this.http!.adminSigned<{ deletion: AdminDeletion }>("DELETE", `/v1/admin/accounts/${id}`, "delete-account", id);
  }
  adminRevokeDevice(id: string, deviceId: string) {
    return this.http!.adminSigned("POST", `/v1/admin/accounts/${id}/devices/${deviceId}/revoke`, "revoke-device", `${id}/${deviceId}`);
  }
  adminInvites() {
    return this.adm<{ invites: AdminInvite[] }>("GET", "/v1/admin/invites");
  }
  adminCreateInvite(days: number, note: string) {
    return this.adm<{ code: string; expiresAt: number; id: string }>("POST", "/v1/admin/invites", { days, note });
  }
  adminRevokeInvite(ref: string) {
    return this.adm<{ invite: AdminInvite }>("POST", "/v1/admin/invites/revoke", { ref });
  }
  adminInstance() {
    return this.adm<AdminInstance>("GET", "/v1/admin/instance");
  }
  adminDoctor() {
    return this.adm<{ checks: { level: "ok" | "warn" | "fail"; what: string; detail: string }[] | null }>("GET", "/v1/admin/doctor");
  }
  adminSetSignup(policy: "invite" | "open" | "closed") {
    return this.adm<{ signup: string }>("PUT", "/v1/admin/signup", { policy });
  }
  adminLog(action = "", before = 0) {
    const q = new URLSearchParams({ limit: "100" });
    if (action) q.set("action", action);
    if (before) q.set("before", String(before));
    return this.adm<{ entries: AdminLogRow[] }>("GET", `/v1/admin/log?${q}`);
  }

  // ── cleanup (Q4) ────────────────────

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

  /** Arbiter that remembers server times of entries (snapshot timing). */
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
    this.client.setTransferLog(this.tlog);
    this.client.setConcurrency(this.conc);
    this.client.blobs.setCdnLanes?.(this.lanes);
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
      if (this.leader && mode.upkeep) {
        await mode.upkeep(this.ctx!, this.client).catch(() => null);
        const st = await mode.moveStatus(this.ctx!, this.client).catch(() => null);
        // metadata only: a move this tab started and an interruption stopped continues here.
        if (mode.clientSnapshots && st && (st.state === "paused" || st.state === "running")) void this.moveWebhook(st.webhookId).catch(() => {});
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
  async webhooks(stats = false): Promise<ChannelsView> {
    // Stats and the critical flag (local SQL, a pointer read) only for Settings, not on every render.
    return mode.channels(this.ctx!, stats ? (this.client ?? undefined) : undefined);
  }

  // ── removing a channel ─────────

  /** The remove dialog: what lies on the channel, whether it is critical, whether a move is possible. */
  async channelImpact(id: string): Promise<RemovalImpact> {
    await this.c().pull();
    return mode.removalImpact(this.ctx!, this.c(), id);
  }

  /**
   * Every file with a piece on the channel (name with its folder path, size, trash), for the full list before
   * "Remove anyway" (owner, #31). From the local index: metadata only by piece locations, e2ee/plain by the
   * instance's upload IDs mapped to names here.
   */
  async channelFiles(id: string): Promise<{ path: string; size: number; trashed: boolean }[]> {
    const ids = await mode.channelFileIds(this.ctx!, this.c(), id);
    const s = this.c().store;
    const out: { path: string; size: number; trashed: boolean }[] = [];
    for (const nodeId of ids) {
      const n = s.getNode(nodeId);
      if (!n || n.kind !== "file") continue;
      const dir = n.parentId ? pathOf(s, n.parentId) : null;
      out.push({ path: [...(dir ?? []), n.name].join("/"), size: n.content?.sizeBytes ?? 0, trashed: inTrash(s, n.id) });
    }
    return out.sort((a, b) => Number(a.trashed) - Number(b.trashed) || a.path.localeCompare(b.path));
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
   * One page of a folder (only what is visible is in RAM): folders first, then files, each by
   * the sort (name / size / date, either direction). Keyset paging with the same cursor
   * ([fo, key, nameKey, id]) in both stores: OPFS (main tab, an index per sort) and the in-memory
   * replica (secondary tab), so paging behaves the same in every tab.
   */
  list(parentId = ROOT_ID, after?: string, limit = 200, sort?: ListSort): { rows: ChildRow[]; total: number } {
    const s = this.store;
    const hide = !this.showUnavailable;
    if (s instanceof SqlIndexStore) return { rows: s.listChildren(parentId, { after, limit, hideUnavailable: hide, sort }), total: s.countChildren(parentId, hide) };
    type K = [number, number | null, string, string];
    const by = sort?.by ?? "name";
    const sign = sort?.desc ? -1 : 1;
    const all: (ChildRow & { k: K })[] = [];
    for (const id of this.c().store.childIds(parentId)) {
      const n = this.c().store.getNode(id);
      if (!n || n.trashed) continue;
      const fo = n.kind === "folder" ? 0 : 1;
      const k: K = [fo, by === "size" ? (n.content?.sizeBytes ?? 0) : by === "date" ? (n.content?.createdAt ?? 0) : null, nameKey(n.name), id];
      all.push({ id, name: n.name, kind: n.kind as "file" | "folder", size: n.content?.sizeBytes ?? null, modifiedAt: n.content?.createdAt ?? null, trashed: false, cursor: JSON.stringify(k), k });
    }
    const c1 = (a: number | string | null, b: number | string | null) => (a === b ? 0 : (a ?? 0) < (b ?? 0) ? -1 : 1);
    // Folders first in either direction; the rest of the key follows the direction.
    const cmp = (x: K, y: K) => (x[0] !== y[0] ? x[0] - y[0] : sign * (c1(x[1], y[1]) || c1(x[2], y[2]) || c1(x[3], y[3])));
    all.sort((x, y) => cmp(x.k, y.k));
    const c = parseCursor(after);
    const from: K | null = c ? [c.fo, c.key, c.nameKey, c.id] : null;
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

  /**
   * Thumbnail / preview of an upload in progress (`token`), handed over by the UI that makes them from the
   * file (the core has no image decoder in the desktop agent). Waited for when the manifest goes out.
   */
  private readonly previewWaits = new Map<string, { promise: Promise<PreviewImage[] | null>; resolve: (v: PreviewImage[] | null) => void }>();
  private previewsFor(token: string): Promise<PreviewImage[] | null> | undefined {
    if (!token) return undefined;
    let w = this.previewWaits.get(token);
    if (!w) {
      let resolve!: (v: PreviewImage[] | null) => void;
      const promise = new Promise<PreviewImage[] | null>((r) => (resolve = r));
      this.previewWaits.set(token, (w = { promise, resolve }));
    }
    // Never waits long: a UI that makes none (old page, a type without previews) says so, or this ends it.
    setTimeout(() => w!.resolve(null), PREVIEW_WAIT_MS);
    return w.promise;
  }
  /** The UI's pictures for the upload `token` (null: none). Before or after the upload asked for them. */
  uploadPreviews(token: string, imgs: PreviewImage[] | null): void {
    const ok = Array.isArray(imgs) ? imgs.filter((x) => x && (x.kind === "t" || x.kind === "p") && x.data instanceof Uint8Array && typeof x.mime === "string") : null;
    let w = this.previewWaits.get(token);
    if (!w) {
      this.previewWaits.set(token, (w = { promise: Promise.resolve(ok), resolve: () => {} }));
      setTimeout(() => this.previewWaits.delete(token), PREVIEW_WAIT_MS * 2);
    } else w.resolve(ok);
  }

  /** Upload with byte progress pushed as "upload-progress" events tagged with `token`. Cancel: cancelUpload(token). */
  async upload(file: Blob, name: string, parentId = ROOT_ID, token = "", resumeKey?: string, previews = false) {
    let last = 0;
    const ac = new AbortController();
    if (token) this.uploads.set(token, ac);
    const r = await this.c().upload(blobSource(file), name, parentId, {
      signal: ac.signal,
      resumeKey,
      previews: previews ? this.previewsFor(token) : undefined,
      onProgress: (done, total, stages) => {
        const t = Date.now();
        if (done > 0 && done < total && t - last < 100) return;
        last = t;
        this.onEvent({ type: "upload-progress", token, done, total, stages });
      },
    }).finally(() => (this.uploads.delete(token), this.previewWaits.delete(token)));
    this.version++;
    void this.snapshotSoon();
    return { nodeId: r.nodeId, chunks: r.chunks, sha256: r.version.plaintextSha256, resumed: r.resumed };
  }

  // ── thumbnails and previews (made by the client at upload; see metadata-client/previews.ts) ──────────

  /** Thumbnail ("t") or preview ("p") of a file: the encrypted one stored with it, else (plain) the server's. */
  async preview(nodeId: string, kind: PreviewKind = "t"): Promise<Blob | null> {
    const n = this.c().store.getNode(nodeId);
    const ref = n?.content?.manifestRef;
    if (ref) {
      const img = await this.c().readPreview(ref, kind).catch(() => null);
      if (img) return new Blob([img.data as BlobPart], { type: img.mime });
    }
    return kind === "t" && mode.thumbnail ? mode.thumbnail(this.ctx!, nodeId).catch(() => null) : null;
  }

  /** Previews of these files as far as this device already knows them (no network): which have one. */
  knownPreviews(nodeIds: string[]): string[] {
    const s = this.store as unknown as { previewInfo?(r: string): { v: string } | undefined };
    return nodeIds.filter((id) => {
      const ref = this.c().store.getNode(id)?.content?.manifestRef;
      const k = ref ? s.previewInfo?.(ref) : undefined;
      return !!k && k.v !== "{}";
    });
  }

  private backfill: BackfillState = { running: false, done: 0, made: 0, failed: 0, left: 0 };
  /** Within one run: where the walk over the files is (upload ID order). Files done are marked in the index. */
  private backfillCursor = "";
  private filesWithoutPreviews(after: string, limit: number) {
    const s = this.store as unknown as { filesWithoutPreviews?: SqlIndexStore["filesWithoutPreviews"] };
    return s.filesWithoutPreviews?.(PREVIEW_NAMES, after, limit) ?? [];
  }
  backfillState(): BackfillState {
    return { ...this.backfill, left: this.backfill.running ? this.backfill.left : this.filesWithoutPreviews("", 1000).length };
  }
  /**
   * Next files for "Make thumbnails for existing photos": the page downloads each, makes the pictures and
   * gives them back (backfillAdd). Resumable: a file done (or found impossible) is marked in the index.
   * Metered link: only when started by hand (`manual`).
   */
  backfillNext(limit = 5, manual = false): { nodeId: string; name: string; size: number }[] {
    if (meteredLink() && !manual) {
      this.backfill = { ...this.backfill, running: false, metered: true };
      this.onEvent({ type: "backfill", state: this.backfill });
      return [];
    }
    if (!this.backfill.running) {
      this.backfillCursor = "";
      this.backfill = { running: true, done: 0, made: 0, failed: 0, left: this.filesWithoutPreviews("", 1000).length };
    }
    const list = this.filesWithoutPreviews(this.backfillCursor, Math.max(1, Math.min(50, limit)));
    if (list.length) this.backfillCursor = list.at(-1)!.uploadId;
    return list.map((x) => ({ nodeId: x.nodeId, name: x.name, size: x.size }));
  }
  /** Pictures made for an existing file (null = the page could not make any: marked, not tried again). */
  async backfillAdd(nodeId: string, imgs: PreviewImage[] | null): Promise<boolean> {
    const c = this.c().store.getNode(nodeId)?.content;
    const ok = Array.isArray(imgs) ? imgs.filter((x) => x && (x.kind === "t" || x.kind === "p") && x.data instanceof Uint8Array) : [];
    let made = false;
    if (c && ok.length) made = (await this.c().addPreviews(c.manifestRef, ok, c.uploadId).catch(() => [])).length > 0;
    if (c && !made) (this.store as unknown as { setPreviewInfo?(r: string, v: string, at: number): void }).setPreviewInfo?.(c.manifestRef, "-", Date.now());
    this.backfill = { ...this.backfill, done: this.backfill.done + 1, made: this.backfill.made + (made ? 1 : 0), failed: this.backfill.failed + (made ? 0 : 1), left: Math.max(0, this.backfill.left - 1) };
    this.onEvent({ type: "backfill", state: this.backfill });
    return made;
  }
  backfillEnd(): void {
    this.backfill = { ...this.backfill, running: false };
    this.onEvent({ type: "backfill", state: this.backfillState() });
  }

  // ── desktop: files on this computer (platform.files; the browser has none) ─────────────────────────

  private disk(): DiskFiles {
    const f = this.platform.files;
    if (!f) throw new Error("not available here");
    return f;
  }

  /** What this core can do beyond the browser (the UI shows the desktop actions only when set). */
  capabilities(): { disk: boolean; platform: "web" | "desktop"; downloadsDir: string | null; keyProtection: "os" | "file" | null } {
    return { disk: !!this.platform.files, platform: this.platform.kind, downloadsDir: this.platform.files?.downloadsDir() ?? null, keyProtection: this.platform.keyProtection ?? null };
  }

  /**
   * Desktop: what dropping (or picking) these paths would upload: every regular file, with the folders it
   * goes into (a dropped folder is recreated under the target, its subfolders too). Nothing is read yet.
   */
  async listPaths(paths: string[]): Promise<{ path: string; name: string; size: number; folder: string[] }[]> {
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || !p)) throw new Error("bad paths");
    const disk = this.disk();
    const out: { path: string; name: string; size: number; folder: string[] }[] = [];
    for (const p of paths) {
      if (await disk.isDir(p)) {
        const base = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "folder";
        for (const f of await disk.walk(p)) out.push({ path: f.path, name: f.rel.at(-1)!, size: f.size, folder: [base, ...f.rel.slice(0, -1)] });
      } else {
        const st = await disk.stat(p);
        out.push({ path: p, name: p.split(/[\\/]/).pop() ?? p, size: st.size, folder: [] });
      }
    }
    return out;
  }

  /** The folder `names` under `parentId`, made where missing (an existing one of the same name is reused). */
  private async folderPathOf(parentId: string, names: string[]): Promise<string> {
    let id = parentId;
    for (const name of names) {
      const nfc = name.normalize("NFC");
      const existing = this.c().store.childByKey(id, nameKey(nfc));
      const n = existing ? this.c().store.getNode(existing) : undefined;
      id = n && n.kind === "folder" && !n.trashed ? n.id : await this.mkdir(nfc, id);
    }
    return id;
  }

  /**
   * Desktop: upload one file from disk into `folder` (names under `parentId`, made where missing), with
   * "upload-progress" events tagged with `token` (cancel: cancelUpload(token)). The file is read piece by
   * piece as it is sent, never whole into memory; an interrupted upload of the same file into the same
   * folder continues where it stopped (also after the app restarted).
   */
  async uploadPath(path: string, folder: string[] = [], parentId = ROOT_ID, token = "", previews = false): Promise<{ nodeId: string; resumed: number; size: number }> {
    if (typeof path !== "string" || !path || !Array.isArray(folder) || folder.some((x) => typeof x !== "string")) throw new Error("bad arguments");
    const src = await this.disk().openSource(path);
    const ac = new AbortController();
    if (token) this.uploads.set(token, ac);
    try {
      const into = await this.folderPathOf(parentId, folder);
      let last = 0;
      const r = await this.c().upload(src, src.name, into, {
        signal: ac.signal,
        resumeKey: diskResumeKey(into, path, src.size, src.mtimeMs),
        previews: previews ? this.previewsFor(token) : undefined,
        onProgress: (done, total, stages) => {
          const t = Date.now();
          if (done > 0 && done < total && t - last < 100) return;
          last = t;
          this.onEvent({ type: "upload-progress", token, done, total, stages, name: src.name });
        },
      });
      this.version++;
      void this.snapshotSoon();
      return { nodeId: r.nodeId, resumed: r.resumed, size: src.size };
    } finally {
      this.uploads.delete(token);
      this.previewWaits.delete(token);
      await src.close();
    }
  }

  /** Upload files and folders from disk one after another (tests, scripts); the window uses listPaths + uploadPath. */
  async uploadPaths(paths: string[], parentId = ROOT_ID, token = ""): Promise<{ files: number; bytes: number; failed: { path: string; error: string }[] }> {
    let files = 0;
    let bytes = 0;
    const failed: { path: string; error: string }[] = [];
    for (const [i, f] of (await this.listPaths(paths)).entries()) {
      try {
        await this.uploadPath(f.path, f.folder, parentId, token ? `${token}:${i}` : "");
        files++;
        bytes += f.size;
      } catch (e) {
        failed.push({ path: f.path, error: String((e as Error)?.message ?? e) });
      }
    }
    return { files, bytes, failed };
  }

  /**
   * Download a file straight to disk (desktop): fragments are written at their offsets into
   * `<dir>/<name>.ddnpart`, renamed to a free name when the whole-file SHA-256 matched. After every
   * fragment a resume point is stored (next fragment + hash state); a download cut short (app closed,
   * crash, no network) continues from there with `resumeDownloads()`, the partial file cut back to it.
   */
  async downloadToDisk(nodeId: string, dir?: string, token = ""): Promise<{ path: string; bytes: number; resumed: number }> {
    const disk = this.disk();
    const n = this.c().store.getNode(nodeId);
    if (!n || n.kind !== "file" || !n.content) throw new Error("not a file");
    const target = typeof dir === "string" && dir ? dir : disk.downloadsDir();
    const key = `dl:${n.content.versionId}:${target}`;
    const prev = (await this.resume?.get(key)) as DiskDownloadJournal | undefined;
    const j: DiskDownloadJournal = prev?.v === 1 ? prev : { v: 1, nodeId, versionId: n.content.versionId, dir: target, name: n.name, size: n.content.sizeBytes, next: 0, hash: "", at: Date.now() };
    const out = await disk.openTarget(target, j.name, key);
    const ac = new AbortController();
    if (token) this.downloads.set(token, ac);
    let resumed = 0;
    try {
      // What the journal vouches for; anything past it in the partial file is cut off.
      let resume: { versionId: string; from: number; hash: Uint8Array } | undefined;
      const chunk = j.chunk ?? 0;
      if (j.next > 0 && j.hash && chunk > 0 && out.size >= Math.min(j.size, j.next * chunk)) {
        resume = { versionId: j.versionId, from: j.next, hash: fromBase64(j.hash) };
        resumed = j.next;
        await out.truncate(Math.min(j.size, j.next * chunk));
      } else await out.truncate(0);
      let offset = resume ? Math.min(j.size, j.next * chunk) : 0;
      let last = 0;
      let saving: Promise<unknown> = Promise.resolve();
      await this.resume?.put(key, j);
      await this.c().download(
        nodeId,
        {
          write: async (d) => {
            await out.writeAt(offset, d);
            offset += d.byteLength;
          },
        },
        {
          signal: ac.signal,
          resume,
          onWritten: (p) => {
            // The size of a fragment: the first one written tells it (all but the last are equal).
            if (!j.chunk) j.chunk = offset;
            // A resume point after every fragment (a small JSON file per ~10 MiB written): a crash loses at
            // most the fragments in flight. Saved in order, never two at once.
            j.next = p.next;
            j.hash = toBase64(p.hash());
            j.at = Date.now();
            const snap = { ...j };
            saving = saving.then(() => this.resume?.put(key, snap)).catch(() => {});
          },
          onProgress: (done, total) => {
            const t = Date.now();
            if (done > 0 && done < total && t - last < 100) return;
            last = t;
            this.onEvent({ type: "download-progress", token, done, total, name: j.name });
          },
        },
      );
      await saving;
      const { finalPath } = await out.finish();
      await this.resume?.del(key);
      return { path: finalPath, bytes: j.size, resumed };
    } catch (e) {
      await out.close().catch(() => {});
      throw e;
    } finally {
      this.downloads.delete(token);
    }
  }

  /** Downloads to disk that did not finish (the agent continues them by itself after a restart). */
  async unfinishedDownloads(): Promise<{ key: string; nodeId: string; name: string; dir: string; size: number; next: number }[]> {
    const out = [];
    for (const [key, v] of (await this.resume?.entries("dl:")) ?? []) {
      const j = v as DiskDownloadJournal;
      if (j?.v !== 1) continue;
      const n = this.client?.store.getNode(j.nodeId);
      // The file changed or is gone: the partial file stays where it is, the journal goes.
      if (!n || n.kind !== "file" || n.content?.versionId !== j.versionId) {
        await this.resume?.del(key);
        continue;
      }
      out.push({ key, nodeId: j.nodeId, name: j.name, dir: j.dir, size: j.size, next: j.next });
    }
    return out;
  }

  /** Continue every unfinished download to disk (one after another); returns how many finished. */
  async resumeDownloads(): Promise<number> {
    let done = 0;
    for (const d of await this.unfinishedDownloads()) {
      try {
        await this.downloadToDisk(d.nodeId, d.dir, `resume:${d.key}`);
        done++;
      } catch {
        /* stays in the journal; tried again at the next start */
      }
    }
    return done;
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

  /** Download (verified) into a Blob; with a token: "download-progress" events, cancel with cancelDownload(token). */
  async download(nodeId: string, token = ""): Promise<Blob> {
    const parts: Uint8Array[] = [];
    const ac = new AbortController();
    if (token) this.downloads.set(token, ac);
    let last = 0;
    try {
      await this.c().download(
        nodeId,
        { write: async (d) => void parts.push(new Uint8Array(d)) },
        {
          signal: ac.signal,
          onProgress: token
            ? (done, total) => {
                const t = Date.now();
                if (done > 0 && done < total && t - last < 100) return;
                last = t;
                this.onEvent({ type: "download-progress", token, done, total });
              }
            : undefined,
        },
      );
    } finally {
      this.downloads.delete(token);
    }
    const n = this.c().store.getNode(nodeId);
    return new Blob(parts as BlobPart[], { type: n ? mimeOf(n.name) : "" });
  }

  /** Size and type of a file (the UI picks the download path by size). */
  fileInfo(nodeId: string): { size: number; mime: string } | null {
    const n = this.c().store.getNode(nodeId);
    return n?.content ? { size: n.content.sizeBytes, mime: mimeOf(n.name) } : null;
  }

  /** Ports from the UI for streamed downloads (worker.ts hands them over), by token. */
  private readonly ports = new Map<string, MessagePort>();
  private readonly portWaiters = new Map<string, (p: MessagePort) => void>();
  attachPort(token: string, port: MessagePort): void {
    const w = this.portWaiters.get(token);
    if (w) return (this.portWaiters.delete(token), w(port));
    this.ports.set(token, port);
  }
  private port(token: string): Promise<MessagePort> {
    const p = this.ports.get(token);
    if (p) return (this.ports.delete(token), Promise.resolve(p));
    return new Promise((resolve, reject) => {
      this.portWaiters.set(token, resolve);
      setTimeout(() => this.portWaiters.delete(token) && reject(new Error("stream_no_port")), 5000);
    });
  }

  /**
   * Download straight to disk: the decrypted fragments go in order
   * through a MessagePort to the service worker, whose streamed response the browser saves as a
   * download. Only what the stream asks for is sent (one fragment per pull), so the tab holds at most
   * the fragments in flight, whatever the file size. The whole-file SHA-256 is checked before the
   * stream is closed: a mismatch fails the download in the browser instead of finishing it.
   * "stream_not_started": the service worker never asked (no controller, it restarted): the UI falls back to a Blob.
   */
  async downloadStream(nodeId: string, token: string): Promise<{ bytes: number }> {
    const port = await this.port(token);
    const ac = new AbortController();
    this.downloads.set(token, ac);
    let credits = 0;
    let wake: (() => void) | null = null;
    let started = false;
    let cancelled = false;
    port.onmessage = (e: MessageEvent<{ pull?: boolean; cancel?: boolean }>) => {
      if (e.data?.pull) ((credits++), (started = true));
      if (e.data?.cancel) ((cancelled = true), ac.abort());
      wake?.();
    };
    const startTimer = setTimeout(() => {
      if (!started) ac.abort(new Error("stream_not_started"));
      wake?.();
    }, 20_000);
    let bytes = 0;
    let last = 0;
    try {
      await this.c().download(
        nodeId,
        {
          write: async (d) => {
            while (credits === 0) {
              if (ac.signal.aborted) throw ac.signal.reason instanceof Error ? ac.signal.reason : new Error("aborted");
              await new Promise<void>((r) => (wake = r));
              wake = null;
            }
            credits--;
            // Whole buffer of its own (decryptFragment makes one): transferred, not copied.
            const buf = d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? (d.buffer as ArrayBuffer) : d.slice().buffer;
            bytes += d.byteLength;
            port.postMessage({ chunk: buf }, [buf]);
          },
        },
        {
          signal: ac.signal,
          onProgress: (done, total) => {
            const t = Date.now();
            if (done > 0 && done < total && t - last < 100) return;
            last = t;
            this.onEvent({ type: "download-progress", token, done, total });
          },
        },
      );
      port.postMessage({ done: true });
      return { bytes };
    } catch (e) {
      const reason = ac.signal.reason instanceof Error && ac.signal.reason.message === "stream_not_started" ? "stream_not_started" : cancelled ? "cancelled" : String((e as Error)?.message ?? e);
      port.postMessage({ error: reason });
      throw new Error(reason === String((e as Error)?.message ?? e) ? reason : reason);
    } finally {
      clearTimeout(startTimer);
      this.downloads.delete(token);
      port.close();
    }
  }

  cancelDownload(token: string): boolean {
    const ac = this.downloads.get(token);
    ac?.abort();
    return !!ac;
  }

  // ── transfer logs (Settings → Diagnostics) ──

  /** Fragments in flight (Settings → Network): null = automatic (measured per direction). */
  setConcurrency(upload: number | null, download: number | null) {
    this.conc = { upload: upload || null, download: download || null };
    this.client?.setConcurrency(this.conc);
    return this.concurrency();
  }

  /** Pieces in flight now; `auto`/`autoDown`: the automatic value; `lean`: save data caps both at 2. */
  concurrency(): { upload: number; download: number; auto: boolean; autoDown: boolean; channels: number; lean: boolean; capUp: number; capDown: number } {
    const c = this.client;
    const lean = this.net.metered();
    const up = c?.uploadConcurrency ?? 4;
    const down = c?.downloadConcurrency ?? 4;
    return {
      upload: lean ? Math.min(2, up) : up,
      download: lean ? Math.min(2, down) : down,
      auto: this.conc.upload === null,
      autoDown: this.conc.download === null,
      channels: c?.blobs.lanes?.() ?? 1,
      lean,
      capUp: c?.autoCap("up") ?? 32,
      capDown: c?.autoCap("down") ?? 32,
    };
  }

  /** Turn this browser's transfer log on/off (the UI keeps the choice); e2ee/plain: the instance's log for this account too. */
  async setTransferLog(on: boolean, names = false): Promise<{ on: boolean; names: boolean; server: { on: boolean; all: boolean } | null }> {
    if (on) {
      this.tlogStore ??= this.platform.transferLog();
      this.tlog ??= new TransferLog(this.tlogStore.write, { src: this.logSrc, mode: mode.mode, build: BUILD });
      this.tlog.names = names;
    } else {
      await this.tlogStore?.flush();
      this.tlog = null;
    }
    this.client?.setTransferLog(this.tlog);
    let server: { on: boolean; all: boolean } | null = null;
    if (!mode.clientSnapshots && this.http) {
      server = await this.http
        .json<{ on: boolean; all: boolean }>("POST", "/v1/diagnostics/transfer-log", { on })
        .then((r) => r.body)
        .catch(() => null);
    }
    return { on: !!this.tlog, names: !!this.tlog?.names, server };
  }

  /** Build of this app and of the instance (Settings → Diagnostics). */
  async buildInfo(): Promise<{ app: string; server: string | null }> {
    const h = await getHealth(this.http?.baseUrl ?? this.platform.homeOrigin() ?? "").catch(() => null);
    return { app: BUILD, server: (h as { build?: string } | null)?.build ?? null };
  }

  async transferLogStatus(): Promise<{ on: boolean; names: boolean; bytes: number; where: string; server: { on: boolean; all: boolean } | null }> {
    this.tlogStore ??= this.platform.transferLog();
    let server: { on: boolean; all: boolean } | null = null;
    if (!mode.clientSnapshots && this.http) server = await this.http.json<{ on: boolean; all: boolean }>("GET", "/v1/diagnostics/transfer-log").then((r) => r.body).catch(() => null);
    return { on: !!this.tlog, names: !!this.tlog?.names, bytes: await this.tlogStore.size(), where: this.tlogStore.where, server };
  }

  /**
   * The log file to download: this browser's lines (all tabs) and, in e2ee/plain, the instance's lines
   * for this account, in one JSON Lines file (`src` tells them apart), gzipped when the browser can.
   */
  async transferLogFile(): Promise<{ data: Blob; gz: boolean; lines: number; serverLines: number }> {
    this.tlogStore ??= this.platform.transferLog();
    const mine = await this.tlogStore.text();
    let srv = "";
    if (!mode.clientSnapshots && this.http) {
      const r = await this.http.request("GET", "/v1/diagnostics/transfer-log?download=1").catch(() => null);
      if (r?.ok) srv = await r.text();
    }
    // First line: which builds wrote this file (the app here; the instance from its health), so a log
    // shared later says what version it came from even when it holds no file_start.
    const serverBuild = await getHealth(this.http?.baseUrl ?? this.platform.homeOrigin() ?? "")
      .then((h) => (h as { build?: string }).build ?? null)
      .catch(() => null);
    const head = JSON.stringify({ v: 1, t: Date.now(), src: this.logSrc, ev: "log_header", build: BUILD, mode: mode.mode, ...(serverBuild ? { serverBuild } : {}) }) + "\n";
    const count = (s: string) => (s.match(/\n/g) ?? []).length;
    if (!count(mine + srv)) return { ...(await this.platform.gzip("")), lines: 0, serverLines: 0 };
    const all = head + mine + srv;
    return { ...(await this.platform.gzip(all)), lines: count(all), serverLines: count(srv) };
  }

  async clearTransferLog(): Promise<{ kept: number }> {
    // Also when logging is off now: the files from an earlier session are still in OPFS.
    this.tlogStore ??= this.platform.transferLog();
    const r = await this.tlogStore.clear();
    if (!mode.clientSnapshots && this.http) await this.http.json("DELETE", "/v1/diagnostics/transfer-log").catch(() => null);
    return r;
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
   * covers the rest), newest first, with the day they go for good (30 days).
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

  /** Pair a new device that shows `code`. Returns the 6-digit code to compare. */
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
    const dk = await generateDeviceKey(this.platform.extractableDeviceKey);
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
      kitFormat: mode.kitVersion,
      sas: r.sas,
    };
    return { sas: r.sas };
  }

  /** New device, step 3: the user confirmed the codes match. */
  async pairConfirm(): Promise<void> {
    const r = this.pending?.result;
    if (!r) throw new Error("pairing not finished");
    const { sas: _sas, ...acct } = r;
    await this.platform.keys.save(acct);
    this.pending = null;
  }

  pairCancel(): void {
    this.pending = null;
  }

  // ── optional password-protected account key ──

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
    const dk = await generateDeviceKey(this.platform.extractableDeviceKey);
    const r = await signInWithPassword(serverUrl, login, password, dk);
    await this.platform.keys.save({
      serverUrl,
      instanceId: r.instanceId,
      accountId: r.accountId,
      deviceId: r.deviceId,
      deviceName,
      accountKey: r.key.rawB64,
      devicePublicKey: dk.publicKey,
      devicePrivateKey: dk.privateKey,
      // The account already confirmed its rescue kit on the first device (that device reminds about an old one).
      kitSavedAt: Date.now(),
      kitFormat: mode.kitVersion,
    });
  }

  /** New device from the rescue kit: registers this device with the rescue key. */
  async joinWithKit(serverUrl: string, kitText: string, deviceName: string): Promise<void> {
    const kit = mode.decodeKit(kitText);
    const key = accountKeyFromB64(kit.key);
    const dk = await generateDeviceKey(this.platform.extractableDeviceKey);
    const c = await getChallenge(serverUrl);
    const { deviceId } = await rescueRegisterDevice(serverUrl, key, kit.accountId, dk);
    await this.platform.keys.save({
      serverUrl,
      instanceId: c.instanceId,
      accountId: kit.accountId,
      deviceId,
      deviceName,
      accountKey: kit.key,
      devicePublicKey: dk.publicKey,
      devicePrivateKey: dk.privateKey,
      kitSavedAt: Date.now(),
      // The kit just used: an old format here is worth the reminder.
      kitFormat: kit.format ?? mode.kitVersion,
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
      await this.platform.keys.save(a);
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

  // ── rescue kit + snapshots ────────────────────────────

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
    a.kitFormat = mode.kitVersion;
    await this.platform.keys.save(a);
  }

  /**
   * Ask (once per device) to save a new rescue kit: the kit confirmed here is of an older format that may
   * not restore the whole account (metadata only: kit 1 names one webhook, the account has more channels).
   * Marks the question as asked when it returns true.
   */
  async kitReminder(): Promise<boolean> {
    const a = this.acct;
    if (!a?.kitSavedAt || a.kitNudgedAt || !mode.kitOutdated || !this.ctx) return false;
    if ((a.kitFormat ?? 0) >= (mode.kitVersion ?? 0)) return false;
    if (!(await mode.kitOutdated(this.ctx, a.kitFormat).catch(() => false))) return false;
    a.kitNudgedAt = Date.now();
    await this.platform.keys.save(a);
    return true;
  }

  private startSnapshots() {
    // e2ee/plain: the instance writes snapshots in the background (no tab needed).
    if (this.snapTimer || !this.client || !mode.clientSnapshots) return;
    this.snapTimer = setInterval(() => void this.snapshotSoon(), SNAPSHOT_TICK_MS);
  }

  /** One scheduler tick (main tab only, metadata only; writes on the usual schedule, or now if forced). */
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

  // ── sharing ─────────────────────────────────────────────────

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
    void this.tlogStore?.stop();
    this.sub?.close();
    if (this.snapTimer) clearInterval(this.snapTimer);
    if (this.gcTimer) clearTimeout(this.gcTimer);
    if (this.unavailTimer) clearInterval(this.unavailTimer);
  }
}
