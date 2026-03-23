// DiscorDrive v4 — Auth store (Zustand)
// Master Key is ONLY in memory. On page refresh → re-enter password.

import { create } from "zustand";

interface AuthState {
  token: string | null;
  user: {
    id: string;
    email: string;
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
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  masterKey: null,

  setAuth: (token, user, masterKey) => set({ token, user, masterKey }),
  logout: () => set({ token: null, user: null, masterKey: null }),
}));
