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
  /** Retired (zlecenie 2026-10-13-webhooki): read from, never posted to. */
  retired?: boolean;
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
/** Filled by a transport for transfer logs: time to the response headers and the HTTP status. */
export interface ReqTiming {
  ttfb?: number;
  st?: number;
  /** Connection (lane) used, when there is more than one. */
  lane?: number;
}

export interface WebhookTransport {
  /** POST one file as a new message (`?wait=true`). */
  postFile(hook: WebhookRef, data: Uint8Array, filename: string, signal?: AbortSignal, timing?: ReqTiming): Promise<PostedAttachment>;
  /** GET a message sent by this webhook; returns fresh signed CDN links (koncept §7). */
  getAttachments(hook: WebhookRef, messageId: string, timing?: ReqTiming): Promise<MessageAttachment[]>;
  /** Download a CDN link; `lane` = which connection (0 = default fetch, ≥1 = setCdnLanes). */
  fetchCdn(url: string, signal?: AbortSignal, timing?: ReqTiming, lane?: number): Promise<Uint8Array>;
  /** GET the webhook itself: validates the URL and tells its channel/guild (no message is sent). */
  inspectWebhook(hook: WebhookRef): Promise<{ id: string; channelId: string; guildId: string | null; name: string }>;
  /**
   * PATCH a message sent by this webhook, replacing its attachments with one
   * new file (koncept §7: works through the webhook, also from a browser).
   */
  editMessageFile(hook: WebhookRef, messageId: string, data: Uint8Array, filename: string): Promise<PostedAttachment>;
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
