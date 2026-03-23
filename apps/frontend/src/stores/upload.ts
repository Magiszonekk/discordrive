// DiscorDrive v4 — Upload store (Zustand)

import { create } from "zustand";
import type { UploadProgress, UploadStatus } from "@ddv4/types";

interface UploadState {
  uploads: Map<string, UploadProgress>;

  addUpload: (fileId: string, fileName: string, totalChunks: number, bytesTotal: number) => void;
  updateUpload: (fileId: string, updates: Partial<UploadProgress>) => void;
  removeUpload: (fileId: string) => void;
  getUpload: (fileId: string) => UploadProgress | undefined;
}

export const useUploadStore = create<UploadState>((set, get) => ({
  uploads: new Map(),

  addUpload: (fileId, fileName, totalChunks, bytesTotal) => {
    set((state) => {
      const uploads = new Map(state.uploads);
      uploads.set(fileId, {
        fileId,
        fileName,
        totalChunks,
        uploadedChunks: 0,
        bytesUploaded: 0,
        bytesTotal,
        status: "PENDING" as UploadStatus,
      });
      return { uploads };
    });
  },

  updateUpload: (fileId, updates) => {
    set((state) => {
      const uploads = new Map(state.uploads);
      const current = uploads.get(fileId);
      if (current) {
        uploads.set(fileId, { ...current, ...updates });
      }
      return { uploads };
    });
  },

  removeUpload: (fileId) => {
    set((state) => {
      const uploads = new Map(state.uploads);
      uploads.delete(fileId);
      return { uploads };
    });
  },

  getUpload: (fileId) => get().uploads.get(fileId),
}));
