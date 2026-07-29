// DiscorDrive v4 — items the ⌘K palette can jump to.
// Populated by Dashboard with the *currently decrypted* folder/file names —
// never a full-drive index. Names are E2EE; nothing server-side can search
// them, so the palette only ever knows what the client has already decrypted
// for the visible folder.

import { create } from "zustand";

export interface PaletteItem {
  id: string;
  name: string;
  kind: "file" | "folder";
  folderId: string | null;
}

interface CommandPaletteState {
  items: PaletteItem[];
  setItems: (items: PaletteItem[]) => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  items: [],
  setItems: (items) => set({ items }),
}));
