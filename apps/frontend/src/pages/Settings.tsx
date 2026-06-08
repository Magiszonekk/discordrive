import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { gqlRequest } from "../lib/graphql.js";
import { useAuthStore } from "../stores/auth.js";
import { useThemeStore, THEME_PRESETS } from "../stores/theme.js";
import {
  deriveLoginMaterial,
  generateSalt,
  toBase64,
  packWrappedKey,
  wrapKey,
} from "../lib/crypto.js";

const STORAGE_QUERY = `
  query StorageUsage {
    storageUsage { totalBytes fileCount }
  }
`;

const CHANGE_PASSWORD_MUTATION = `
  mutation ChangePassword($wrappedARKByPassword: String!, $argon2Params: Argon2ParamsInput!, $serverAuthProof: String!) {
    changePassword(wrappedARKByPassword: $wrappedARKByPassword, argon2Params: $argon2Params, serverAuthProof: $serverAuthProof)
  }
`;

export function Settings() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const setUser = useAuthStore((s) => s.setUser);
  const accentColor = useThemeStore((s) => s.accentColor);
  const setAccentColor = useThemeStore((s) => s.setAccentColor);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);

  const { data } = useQuery({
    queryKey: ["storageUsage"],
    queryFn: () =>
      gqlRequest<{
        storageUsage: { totalBytes: string; fileCount: number };
      }>(STORAGE_QUERY),
  });

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");
    setPwSuccess(false);

    if (newPassword.length < 8) {
      setPwError("Password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError("Passwords do not match");
      return;
    }

    const ark = useAuthStore.getState().ark;
    const currentUser = useAuthStore.getState().user;
    if (!ark || !currentUser) {
      setPwError("Session not unlocked — please log in again");
      return;
    }

    setPwLoading(true);
    try {
      const salt = generateSalt();
      const params = {
        memoryKB: 19456,
        iterations: 2,
        parallelism: 1,
        saltB64: toBase64(salt),
      };

      // Single Argon2 run: get both the new ARK-wrapping key and server auth proof
      const { arkWrapKey, serverAuthProof } = await deriveLoginMaterial(newPassword, params);
      const wrappedArkData = await wrapKey(ark, arkWrapKey);
      const wrappedARKByPassword = toBase64(packWrappedKey(wrappedArkData.data, wrappedArkData.iv));

      await gqlRequest(CHANGE_PASSWORD_MUTATION, {
        wrappedARKByPassword,
        argon2Params: params,
        serverAuthProof: toBase64(serverAuthProof),
      });

      // Update stored user crypto so the next Unlock works with the new password
      setUser({
        ...currentUser,
        crypto: {
          ...currentUser.crypto,
          wrappedARKByPassword,
          argon2Params: params,
          lastPasswordChangeAt: new Date().toISOString(),
        },
      });

      setNewPassword("");
      setConfirmPassword("");
      setPwSuccess(true);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPwLoading(false);
    }
  };

  return (
    <div className="flex-1 max-w-2xl p-4 md:p-6">
      <h1 className="mb-6 text-2xl font-bold text-white">Settings</h1>

      <div className="space-y-6">
        {/* Account */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-white">Account</h2>
          <p className="text-zinc-400">{user?.email}</p>
        </div>

        {/* Change Password */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 md:p-6">
          <h2 className="mb-1 text-lg font-semibold text-white">Change Password</h2>
          <p className="mb-4 text-sm text-zinc-500">
            Sets a new password and re-encrypts your master key. You will need this password to unlock future sessions.
          </p>
          <form onSubmit={handleChangePassword} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm text-zinc-400">New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-zinc-400">Confirm new password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
              />
            </div>
            {pwError && <p className="text-sm text-red-400">{pwError}</p>}
            {pwSuccess && <p className="text-sm text-green-400">Password changed successfully.</p>}
            <button
              type="submit"
              disabled={pwLoading}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pwLoading ? "Changing…" : "Change password"}
            </button>
          </form>
        </div>

        {/* Storage */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-white">Storage Usage</h2>
          {data ? (
            <div className="text-zinc-400">
              <p>{formatSize(data.storageUsage.totalBytes)} used</p>
              <p>{data.storageUsage.fileCount} files</p>
            </div>
          ) : (
            <p className="text-zinc-500">Loading...</p>
          )}
        </div>

        {/* Theme */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 md:p-6">
          <h2 className="mb-1 text-lg font-semibold text-white">Accent Colour</h2>
          <p className="mb-4 text-sm text-zinc-500">Applied to progress bars, speed indicators and primary buttons.</p>

          {/* Presets */}
          <div className="mb-4 flex flex-wrap gap-2">
            {THEME_PRESETS.map((preset) => {
              const isSelected = accentColor.toLowerCase() === preset.color.toLowerCase();
              return (
                <button
                  key={preset.color}
                  onClick={() => setAccentColor(preset.color)}
                  title={preset.name}
                  className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors"
                  style={{
                    borderColor: isSelected ? preset.color : "transparent",
                    backgroundColor: isSelected ? `${preset.color}1a` : "#18181b",
                    color: isSelected ? preset.color : "#a1a1aa",
                  }}
                >
                  <span
                    className="inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: preset.color }}
                  />
                  {preset.name}
                </button>
              );
            })}
          </div>

          {/* Custom colour picker */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-zinc-400">Custom</label>
            <div className="relative flex items-center gap-2">
              <input
                type="color"
                value={accentColor}
                onChange={(e) => setAccentColor(e.target.value)}
                className="h-8 w-14 cursor-pointer rounded-md border border-zinc-700 bg-zinc-800 p-0.5"
              />
              <span className="font-mono text-sm text-zinc-400">{accentColor.toUpperCase()}</span>
            </div>
            {/* Preview */}
            <div className="ml-auto flex items-center gap-3">
              <div className="h-1.5 w-24 rounded-full bg-zinc-800 overflow-hidden">
                <div className="h-full w-2/3 rounded-full transition-all" style={{ backgroundColor: accentColor }} />
              </div>
              <span className="text-xs font-medium" style={{ color: accentColor }}>32.4 MB/s</span>
            </div>
          </div>
        </div>

        <button
          onClick={logout}
          className="w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700 md:w-auto md:py-2"
        >
          Log out
        </button>
      </div>
    </div>
  );
}

function formatSize(bytes: string): string {
  const size = Number(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
