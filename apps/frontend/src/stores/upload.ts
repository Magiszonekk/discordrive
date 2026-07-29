// DiscorDrive v4 — Upload store (Zustand)

import { create } from "zustand";
import type { UploadProgress, UploadStatus } from "@ddv4/types";

interface SpeedSample {
  time: number;
  bytes: number;
}

interface UploadState {
  uploads: Map<string, UploadProgress>;
  addUpload: (fileId: string, totalBlobs: number, bytesTotal: number, fileName?: string) => void;
  updateUpload: (fileId: string, updates: Partial<UploadProgress>) => void;
  removeUpload: (fileId: string) => void;
  getUpload: (fileId: string) => UploadProgress | undefined;
  registerController: (fileId: string, controller: AbortController) => void;
  cancelUpload: (fileId: string) => void;
}

const speedWindows = new Map<string, SpeedSample[]>();
const smoothedSpeeds = new Map<string, number>();
const SPEED_WINDOW_MS = 10000;
const EMA_ALPHA = 0.10;
const uploadControllers = new Map<string, AbortController>();

export const useUploadStore = create<UploadState>((set, get) => ({
  uploads: new Map(),

  addUpload: (fileId, totalBlobs, bytesTotal, fileName) => {
    speedWindows.set(fileId, []);
    // Cleared, not zeroed: a stored 0 would seed the EMA below and make the
    // speed ramp up from nothing, inflating every ETA derived early on.
    smoothedSpeeds.delete(fileId);
    set((state) => {
      const uploads = new Map(state.uploads);
      uploads.set(fileId, {
        fileId,
        fileName,
        totalBlobs,
        uploadedBlobs: 0,
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
        const cutoff = now - SPEED_WINDOW_MS;
        while (window.length > 1 && window[0]!.time < cutoff) window.shift();
        speedWindows.set(fileId, window);

        if (window.length >= 2) {
          const oldest = window[0]!;
          const newest = window[window.length - 1]!;
          const dt = (newest.time - oldest.time) / 1000;
          if (dt > 0) {
            const raw = (newest.bytes - oldest.bytes) / dt;
            const prev = smoothedSpeeds.get(fileId);
            const smoothed = prev ? prev * (1 - EMA_ALPHA) + raw * EMA_ALPHA : raw;
            smoothedSpeeds.set(fileId, smoothed);
            speedBps = smoothed;
          }
        }
      }

      uploads.set(fileId, { ...current, ...updates, speedBps });
      return { uploads };
    });
  },

  removeUpload: (fileId) => {
    speedWindows.delete(fileId);
    smoothedSpeeds.delete(fileId);
    uploadControllers.delete(fileId);
    set((state) => {
      const uploads = new Map(state.uploads);
      uploads.delete(fileId);
      return { uploads };
    });
  },

  getUpload: (fileId) => get().uploads.get(fileId),
  registerController: (fileId, controller) => uploadControllers.set(fileId, controller),
  cancelUpload: (fileId) => uploadControllers.get(fileId)?.abort(),
}));
