// DiscorDrive v4 — Download store (Zustand)

import { create } from "zustand";
import { DownloadStatus } from "@ddv4/types";

export interface DownloadProgress {
  fileId: string;
  fileName: string;
  mimeType: string;
  totalChunks: number;
  downloadedChunks: number;
  bytesTotal: number;
  bytesDownloaded: number;
  status: DownloadStatus;
}

interface DownloadState {
  downloads: Map<string, DownloadProgress>;
  addDownload: (fileId: string, fileName: string, mimeType: string, totalChunks: number, bytesTotal: number) => void;
  updateDownload: (fileId: string, updates: Partial<DownloadProgress>) => void;
  removeDownload: (fileId: string) => void;
  getDownload: (fileId: string) => DownloadProgress | undefined;
  registerController: (fileId: string, controller: AbortController) => void;
  cancelDownload: (fileId: string) => void;
}

const downloadControllers = new Map<string, AbortController>();

export const useDownloadStore = create<DownloadState>((set, get) => ({
  downloads: new Map(),

  addDownload: (fileId, fileName, mimeType, totalChunks, bytesTotal) => {
    set((state) => {
      const downloads = new Map(state.downloads);
      downloads.set(fileId, {
        fileId,
        fileName,
        mimeType,
        totalChunks,
        downloadedChunks: 0,
        bytesTotal,
        bytesDownloaded: 0,
        status: DownloadStatus.DOWNLOADING,
      });
      return { downloads };
    });
  },

  updateDownload: (fileId, updates) => {
    set((state) => {
      const downloads = new Map(state.downloads);
      const current = downloads.get(fileId);
      if (!current) return { downloads };
      downloads.set(fileId, { ...current, ...updates });
      return { downloads };
    });
  },

  removeDownload: (fileId) => {
    downloadControllers.delete(fileId);
    set((state) => {
      const downloads = new Map(state.downloads);
      downloads.delete(fileId);
      return { downloads };
    });
  },

  getDownload: (fileId) => get().downloads.get(fileId),
  registerController: (fileId, controller) => downloadControllers.set(fileId, controller),
  cancelDownload: (fileId) => downloadControllers.get(fileId)?.abort(),
}));
