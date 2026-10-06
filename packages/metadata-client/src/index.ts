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
export {
  accountKeyFromB64,
  accountKeyFromRaw,
  newAccountKey,
  seal,
  unseal,
  sealJson,
  unsealJson,
  UnsealError,
  ACCOUNT_KEY_BYTES,
  type AccountKey,
  type SubkeyLabel,
} from "./account-key.js";
export {
  WebhookVault,
  MemoryVaultStore,
  VaultRollbackError,
  emptyVault,
  inspectForVault,
  openVault,
  sealVault,
  toWebhookRefs,
  vaultAdvice,
  REQUIRED_CHANNELS,
  RECOMMENDED_CHANNELS,
  VAULT_FORMAT,
  VAULT_FORMAT_VERSION,
  type SealedVault,
  type VaultAdvice,
  type VaultContent,
  type VaultPutResult,
  type VaultStore,
  type VaultWebhook,
} from "./vault.js";
export {
  OpCodec,
  EncryptedArbiter,
  InProcessLogServer,
  UNDECRYPTABLE_DEVICE,
  type EncryptedEnvelope,
  type EncryptedEntry,
  type EncryptedLogApi,
} from "./op-crypto.js";
