// DiscorDrive v4 — Domain types

// === Enums ===

export enum UploadStatus {
  PENDING = "PENDING",
  HASHING = "HASHING",
  ENCRYPTING = "ENCRYPTING",
  UPLOADING = "UPLOADING",
  FINALIZING = "FINALIZING",
  DONE = "DONE",
  FAILED = "FAILED",
}

export enum FileStatus {
  UPLOADING = "UPLOADING",
  READY = "READY",
  FAILED = "FAILED",
}

export type AppMode = "full" | "backend-only";

// === Core domain interfaces ===

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  kekSalt: string;
  wrapIv: string;
  encryptedMasterKey: string;
  createdAt: Date;
}

export interface File {
  id: string;
  userId: string;
  folderId: string | null;
  name: string;
  mimeType: string;
  size: bigint;
  chunkSize: number;
  chunkCount: number;
  encryptedFEK: string;
  fekIv: string;
  sha256: string | null;
  thumbnailUrl: string | null;
  status: FileStatus;
  createdAt: Date;
}

export interface Chunk {
  id: string;
  fileId: string;
  index: number;
  messageId: string;
  channelId: string;
  webhookId: string;
  size: number;
}

export interface Folder {
  id: string;
  userId: string;
  parentId: string | null;
  name: string;
  createdAt: Date;
}

export interface ShareLink {
  token: string;
  fileId: string;
  userId: string;
  wrappedFEK: string;
  wrapIv: string;
  passwordHash: string | null;
  passwordSalt: string | null;
  expiresAt: Date | null;
  label: string | null;
  downloads: number;
  maxDownloads: number | null;
  createdAt: Date;
}

// === Progress tracking (client-side) ===

export interface UploadProgress {
  fileId: string;
  fileName: string;
  totalChunks: number;
  uploadedChunks: number;
  bytesUploaded: number;
  bytesTotal: number;
  status: UploadStatus;
  speedBps?: number;
}

export interface DownloadProgress {
  fileId: string;
  fileName: string;
  totalChunks: number;
  downloadedChunks: number;
  bytesDownloaded: number;
  bytesTotal: number;
}

// === Operational ===

export interface ChunkMeta {
  index: number;
  messageId: string;
  channelId: string;
  webhookId: string;
  size: number;
}

export interface WebhookHealth {
  id: string;
  channelId: string;
  remaining: number;
  resetAt: number;
  isAvailable: boolean;
}
