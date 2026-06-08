// DiscorDrive v4 — Domain types (secure files v2)

export enum UploadStatus {
  PENDING = "PENDING",
  ENCRYPTING = "ENCRYPTING",
  UPLOADING = "UPLOADING",
  COMMITTING_MANIFEST = "COMMITTING_MANIFEST",
  DONE = "DONE",
  FAILED = "FAILED",
}

export enum DownloadStatus {
  DOWNLOADING = "DOWNLOADING",
  DECRYPTING = "DECRYPTING",
  DONE = "DONE",
  FAILED = "FAILED",
}

export enum FileStatus {
  UPLOADING = "UPLOADING",
  READY = "READY",
  FAILED = "FAILED",
}

export enum ShareStatus {
  ACTIVE = "ACTIVE",
  REVOKED = "REVOKED",
  EXPIRED = "EXPIRED",
}

export type ShareType = "file";
export type AppMode = "full" | "backend-only";

export interface Argon2Params {
  memoryKB: number;
  iterations: number;
  parallelism: number;
  saltB64: string;
}

export interface UserCryptoRecord {
  userId: string;
  wrappedARKByPassword: Uint8Array;
  wrappedARKByRecovery: Uint8Array;
  argon2Params: Argon2Params;
  createdAt: Date;
  lastPasswordChangeAt: Date;
}

export interface DomainKeyRecord {
  id: string;
  userId: string;
  domain: "files" | "gallery";
  wrappedKey: Uint8Array;
  keyVersion: number;
  createdAt: Date;
}

export interface FileRecord {
  id: string;
  ownerUserId: string;
  parentFolderId: string | null;
  dedupeTokenB64: string | null;
  primaryManifestBlobId: string | null;
  previewBlobId: string | null;
  wrappedFEK: Uint8Array;
  wrappedFEKPreview: Uint8Array | null;
  status: FileStatus;
  totalCiphertextBytes: bigint;
  chunkCount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface FolderRecord {
  id: string;
  ownerUserId: string;
  parentFolderId: string | null;
  encryptedBody: Uint8Array;
  wrappedFolderKey: Uint8Array;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type BlobStorageKind = "LOCAL";

export interface BlobTransportRecord {
  blobId: string;
  ownerUserId: string;
  storageKind: BlobStorageKind;
  storagePath: string;
  ciphertextSizeBytes: bigint;
  ciphertextHash: string | null;
  healthStatus: "healthy" | "missing" | "modified" | null;
  healthCheckedAt: Date | null;
  createdAt: Date;
}

export interface TimestampedTag {
  tag: string;
  at: string;
}

export interface ProviderInfo {
  mode: "local" | "hybrid" | "external";
  providerName?: string;
  providerVersion?: string;
  modelName?: string;
  analyzedAt: string;
}

export interface FileMetadataPlaintext {
  schemaVersion: number;
  fileName: string;
  mimeType: string;
  plaintextSizeBytes: number;
  capturedAt?: string;
  description?: string;
  tags: TimestampedTag[];
  removedTags: TimestampedTag[];
  favorite: boolean;
  hidden: boolean;
  provider?: ProviderInfo;
  scalarLWW: Partial<Record<FileScalarLWWKey, string>>;
}

export type FileScalarLWWKey =
  | "fileName"
  | "mimeType"
  | "plaintextSizeBytes"
  | "capturedAt"
  | "description"
  | "favorite"
  | "hidden"
  | "provider";

export interface FileChunkPointer {
  index: number;
  blobId: string;
  ciphertextSizeBytes: number;
  ciphertextHash?: string;
}

export interface FileChunkManifestPlaintext {
  schemaVersion: number;
  chunkSizeBytes: number;
  chunks: FileChunkPointer[];
}

export interface ShareRecord {
  shareId: string;
  ownerUserId: string;
  capabilityToken: Uint8Array;
  shareType: ShareType;
  allowContent: boolean;
  allowMetadata: boolean;
  allowPreview: boolean;
  status: ShareStatus;
  expiresAt?: Date | null;
  maxViews?: number | null;
  viewCount: number;
  createdAt: Date;
  revokedAt?: Date | null;
}

export interface GrantedAccess {
  accessId: string;
  shareId: string;
  accessType: "public_link";
  wrappedAKShare: Uint8Array;
  createdAt: Date;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
}

export interface ShareWrappedObjectKey {
  id: string;
  shareId: string;
  fileId: string;
  primaryManifestBlobId?: string | null;
  wrappedFEK?: Uint8Array | null;
  wrappedFEKPreview?: Uint8Array | null;
}

export interface UploadProgress {
  fileId: string;
  fileName?: string;
  totalBlobs: number;
  uploadedBlobs: number;
  bytesUploaded: number;
  bytesTotal: number;
  status: UploadStatus;
  speedBps?: number;
}

export interface DownloadProgress {
  fileId: string;
  totalBlobs: number;
  downloadedBlobs: number;
  bytesDownloaded: number;
  bytesTotal: number;
}
