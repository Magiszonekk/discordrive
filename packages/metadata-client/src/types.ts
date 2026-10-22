// discordrive-next metadata-only client: shared types.

/** A user webhook. The URL is a secret (it can delete messages): never log it. */
export interface WebhookRef {
  /** Webhook ID (public part of the URL). */
  id: string;
  /** Full execute URL `https://discord.com/api/webhooks/<id>/<token>`. Secret. */
  url: string;
  /**
   * Channel the webhook posts into. Rate limits are per channel (~30/min,
   * measured 2026-10-06), so the limiter keys on this. Learned from the first
   * response when unknown.
   */
  channelId?: string;
  /** Retired: read from, never posted to. */
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
  /** The attachment's file name (extra attachments next to a manifest are told apart by it). */
  filename?: string;
}

/** One more file in a message (previews next to a manifest). */
export interface ExtraFile {
  filename: string;
  data: Uint8Array;
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
  /**
   * POST a file plus `extra` files as ONE message (at most 9 extra: Discord takes 10 attachments). The
   * result is the first file's attachment; the extra ones come back in `extras` (same order).
   */
  postFiles?(hook: WebhookRef, data: Uint8Array, filename: string, extra: ExtraFile[], signal?: AbortSignal, timing?: ReqTiming): Promise<PostedAttachment & { extras: MessageAttachment[] }>;
  /**
   * Add files to a message sent by this webhook, keeping every attachment it has (their IDs and bytes
   * do not change). Returns all attachments after the edit.
   */
  addFiles?(hook: WebhookRef, messageId: string, keep: string[], extra: ExtraFile[]): Promise<MessageAttachment[]>;
  /** GET a message sent by this webhook; returns fresh signed CDN links. */
  getAttachments(hook: WebhookRef, messageId: string, timing?: ReqTiming): Promise<MessageAttachment[]>;
  /** Download a CDN link; `lane` = which connection (0 = default fetch, ≥1 = setCdnLanes). */
  fetchCdn(url: string, signal?: AbortSignal, timing?: ReqTiming, lane?: number): Promise<Uint8Array>;
  /** GET the webhook itself: validates the URL and tells its channel/guild (no message is sent). */
  inspectWebhook(hook: WebhookRef): Promise<{ id: string; channelId: string; guildId: string | null; name: string }>;
  /**
   * PATCH a message sent by this webhook, replacing its attachments with one
   * new file (works through the webhook; also from a browser).
   */
  editMessageFile(hook: WebhookRef, messageId: string, data: Uint8Array, filename: string): Promise<PostedAttachment>;
  /** DELETE a message sent by this webhook. */
  deleteMessage(hook: WebhookRef, messageId: string): Promise<void>;
}

/** Where a blob lives on Discord. Stored (encrypted) in the manifest. */
export interface DiscordPlacement {
  provider: "discord-webhook";
  /** Webhook ID (the client looks the URL up in its webhook vault). */
  locationId: string;
  channelId: string;
  messageId: string;
  attachmentId: string;
}

/**
 * Where a blob lives on any other storage backend: the provider tag, the backend ID (`locationId`, the
 * same as `BlobBackend.id`) and the backend's own fields, all strings. The core never reads those
 * fields; only the backend of that provider does.
 */
export interface OtherPlacement {
  provider: string;
  locationId: string;
  [field: string]: string;
}

/** Where a blob lives: the `provider` tag says which backend kind reads it. */
export type Placement = DiscordPlacement | OtherPlacement;

export const DISCORD_PROVIDER = "discord-webhook";

export function isDiscordPlacement(p: Placement): p is DiscordPlacement {
  return p.provider === DISCORD_PROVIDER;
}
