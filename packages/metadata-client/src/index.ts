// @ddv4/metadata-client: discordrive-next stage 2, metadata-only mode (koncept §3, §6.5).

export * from "./types.js";
export { MemoryTransport } from "./memory-transport.js";
export { DiscordWebhookTransport, DiscordHttpError, RateLimitedError, parseWebhookUrl, redactWebhookUrl } from "./discord-transport.js";
export { ChannelPacer, type PacerOptions } from "./rate-limit.js";
export { LocalArbiter, type ArbiterApi } from "./arbiter.js";
export {
  FRAGMENT_FORMAT_VERSION,
  newFileKey,
  importFileKey,
  encryptFragment,
  decryptFragment,
  encryptManifest,
  decryptManifest,
  sha256Hex,
  type FileKey,
} from "./file-crypto.js";
export {
  MetadataClient,
  OpFailedError,
  DEFAULT_CHUNK_SIZE,
  MANIFEST_SCHEMA_VERSION,
  decodeManifestRef,
  encodeManifestRef,
  memorySource,
  newId,
  type ByteSink,
  type ByteSource,
  type ManifestLocator,
  type MetadataClientOptions,
  type UploadResult,
} from "./client.js";
