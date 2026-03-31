// DiscorDrive v4 — Auth store (Zustand)
// token + user are persisted to localStorage.
// masterKey is ONLY in memory — on refresh, the Unlock screen re-derives it.

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AuthState {
  token: string | null;
  user: {
    id: string;
    email: string;
    username: string | null;
    kekSalt: string;
    wrapIv: string;
    encryptedMasterKey: string;
  } | null;
  masterKey: CryptoKey | null;

  setAuth: (
    token: string,
    user: AuthState["user"],
    masterKey: CryptoKey,
  ) => void;
  setMasterKey: (masterKey: CryptoKey) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      masterKey: null,

      setAuth: (token, user, masterKey) => set({ token, user, masterKey }),
      setMasterKey: (masterKey) => set({ masterKey }),
      logout: () => set({ token: null, user: null, masterKey: null }),
    }),
    {
      name: "discordrive-auth",
      // Only persist token + user — CryptoKey cannot be serialized
      partialize: (state) => ({ token: state.token, user: state.user }),
    },
  ),
);
