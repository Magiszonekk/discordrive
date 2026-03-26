// DiscorDrive v4 — Upload store (Zustand)

import { create } from "zustand";
import type { UploadProgress, UploadStatus } from "@ddv4/types";

interface SpeedSample {
  time: number;  // ms epoch
  bytes: number; // cumulative bytes uploaded
}

interface UploadState {
  uploads: Map<string, UploadProgress>;

  addUpload: (fileId: string, fileName: string, totalChunks: number, bytesTotal: number) => void;
  updateUpload: (fileId: string, updates: Partial<UploadProgress>) => void;
  removeUpload: (fileId: string) => void;
  getUpload: (fileId: string) => UploadProgress | undefined;
  registerController: (fileId: string, controller: AbortController) => void;
  cancelUpload: (fileId: string) => void;
}

// Kept outside store state — internal timing data not needed in UI
const speedWindows = new Map<string, SpeedSample[]>();
const SPEED_WINDOW_MS = 10000;
const uploadControllers = new Map<string, AbortController>();

export const useUploadStore = create<UploadState>((set, get) => ({
  uploads: new Map(),

  addUpload: (fileId, fileName, totalChunks, bytesTotal) => {
    speedWindows.set(fileId, []);
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
      if (!current) return { uploads };

      let speedBps = current.speedBps;
      if (updates.bytesUploaded !== undefined) {
        const now = Date.now();
        const window = speedWindows.get(fileId) ?? [];
        window.push({ time: now, bytes: updates.bytesUploaded });

        // Drop samples older than the window
        const cutoff = now - SPEED_WINDOW_MS;
        while (window.length > 1 && window[0].time < cutoff) window.shift();
        speedWindows.set(fileId, window);

        if (window.length >= 2) {
          const oldest = window[0];
          const newest = window[window.length - 1];
          const dt = (newest.time - oldest.time) / 1000;
          if (dt > 0) speedBps = (newest.bytes - oldest.bytes) / dt;
        }
      }

      uploads.set(fileId, { ...current, ...updates, speedBps });
      return { uploads };
    });
  },

  removeUpload: (fileId) => {
    speedWindows.delete(fileId);
    uploadControllers.delete(fileId);
    set((state) => {
      const uploads = new Map(state.uploads);
      uploads.delete(fileId);
      return { uploads };
    });
  },

  getUpload: (fileId) => get().uploads.get(fileId),

  registerController: (fileId, controller) => {
    uploadControllers.set(fileId, controller);
  },

  cancelUpload: (fileId) => {
    uploadControllers.get(fileId)?.abort();
  },
}));
