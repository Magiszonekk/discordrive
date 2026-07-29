// DiscorDrive v4 — light/dark/system colour-mode store.
// "system" means no explicit choice: defers to prefers-color-scheme (see
// tokens.css). Applying happens via a data-theme attribute on <html>, mirrored
// by an inline script in index.html so the correct theme paints on first frame.

import { create } from "zustand";

export type ColorMode = "light" | "dark" | "system";

const STORAGE_KEY = "ddv4:color-mode";

function applyMode(mode: ColorMode) {
  const root = document.documentElement;
  if (mode === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", mode);
  }
}

function loadStoredMode(): ColorMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

// Re-applies on module load — redundant with index.html's inline script on
// first paint, but keeps this store's state and the DOM in sync from here on.
const storedMode = loadStoredMode();
applyMode(storedMode);

interface ColorModeState {
  mode: ColorMode;
  setMode: (mode: ColorMode) => void;
}

export const useColorModeStore = create<ColorModeState>((set) => ({
  mode: storedMode,
  setMode: (mode: ColorMode) => {
    if (mode === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, mode);
    applyMode(mode);
    set({ mode });
  },
}));
