// DiscorDrive v4 — Accent colour theme store

import { create } from "zustand";

export interface ThemePreset {
  name: string;
  color: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  { name: "Blue",   color: "#3b82f6" },
  { name: "Purple", color: "#8b5cf6" },
  { name: "Cyan",   color: "#06b6d4" },
  { name: "Green",  color: "#22c55e" },
  { name: "Orange", color: "#f97316" },
  { name: "Pink",   color: "#ec4899" },
  { name: "Rose",   color: "#f43f5e" },
];

const STORAGE_KEY = "ddv4:accent-color";
const DEFAULT_COLOR = "#3b82f6";

function applyColor(color: string) {
  document.documentElement.style.setProperty("--accent-color", color);
  // Slightly darkened variant for hover states
  document.documentElement.style.setProperty("--accent-color-dark", adjustBrightness(color, -20));
}

function adjustBrightness(hex: string, amount: number): string {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (num >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + amount));
  const b = Math.max(0, Math.min(255, (num & 0xff) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// Apply stored colour immediately on module load
const storedColor = localStorage.getItem(STORAGE_KEY) ?? DEFAULT_COLOR;
applyColor(storedColor);

interface ThemeState {
  accentColor: string;
  setAccentColor: (color: string) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  accentColor: storedColor,
  setAccentColor: (color: string) => {
    localStorage.setItem(STORAGE_KEY, color);
    applyColor(color);
    set({ accentColor: color });
  },
}));
