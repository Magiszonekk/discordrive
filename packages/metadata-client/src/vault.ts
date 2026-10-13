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
  /**
   * Retired (zlecenie 2026-10-13-webhooki, option 1): gets no new pieces, still read. Optional
   * field next to the old ones (no format bump): a tab on the previous bundle keeps it when it
   * edits the vault (update() clones the whole content) and simply ignores it.
   */
  retired?: boolean;
  /**
   * Moved away (option 2): nothing current is on it any more, but older log entries and kept snapshot
   * bases still name its messages, so it stays (retired, URL kept, read only) until the retention of
   * §6.2 has passed; then the cleanup deletes what the move replaced (relocate entries fromSeq..toSeq)
   * and the webhook leaves the vault ("moved").
   */
  drain?: { at: number; fromSeq: number; toSeq: number; oldPointer?: { webhookId: string; messageId: string } };
}

/** A webhook that left the vault (no URL kept: it is a secret the user removed). */
export interface RemovedWebhook {
  id: string;
  channelId: string;
  label: string;
  removedAt: number;
  /** "moved": its data was moved off first; "removed": removed anyway (files with pieces there are unavailable). */
  how: "moved" | "removed";
}

export interface VaultContent {
  format: typeof VAULT_FORMAT;
  version: number;
  webhooks: VaultWebhook[];
  /** The account's snapshot pointer message (§6.2), once created. Part of the rescue kit. */
  pointer?: { webhookId: string; messageId: string };
  /** Webhooks removed from the account, newest first (optional, like `retired`). */
  removed?: RemovedWebhook[];
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

/** Wizard text (decision #12). Counts the channels that take new pieces (a retired one only keeps what it has). */
export function vaultAdvice(v: VaultContent): VaultAdvice {
  const perChan = new Map<string, number>();
  for (const w of v.webhooks) if (!w.retired && !w.drain) perChan.set(w.channelId, (perChan.get(w.channelId) ?? 0) + 1);
  const channels = perChan.size;
  const sharedChannels = [...perChan].filter(([, n]) => n > 1).map(([c]) => c).sort();
  const ok = channels >= REQUIRED_CHANNELS;
  const suggestMore = channels < RECOMMENDED_CHANNELS;
  let message: string;
  // English; the web app translates from the fields above (apps/web-mo i18n).
  if (!ok) message = "Add at least 1 channel with a webhook.";
  else if (suggestMore)
    message = `Channels: ${channels}. Discord limits uploads per channel (~30 pieces/min, ~4 MiB/s), so 3–4 channels, each with one webhook, make uploads faster.`;
  else message = `Channels: ${channels}. All set.`;
  if (sharedChannels.length) message += " Several webhooks in one channel do not speed up uploads; use separate channels.";
  return { webhooks: v.webhooks.length, channels, ok, suggestMore, sharedChannels, message };
}

/** Every webhook of the vault (reading needs the retired ones too). */
export function toWebhookRefs(v: VaultContent): WebhookRef[] {
  return v.webhooks.map((w) => ({ id: w.id, url: w.url, channelId: w.channelId, ...(w.retired ? { retired: true } : {}) }));
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

  /** Add (or paste again: same ID = the same webhook, its removed entry goes, its files are readable again). */
  async addWebhook(w: VaultWebhook): Promise<VaultContent> {
    return this.update((v) => {
      v.webhooks = v.webhooks.filter((x) => x.id !== w.id);
      v.webhooks.push(w);
      v.webhooks.sort((a, b) => (a.addedAt - b.addedAt) || (a.id < b.id ? -1 : 1));
      if (v.removed) v.removed = v.removed.filter((x) => x.id !== w.id);
      return v;
    });
  }

  /** Remove; `how` is remembered in `removed` (no URL) so Settings can say what happened to its files. */
  async removeWebhook(id: string, how: RemovedWebhook["how"] = "removed", now = Date.now()): Promise<VaultContent> {
    return this.update((v) => {
      const w = v.webhooks.find((x) => x.id === id);
      v.webhooks = v.webhooks.filter((x) => x.id !== id);
      if (w) v.removed = [{ id: w.id, channelId: w.channelId, label: w.label, removedAt: now, how }, ...(v.removed ?? []).filter((x) => x.id !== id)].slice(0, 50);
      return v;
    });
  }

  /** The move finished: keep it retired and read-only until the cleanup's drain (see VaultWebhook.drain). */
  async setDrain(id: string, drain: VaultWebhook["drain"]): Promise<VaultContent> {
    return this.update((v) => {
      for (const w of v.webhooks) if (w.id === id) ((w.retired = true), (w.drain = drain));
      return v;
    });
  }

  async setRetired(id: string, retired: boolean): Promise<VaultContent> {
    return this.update((v) => {
      for (const w of v.webhooks) if (w.id === id) (retired ? (w.retired = true) : delete w.retired);
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
