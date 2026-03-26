// DiscorDrive v4 — Auth store (Zustand)
// Session persisted to sessionStorage so HMR / page reload doesn't require re-login.

import { create } from "zustand";
import { exportKey, importKey, toBase64, fromBase64 } from "@ddv4/processing";

const SESSION_KEY = "ddv4_session";

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
  logout: () => {
    sessionStorage.removeItem(SESSION_KEY);
    set({ token: null, user: null, masterKey: null });
  },
}));

// Save to sessionStorage whenever auth state changes
useAuthStore.subscribe(async (state) => {
  if (state.token && state.user && state.masterKey) {
    const rawBytes = await exportKey(state.masterKey);
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        token: state.token,
        user: state.user,
        masterKeyRaw: toBase64(rawBytes),
      }),
    );
  }
});

// Called once on app boot — restores session from sessionStorage
export async function restoreSession(): Promise<boolean> {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return false;
  try {
    const { token, user, masterKeyRaw } = JSON.parse(raw);
    const rawBytes = fromBase64(masterKeyRaw);
    const masterKey = await importKey(
      rawBytes.buffer as ArrayBuffer,
      ["wrapKey", "unwrapKey"],
    );
    useAuthStore.getState().setAuth(token, user, masterKey);
    return true;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return false;
  }
}
