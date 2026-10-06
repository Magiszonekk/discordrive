// In-memory fake of the Discord webhook surface, for automatic tests.
// Deterministic snowflake-like IDs; optional failure injection.

import type { MessageAttachment, PostedAttachment, WebhookRef, WebhookTransport } from "./types.js";

interface StoredMessage {
  webhookId: string;
  channelId: string;
  attachments: { id: string; data: Uint8Array; filename: string }[];
}

export class MemoryTransport implements WebhookTransport {
  readonly messages = new Map<string, StoredMessage>();
  private readonly blobs = new Map<string, Uint8Array>();
  private nextId = 1_000_000n;
  private linkGen = 0;
  /** Max attachment size (Discord without boosts: 20 MiB passes, 24 MiB is 413; koncept §7). */
  maxBytes = 20 * 1024 * 1024;
  posts = 0;
  /** Called before each post; throw to inject a failure. */
  beforePost?: (n: number) => void;

  constructor(private readonly channelOf: (webhookId: string) => string = (id) => `chan-${id}`) {}

  private snowflake(): string {
    this.nextId += 1n;
    return this.nextId.toString();
  }

  private link(attachmentId: string): string {
    // A new signature on every GET, like Discord's ex/is/hm params.
    return `mem://cdn/${attachmentId}?sig=${++this.linkGen}`;
  }

  async postFile(hook: WebhookRef, data: Uint8Array, filename: string): Promise<PostedAttachment> {
    this.beforePost?.(this.posts);
    this.posts++;
    if (data.byteLength > this.maxBytes) throw new Error("413 Payload Too Large");
    const messageId = this.snowflake();
    const attachmentId = this.snowflake();
    const channelId = this.channelOf(hook.id);
    const copy = new Uint8Array(data);
    this.messages.set(messageId, { webhookId: hook.id, channelId, attachments: [{ id: attachmentId, data: copy, filename }] });
    this.blobs.set(attachmentId, copy);
    return { webhookId: hook.id, channelId, messageId, attachmentId, sizeBytes: copy.byteLength, url: this.link(attachmentId) };
  }

  async editMessageFile(hook: WebhookRef, messageId: string, data: Uint8Array, filename: string): Promise<PostedAttachment> {
    const m = this.messages.get(messageId);
    if (!m || m.webhookId !== hook.id) throw new Error("404 Unknown Message");
    if (data.byteLength > this.maxBytes) throw new Error("413 Payload Too Large");
    for (const a of m.attachments) this.blobs.delete(a.id);
    const attachmentId = this.snowflake();
    const copy = new Uint8Array(data);
    m.attachments = [{ id: attachmentId, data: copy, filename }];
    this.blobs.set(attachmentId, copy);
    this.edits++;
    return { webhookId: hook.id, channelId: m.channelId, messageId, attachmentId, sizeBytes: copy.byteLength, url: this.link(attachmentId) };
  }
  edits = 0;

  async getAttachments(hook: WebhookRef, messageId: string): Promise<MessageAttachment[]> {
    const m = this.messages.get(messageId);
    if (!m || m.webhookId !== hook.id) throw new Error("404 Unknown Message");
    return m.attachments.map((a) => ({ id: a.id, url: this.link(a.id), size: a.data.byteLength }));
  }

  async fetchCdn(url: string): Promise<Uint8Array> {
    const m = /^mem:\/\/cdn\/(\d+)\?sig=\d+$/.exec(url);
    const b = m ? this.blobs.get(m[1]!) : undefined;
    if (!b) throw new Error("404 CDN");
    return new Uint8Array(b);
  }

  async inspectWebhook(hook: WebhookRef): Promise<{ id: string; channelId: string; guildId: string | null; name: string }> {
    if (this.deadHooks.has(hook.id)) throw new Error("webhook get: HTTP 404");
    return { id: hook.id, channelId: this.channelOf(hook.id), guildId: "guild-mem", name: `hook-${hook.id}` };
  }
  /** Webhooks that answer 404 (deleted in Discord). */
  readonly deadHooks = new Set<string>();

  async deleteMessage(hook: WebhookRef, messageId: string): Promise<void> {
    const m = this.messages.get(messageId);
    if (!m || m.webhookId !== hook.id) throw new Error("404 Unknown Message");
    for (const a of m.attachments) this.blobs.delete(a.id);
    this.messages.delete(messageId);
  }

  /** Test helper: flip one byte of a stored attachment. */
  corrupt(attachmentId: string, at = 20): void {
    const b = this.blobs.get(attachmentId);
    if (b) b[at % b.byteLength] = (b[at % b.byteLength]! ^ 0xff) & 0xff;
  }
}
