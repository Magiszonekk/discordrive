// DiscorDrive v4 — Auth store (Zustand)
// token + user are persisted to localStorage.
// ARK and domain keys remain memory-only.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Argon2ParamsDto } from "@ddv4/types/api";

interface PersistedUser {
  id: string;
  email: string;
  username: string | null;
  crypto: {
    wrappedARKByPassword: string;
    wrappedARKByRecovery: string;
    argon2Params: Argon2ParamsDto;
    lastPasswordChangeAt: string;
  };
}

interface AuthState {
  token: string | null;
  user: PersistedUser | null;
  ark: CryptoKey | null;
  filesKey: CryptoKey | null;

  setAuth: (token: string, user: PersistedUser, ark: CryptoKey, filesKey: CryptoKey) => void;
  setKeys: (ark: CryptoKey, filesKey: CryptoKey) => void;
  setUser: (user: PersistedUser) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      ark: null,
      filesKey: null,

      setAuth: (token, user, ark, filesKey) => set({ token, user, ark, filesKey }),
      setKeys: (ark, filesKey) => set({ ark, filesKey }),
      setUser: (user) => set({ user }),
      logout: () => set({ token: null, user: null, ark: null, filesKey: null }),
    }),
    {
      name: "ddv4-auth",
      partialize: (state) => ({ token: state.token, user: state.user }),
    },
  ),
);
