// DiscorDrive v4 — Accent colour theme store
// Presets stay inside Cobalt's envelope (L 55-64%, C 0.14-0.20 OKLCH) so any
// user pick still reads "engineered," only the hue changes.

import { create } from "zustand";

export interface ThemePreset {
  name: string;
  accent: string;
  accentHover: string;
  accentInk: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { name: "Cobalt", accent: "oklch(58% 0.20 256)", accentHover: "oklch(52% 0.20 256)", accentInk: "oklch(99% 0.004 250)" },
  { name: "Violet", accent: "oklch(56% 0.19 300)", accentHover: "oklch(50% 0.19 300)", accentInk: "oklch(99% 0.004 250)" },
  { name: "Teal", accent: "oklch(55% 0.14 195)", accentHover: "oklch(49% 0.14 195)", accentInk: "oklch(99% 0.004 250)" },
  { name: "Emerald", accent: "oklch(58% 0.17 152)", accentHover: "oklch(52% 0.17 152)", accentInk: "oklch(99% 0.004 250)" },
  { name: "Amber", accent: "oklch(64% 0.16 75)", accentHover: "oklch(58% 0.16 75)", accentInk: "oklch(20% 0.03 70)" },
  { name: "Rose", accent: "oklch(56% 0.19 18)", accentHover: "oklch(50% 0.19 18)", accentInk: "oklch(99% 0.004 250)" },
];

const STORAGE_KEY = "ddv4:accent-theme";
const DEFAULT_PRESET = THEME_PRESETS[0]!;

function applyPreset(preset: ThemePreset) {
  const root = document.documentElement.style;
  root.setProperty("--color-accent", preset.accent);
  root.setProperty("--color-accent-hover", preset.accentHover);
  root.setProperty("--color-accent-ink", preset.accentInk);
  root.setProperty("--color-focus", preset.accent);
}

function loadStoredPreset(): ThemePreset {
  const storedName = localStorage.getItem(STORAGE_KEY);
  return THEME_PRESETS.find((p) => p.name === storedName) ?? DEFAULT_PRESET;
}

// Apply stored preset immediately on module load
const storedPreset = loadStoredPreset();
applyPreset(storedPreset);

interface ThemeState {
  accentName: string;
  setAccentPreset: (name: string) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  accentName: storedPreset.name,
  setAccentPreset: (name: string) => {
    const preset = THEME_PRESETS.find((p) => p.name === name) ?? DEFAULT_PRESET;
    localStorage.setItem(STORAGE_KEY, preset.name);
    applyPreset(preset);
    set({ accentName: preset.name });
  },
}));
