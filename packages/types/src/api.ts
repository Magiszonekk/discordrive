// DiscorDrive v4 — API request/response types (secure files v2)

export interface Argon2ParamsDto {
  memoryKB: number;
  iterations: number;
  parallelism: number;
  saltB64: string;
}

export interface RegisterRequest {
  email: string;
  username: string;
  wrappedARKByPassword: string;
  wrappedARKByRecovery: string;
  argon2Params: Argon2ParamsDto;
  serverAuthProof: string; // base64 — HKDF("ddv4-server-auth-v1") from Argon2 output
}

export interface LoginChallengeDto {
  argon2Params: Argon2ParamsDto;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    username: string | null;
    crypto: {
      wrappedARKByPassword: string;
      wrappedARKByRecovery: string;
      argon2Params: Argon2ParamsDto;
      lastPasswordChangeAt: string;
    };
  };
  /** Present only for device-session logins (deviceName provided) */
  refreshToken?: string;
}

export interface InitSecureUploadRequest {
  parentFolderId?: string;
  encryptedName?: string;
  encryptedMimeType?: string;
  wrappedFEK: string;
  wrappedFEKPreview?: string;
  dedupeTokenB64?: string;
  totalCiphertextBytes: string;
  chunkCount: number;
}

export interface InitUploadResponse {
  fileId: string;
  status: "uploading";
}

export interface UploadedBlobTransportInput {
  blobId: string;
  storageKind: "LOCAL" | "DISCORD" | "TELEGRAM";
  storagePath: string;
  ciphertextSizeBytes: string;
  ciphertextHash?: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
}

export interface CommitManifestRequest {
  fileId: string;
  manifestBlobId: string;
  totalCiphertextBytes: string;
  chunkCount: number;
  blobs: UploadedBlobTransportInput[];
}

export interface FinalizeUploadResponse {
  success: boolean;
}

export interface CreateFileShareRequest {
  fileId: string;
  capabilityToken: string;
  wrappedAKShare: string;
  wrappedFEK?: string;
  /** Wrap(AK_share, FEK_preview) — lets recipients decrypt the low-res preview */
  wrappedFEKPreview?: string;
  allowContent: boolean;
  allowMetadata: boolean;
  allowPreview: boolean;
  expiresAt?: string;
  maxViews?: number;
}

export interface ShareAccessResponse {
  shareId: string;
  wrappedAKShare: string;
  wrappedObjectKeys: Array<{
    fileId: string;
    primaryManifestBlobId?: string;
    /** Only present when allowPreview */
    previewBlobId?: string;
    /** Only present when allowMetadata */
    encryptedName?: string;
    encryptedMimeType?: string;
    wrappedFEK?: string;
    wrappedFEKPreview?: string;
    /** Not permission-gated — transport shape, not file content. */
    totalCiphertextBytes?: string;
    chunkCount?: number;
  }>;
  allowContent: boolean;
  allowMetadata: boolean;
  allowPreview: boolean;
}

export type BlobStorageKindDto = "LOCAL" | "DISCORD" | "TELEGRAM";

export interface BlobTransportMetadataDto {
  blobId: string;
  ownerUserId: string;
  storageKind: BlobStorageKindDto;
  storagePath: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
  ciphertextSizeBytes: string;
  ciphertextHash?: string;
  healthStatus?: "healthy" | "missing" | "modified";
  healthCheckedAt?: string;
  createdAt: string;
}

export interface BlobFetchAuthorizationResponse {
  blobId: string;
  storageKind: BlobStorageKindDto;
  storagePath: string;
  discordMessageId?: string;
  discordChannelId?: string;
  webhookId?: string;
  ciphertextSizeBytes: string;
  ciphertextHash?: string;
}
