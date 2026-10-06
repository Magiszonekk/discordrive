// Webhook vault (koncept §3.2).
//
// The user's webhooks (URL = token that can delete messages) are kept in one
// blob encrypted with the account key (subkey "vault"). The server stores the
// blob and a revision number, nothing else: it can neither read nor
// meaningfully alter it.
//
// - AAD = "ddn-vault-v1|<accountId>|<revision>": the server cannot hand the
//   blob of another account, nor relabel an old blob with a new revision.
// - Rollback: a client remembers the highest revision it has seen and refuses
//   an older one (the server could otherwise replay an old, still validly
//   sealed blob, e.g. one with a webhook the user already removed).
// - Concurrent edits from two devices: compare-and-swap on the revision; the
//   loser re-reads and re-applies its change (changes are add/remove by
//   webhook ID, so re-applying is always meaningful).
//
// Account wizard (owner decision #12, 2026-10-06): one channel with a webhook
// is required, the wizard encourages 3–4 channels, because Discord limits
// posts per CHANNEL (~30/min, koncept §7); several webhooks in one channel do
// not add throughput.

import { sealJson, unsealJson, type AccountKey } from "./account-key.js";
import { parseWebhookUrl } from "./discord-transport.js";
import type { WebhookRef, WebhookTransport } from "./types.js";

export const VAULT_FORMAT = "ddn-webhook-vault";
export const VAULT_FORMAT_VERSION = 1;
export const REQUIRED_CHANNELS = 1;
export const RECOMMENDED_CHANNELS = 3;

export interface VaultWebhook {
  id: string;
  /** Secret. */
  url: string;
  channelId: string;
  guildId: string | null;
  /** Display only (webhook name in Discord). */
  label: string;
  addedAt: number;
}

export interface VaultContent {
  format: typeof VAULT_FORMAT;
  version: number;
  webhooks: VaultWebhook[];
}

/** What the server stores. `revision` 0 = no vault yet. */
export interface SealedVault {
  revision: number;
  blob: Uint8Array;
}

export type VaultPutResult = { status: "ok" } | { status: "conflict"; current: SealedVault | null };

/** Server-side storage (in-memory/file now, HTTP later). Opaque blobs only. */
export interface VaultStore {
  get(accountId: string): Promise<SealedVault | null>;
  /** Compare-and-swap: succeeds only when the stored revision equals `expectedRevision` (0 = none yet). */
  put(accountId: string, expectedRevision: number, next: SealedVault): Promise<VaultPutResult>;
}

export class MemoryVaultStore implements VaultStore {
  readonly data = new Map<string, SealedVault>();
  async get(accountId: string): Promise<SealedVault | null> {
    const v = this.data.get(accountId);
    return v ? { revision: v.revision, blob: new Uint8Array(v.blob) } : null;
  }
  async put(accountId: string, expectedRevision: number, next: SealedVault): Promise<VaultPutResult> {
    const cur = this.data.get(accountId) ?? null;
    if ((cur?.revision ?? 0) !== expectedRevision || next.revision !== expectedRevision + 1) {
      return { status: "conflict", current: cur ? { revision: cur.revision, blob: new Uint8Array(cur.blob) } : null };
    }
    this.data.set(accountId, { revision: next.revision, blob: new Uint8Array(next.blob) });
    return { status: "ok" };
  }
}

export class VaultRollbackError extends Error {
  constructor(seen: number, got: number) {
    super(`vault revision went back from ${seen} to ${got}: refusing (server rollback?)`);
    this.name = "VaultRollbackError";
  }
}

const aad = (accountId: string, revision: number) => `ddn-vault-v1|${accountId}|${revision}`;

export function emptyVault(): VaultContent {
  return { format: VAULT_FORMAT, version: VAULT_FORMAT_VERSION, webhooks: [] };
}

export async function sealVault(key: AccountKey, accountId: string, revision: number, v: VaultContent): Promise<SealedVault> {
  return { revision, blob: await sealJson(await key.subkey("vault"), v, aad(accountId, revision)) };
}

export async function openVault(key: AccountKey, accountId: string, s: SealedVault): Promise<VaultContent> {
  const v = await unsealJson<VaultContent>(await key.subkey("vault"), s.blob, aad(accountId, s.revision), "webhook vault");
  if (v.format !== VAULT_FORMAT || v.version !== VAULT_FORMAT_VERSION || !Array.isArray(v.webhooks)) {
    throw new Error("unsupported vault format");
  }
  return v;
}

