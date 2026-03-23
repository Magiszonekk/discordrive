// DiscorDrive v4 — API request/response types

export interface RegisterRequest {
  email: string;
  password: string;
  kekSalt: string;
  wrapIv: string;
  encryptedMasterKey: string;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    kekSalt: string;
    wrapIv: string;
    encryptedMasterKey: string;
  };
}

export interface InitUploadRequest {
  name: string;
  mimeType: string;
  size: string; // BigInt serialized as string
  chunkSize: number;
  chunkCount: number;
  encryptedFEK: string;
  fekIv: string;
  folderId?: string;
}

export interface InitUploadResponse {
  fileId: string;
}

export interface FinalizeUploadRequest {
  fileId: string;
  sha256: string;
}

export interface FinalizeUploadResponse {
  success: boolean;
  missingChunks?: number[];
}

export interface CreateShareRequest {
  fileId: string;
  wrappedFEK: string;
  wrapIv: string;
  password?: string;
  expiresAt?: string;
  label?: string;
  maxDownloads?: number;
}

export interface ShareInfoResponse {
  fileName: string;
  fileSize: string; // BigInt serialized as string
  mimeType: string;
  wrappedFEK: string;
  wrapIv: string;
  isPasswordProtected: boolean;
  chunkCount: number;
  chunkSize: number;
}
