// Application core of the metadata-only browser client, running in a
// dedicated Worker (koncept §4.1): the tree lives in SQLite on OPFS (only a
// worker may open it), the UI thread only renders what it asks for, page by page.
// Only the main tab (Web Locks) owns OPFS and writes snapshots; other tabs run
// on an in-memory replica of the same server log (they read, the server
// arbitrates writes, so they stay correct, only slower to start).

import { MemoryIndexStore, ROOT_ID, type IndexStore } from "@ddv4/sync-core";
import {
  DiscordWebhookTransport,
  EncryptedArbiter,
  HttpApi,
  MetadataClient,
  OpCodec,
  SqlIndexStore,
  WebhookVault,
  accountKeyFromB64,
  acceptPairing,
  createAccountHttp,
  deviceKeyFromCryptoKey,
  generateDeviceKey,
  inspectForVault,
  newAccountKey,
  toWebhookRefs,
  vaultAdvice,
  type ByteSource,
  type ChildRow,
} from "@ddv4/metadata-client";
import { claimLeadership, openOpfsIndexStore, requestPersistentStorage } from "@ddv4/metadata-client/browser";
import { keystore, type StoredAccount } from "./keystore.js";

export interface CoreConfig {
  /** Test hook: send discord.com API calls to a local fake. Never set in production. */
  discordApiOrigin?: string;
  wasmUrl?: string;
}

function blobSource(b: Blob): ByteSource {
  return { size: b.size, read: async (o, l) => new Uint8Array(await b.slice(o, o + l).arrayBuffer()) };
}

export class AppCore {
  private acct: StoredAccount | null = null;
  private http: HttpApi | null = null;
  private client: MetadataClient | null = null;
  private store: IndexStore | null = null;
  private vault: WebhookVault | null = null;
  private sub: { close(): void } | null = null;
  leader = false;
  persistent = false;
  /** Bumped on every applied batch; the UI polls it to refresh. */
  version = 0;

  constructor(private readonly cfg: CoreConfig = {}) {}

  private transport() {
    return new DiscordWebhookTransport({ apiOrigin: this.cfg.discordApiOrigin });
  }

  async status() {
    const a = this.acct ?? (await keystore.load()) ?? null;
    return {
      signedIn: !!this.client,
      hasAccount: !!a,
      accountId: a?.accountId ?? null,
      deviceId: a?.deviceId ?? null,
      leader: this.leader,
      persistent: this.persistent,
      headSeq: this.client?.replica.headSeq ?? 0,
      version: this.version,
    };
  }

  /** New account on a server (decision #13: device key + rescue key registered). */
  async createAccount(serverUrl: string, deviceName: string): Promise<void> {
    const key = newAccountKey();
    const dk = await generateDeviceKey(false);
    const r = await createAccountHttp(serverUrl, dk, key);
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
    const lead = claimLeadership(a.accountId, (l) => (this.leader = l));
    await Promise.race([lead.ready, new Promise((r) => setTimeout(r, 200))]);
    if (this.leader) {
      this.persistent = await requestPersistentStorage();
      this.store = await openOpfsIndexStore({ filename: `/index-${a.accountId}.db`, wasmUrl: this.cfg.wasmUrl });
    } else {
      this.store = new MemoryIndexStore();
    }
    const key = accountKeyFromB64(a.accountKey);
    const dk = await deviceKeyFromCryptoKey(a.devicePrivateKey, a.devicePublicKey);
    this.http = new HttpApi({ baseUrl: a.serverUrl, accountId: a.accountId, deviceId: a.deviceId, key: dk, instanceId: a.instanceId });
    this.vault = new WebhookVault(this.http, key, a.accountId);
    const v = await this.vault.load();
    const hooks = toWebhookRefs(v);
    this.client = new MetadataClient({
      device: { id: a.deviceId, name: a.deviceName },
      arbiter: new EncryptedArbiter(new OpCodec(key, a.accountId), this.http),
      transport: this.transport(),
      webhooks: hooks.length ? hooks : [{ id: "0", url: "unset://" }],
      store: this.store,
    });
    await this.client.pull();
    this.version++;
    this.sub = this.http.subscribe(() => void this.client!.pull().then(() => this.version++));
  }

  private c(): MetadataClient {
    if (!this.client) throw new Error("not signed in");
    return this.client;
  }

  async addWebhook(url: string) {
    const w = await inspectForVault(this.transport(), url);
    const v = await this.vault!.addWebhook(w);
    await this.reopenClientHooks();
    return vaultAdvice(v);
  }

  async webhooks() {
    const v = await this.vault!.load();
    return { webhooks: v.webhooks.map((w) => ({ id: w.id, channelId: w.channelId, label: w.label })), advice: vaultAdvice(v) };
  }

  private async reopenClientHooks() {
    // Webhooks changed: rebuild the client around the same store and log position.
    const a = this.acct!;
    const hooks = toWebhookRefs(await this.vault!.load());
    this.client = new MetadataClient({
      device: { id: a.deviceId, name: a.deviceName },
      arbiter: new EncryptedArbiter(new OpCodec(accountKeyFromB64(a.accountKey), a.accountId), this.http!),
      transport: this.transport(),
      webhooks: hooks,
      store: this.store!,
    });
    await this.client.pull();
  }

  /** One page of a folder (§4.1: only what is visible is in RAM). */
  list(parentId = ROOT_ID, after?: string, limit = 200): { rows: ChildRow[]; total: number } {
    const s = this.store;
    if (s instanceof SqlIndexStore) return { rows: s.listChildren(parentId, { after, limit }), total: s.countChildren(parentId) };
    // In-memory replica (secondary tab): same contract.
    const rows = this.c().list(parentId).map((x) => ({ id: x.id, name: x.name, kind: x.kind as "file" | "folder", size: x.size, trashed: false, cursor: x.id }));
    return { rows, total: rows.length };
  }

  async mkdir(name: string, parentId = ROOT_ID) {
    const id = crypto.randomUUID().replace(/-/g, "");
    await this.c().commitOp({ type: "create", kind: "folder", nodeId: id, parentId, name: name.normalize("NFC") }, "mkdir");
    this.version++;
    return id;
  }

  async upload(file: Blob, name: string, parentId = ROOT_ID) {
    const r = await this.c().upload(blobSource(file), name, parentId);
    this.version++;
    return { nodeId: r.nodeId, chunks: r.chunks, sha256: r.version.plaintextSha256 };
  }

  async download(nodeId: string): Promise<Blob> {
    const parts: Uint8Array[] = [];
    await this.c().download(nodeId, { write: async (d) => void parts.push(new Uint8Array(d)) });
    return new Blob(parts as BlobPart[]);
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

  /** Pair a new device that shows `code` (§3.8). Returns the 6-digit code to compare. */
  async pairAccept(code: string) {
    const a = this.acct!;
    const http = this.http!;
    return acceptPairing(code, { accountId: a.accountId, accountKey: a.accountKey, fromDevice: a.deviceName }, (pub) => http.addDevice(pub), http.pairingMailbox());
  }

  async devices() {
    return this.http!.listDevices();
  }

  async revokeDevice(id: string) {
    await this.http!.revokeDevice(id);
  }

  close() {
    this.sub?.close();
  }
}
