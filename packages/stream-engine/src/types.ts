// DiscorDrive v4 — Stream Engine types
// Environment-agnostic interfaces for chunk upload/download.

/** Źródło zaszyfrowanych chunków (download) */
export interface ChunkSource {
  fetch(fileId: string, chunkIndex: number): Promise<ArrayBuffer>;
}

/** Cel uploadu zaszyfrowanych chunków (upload) */
export interface ChunkSink {
  upload(fileId: string, chunkIndex: number, encrypted: ArrayBuffer): Promise<void>;
}

/** Konfiguracja zarejestrowanego streamu (download) */
export interface StreamConfig {
  fileId: string;
  fek: CryptoKey;
  chunkSize: number;
  chunkCount: number;
  totalSize: number;
  mimeType: string;
  chunksAhead: number;
  chunksBehind: number;
}

/** Konfiguracja uploadu */
export interface UploadConfig {
  fek: CryptoKey;
  chunkSize: number;
  concurrency: number;
}

/** Progress callback dla uploadu */
export interface UploadProgress {
  chunkIndex: number;
  uploadedChunks: number;
  totalChunks: number;
  bytesUploaded: number;
  totalBytes: number;
}
