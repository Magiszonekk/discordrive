// DiscorDrive v4 — Files store (Zustand)

import { create } from "zustand";

interface FilesState {
  currentFolderId: string | null;
  setCurrentFolder: (folderId: string | null) => void;
}

export const useFilesStore = create<FilesState>((set) => ({
  currentFolderId: null,
  setCurrentFolder: (folderId) => set({ currentFolderId: folderId }),
}));
