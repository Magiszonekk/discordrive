// DiscorDrive v4 — Upload store (Zustand)

import { create } from "zustand";
import { UploadStatus } from "@ddv4/types";
import type { UploadProgress } from "@ddv4/types";

// Abort controllers live outside Zustand state (not serializable, no re-renders needed)
const abortControllers = new Map<string, AbortController>();

interface UploadState {
  uploads: Map<string, UploadProgress>;

  addUpload: (fileId: string, fileName: string, totalChunks: number, bytesTotal: number) => void;
  updateUpload: (fileId: string, updates: Partial<UploadProgress>) => void;
  removeUpload: (fileId: string) => void;
  getUpload: (fileId: string) => UploadProgress | undefined;
  registerAbortController: (fileId: string, ctrl: AbortController) => void;
  cancelUpload: (fileId: string) => void;
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
    abortControllers.delete(fileId);
    set((state) => {
      const uploads = new Map(state.uploads);
      uploads.delete(fileId);
      return { uploads };
    });
  },

  getUpload: (fileId) => get().uploads.get(fileId),

  registerAbortController: (fileId, ctrl) => {
    abortControllers.set(fileId, ctrl);
  },

  cancelUpload: (fileId) => {
    const ctrl = abortControllers.get(fileId);
    if (ctrl) {
      ctrl.abort();
      abortControllers.delete(fileId);
    }
    set((state) => {
      const uploads = new Map(state.uploads);
      const current = uploads.get(fileId);
      if (current) {
        uploads.set(fileId, { ...current, status: UploadStatus.CANCELLED });
      }
      return { uploads };
    });
  },
}));