export interface VaultAdvice {
  webhooks: number;
  channels: number;
  /** At least REQUIRED_CHANNELS. */
  ok: boolean;
  /** Fewer than RECOMMENDED_CHANNELS: the wizard suggests adding more. */
  suggestMore: boolean;
  /** Channels with more than one webhook (no extra throughput). */
  sharedChannels: string[];
  message: string;
}

/** Wizard text (decision #12). */
export function vaultAdvice(v: VaultContent): VaultAdvice {
  const perChan = new Map<string, number>();
  for (const w of v.webhooks) perChan.set(w.channelId, (perChan.get(w.channelId) ?? 0) + 1);
  const channels = perChan.size;
  const sharedChannels = [...perChan].filter(([, n]) => n > 1).map(([c]) => c).sort();
  const ok = channels >= REQUIRED_CHANNELS;
  const suggestMore = channels < RECOMMENDED_CHANNELS;
  let message: string;
  if (!ok) message = "Dodaj co najmniej 1 kanał z webhookiem.";
  else if (suggestMore)
    message = `Kanały: ${channels}. Discord ogranicza wysyłanie na kanał (~30 fragmentów/min, ~4 MiB/s), więc 3–4 kanały, każdy z jednym webhookiem, przyspieszą upload.`;
  else message = `Kanały: ${channels}. Gotowe.`;
  if (sharedChannels.length) message += " Kilka webhooków w jednym kanale nie przyspiesza uploadu, lepiej osobne kanały.";
  return { webhooks: v.webhooks.length, channels, ok, suggestMore, sharedChannels, message };
}

export function toWebhookRefs(v: VaultContent): WebhookRef[] {
  return v.webhooks.map((w) => ({ id: w.id, url: w.url, channelId: w.channelId }));
}

/** Client view of the vault: decrypts, edits with CAS + retry, guards against rollback. */
export class WebhookVault {
  private seenRevision = 0;
  private cache: { revision: number; content: VaultContent } | null = null;

  constructor(
    private readonly store: VaultStore,
    private readonly key: AccountKey,
    readonly accountId: string,
    /** Highest revision this device has seen before (persist it locally). */
    seenRevision = 0,
  ) {
    this.seenRevision = seenRevision;
  }

  get revision(): number {
    return this.seenRevision;
  }

  async load(): Promise<VaultContent> {
    const s = await this.store.get(this.accountId);
    return this.accept(s);
  }

  private async accept(s: SealedVault | null): Promise<VaultContent> {
    const rev = s?.revision ?? 0;
    if (rev < this.seenRevision) throw new VaultRollbackError(this.seenRevision, rev);
    const content = s ? await openVault(this.key, this.accountId, s) : emptyVault();
    this.seenRevision = rev;
    this.cache = { revision: rev, content };
    return content;
  }

  /** Apply `change` to the latest content and store it; retries on concurrent edits. */
  async update(change: (v: VaultContent) => VaultContent, maxAttempts = 5): Promise<VaultContent> {
    if (!this.cache) await this.load();
    let cur = this.cache!;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const next = change(structuredClone(cur.content));
      const sealed = await sealVault(this.key, this.accountId, cur.revision + 1, next);
      const r = await this.store.put(this.accountId, cur.revision, sealed);
      if (r.status === "ok") {
        this.seenRevision = sealed.revision;
        this.cache = { revision: sealed.revision, content: next };
        return next;
      }
      const content = await this.accept(r.current);
      cur = { revision: r.current?.revision ?? 0, content };
    }
    throw new Error("vault update: too many concurrent edits");
  }

  async addWebhook(w: VaultWebhook): Promise<VaultContent> {
    return this.update((v) => {
      v.webhooks = v.webhooks.filter((x) => x.id !== w.id);
      v.webhooks.push(w);
      v.webhooks.sort((a, b) => (a.addedAt - b.addedAt) || (a.id < b.id ? -1 : 1));
      return v;
    });
  }

  async removeWebhook(id: string): Promise<VaultContent> {
    return this.update((v) => {
      v.webhooks = v.webhooks.filter((x) => x.id !== id);
      return v;
    });
  }
}

/**
 * Wizard step: check a pasted URL against Discord (GET webhook, no message
 * sent) and build the vault entry. The URL is never echoed in errors.
 */
export async function inspectForVault(
  transport: WebhookTransport,
  url: string,
  now: () => number = () => Date.now(),
): Promise<VaultWebhook> {
  const ref = parseWebhookUrl(url);
  const info = await transport.inspectWebhook(ref);
  return { id: info.id, url: ref.url, channelId: info.channelId, guildId: info.guildId, label: info.name, addedAt: now() };
}
