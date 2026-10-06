// discordrive-next metadata-only client: shared types (koncept §3).

/** A user webhook. The URL is a secret (it can delete messages): never log it. */
export interface WebhookRef {
  /** Webhook ID (public part of the URL). */
  id: string;
  /** Full execute URL `https://discord.com/api/webhooks/<id>/<token>`. Secret. */
  url: string;
  /**
   * Channel the webhook posts into. Rate limits are per channel (koncept §7,
   * measured 2026-10-06), so the limiter keys on this. Learned from the first
   * response when unknown.
   */
  channelId?: string;
}

/** Result of posting one attachment through a webhook. */
export interface PostedAttachment {
  webhookId: string;
  channelId: string;
  messageId: string;
  attachmentId: string;
  sizeBytes: number;
  /** Signed CDN link (expires ~24 h). Not stored in the index. */
  url: string;
}

export interface MessageAttachment {
  id: string;
  url: string;
  size: number;
}

/**
 * Minimal Discord surface the client needs. Real implementation:
 * `DiscordWebhookTransport` (fetch, Node + browser). Tests: `MemoryTransport`.
 */
export interface WebhookTransport {
  /** POST one file as a new message (`?wait=true`). */
  postFile(hook: WebhookRef, data: Uint8Array, filename: string): Promise<PostedAttachment>;
  /** GET a message sent by this webhook; returns fresh signed CDN links (koncept §7). */
  getAttachments(hook: WebhookRef, messageId: string): Promise<MessageAttachment[]>;
  /** Download a CDN link. */
  fetchCdn(url: string): Promise<Uint8Array>;
  /** DELETE a message sent by this webhook. */
  deleteMessage(hook: WebhookRef, messageId: string): Promise<void>;
}

/** Where a fragment lives. Stored (encrypted) in the manifest; provider tag for future backends. */
export interface DiscordPlacement {
  provider: "discord-webhook";
  /** Webhook ID (the client looks the URL up in its webhook vault). */
  locationId: string;
  channelId: string;
  messageId: string;
  attachmentId: string;
}
