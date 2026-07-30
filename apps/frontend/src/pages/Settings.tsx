import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { gqlRequest } from "../lib/graphql.js";
import { useAuthStore } from "../stores/auth.js";
import { useThemeStore, THEME_PRESETS } from "../stores/theme.js";
import { useColorModeStore, type ColorMode } from "../stores/colorMode.js";
import { authInputClass, authLabelClass } from "../components/layout/AuthCard.js";
import { ApiKeysSection } from "../components/settings/ApiKeysSection.js";
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
  mutation ChangePassword($currentServerAuthProof: String!, $wrappedARKByPassword: String!, $argon2Params: Argon2ParamsInput!, $serverAuthProof: String!) {
    changePassword(currentServerAuthProof: $currentServerAuthProof, wrappedARKByPassword: $wrappedARKByPassword, argon2Params: $argon2Params, serverAuthProof: $serverAuthProof)
  }
`;

export function Settings() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const setUser = useAuthStore((s) => s.setUser);
  const accentName = useThemeStore((s) => s.accentName);
  const setAccentPreset = useThemeStore((s) => s.setAccentPreset);
  const colorMode = useColorModeStore((s) => s.mode);
  const setColorMode = useColorModeStore((s) => s.setMode);

  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);
  const currentPasswordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showPasswordForm) currentPasswordRef.current?.focus();
  }, [showPasswordForm]);

  function closePasswordForm() {
    setShowPasswordForm(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPwError("");
    setPwSuccess(false);
  }

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
      // Prove knowledge of the current password (derived with the *current* params)
      const { serverAuthProof: currentProof } = await deriveLoginMaterial(
        currentPassword,
        currentUser.crypto.argon2Params,
      );

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
        currentServerAuthProof: toBase64(currentProof),
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

      setCurrentPassword("");
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
      <h1 className="mb-8 font-display text-2xl font-semibold text-ink">Settings</h1>

      <div className="space-y-8">
        {/* Account */}
        <section>
          <h2 className="mb-3 text-lg font-semibold text-ink">Account</h2>
          <p className="mb-1 font-mono text-xs uppercase tracking-wide text-muted">Email</p>
          <p className="text-ink-2">{user?.email}</p>
        </section>

        {/* Change Password */}
        <section className="border-t border-rule pt-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="mb-1 text-lg font-semibold text-ink">Change Password</h2>
              <p className="text-sm text-muted">
                Sets a new password and re-encrypts your master key. You will need this password to unlock future
                sessions.
              </p>
            </div>
            {!showPasswordForm && (
              <button
                type="button"
                onClick={() => setShowPasswordForm(true)}
                className="h-11 shrink-0 rounded-md border border-rule-2 px-4 text-sm font-medium text-ink-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink"
              >
                Change password
              </button>
            )}
          </div>

          <div
            className="grid transition-[grid-template-rows] duration-long ease-in-out"
            style={{ gridTemplateRows: showPasswordForm ? "1fr" : "0fr" }}
          >
            <div className="overflow-hidden" inert={!showPasswordForm}>
              <form onSubmit={handleChangePassword} className="mt-4 space-y-4">
                <div>
                  <label className={authLabelClass}>Current password</label>
                  <input
                    ref={currentPasswordRef}
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    required={showPasswordForm}
                    autoComplete="current-password"
                    className={authInputClass}
                  />
                </div>
                <div>
                  <label className={authLabelClass}>New password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required={showPasswordForm}
                    autoComplete="new-password"
                    className={authInputClass}
                  />
                </div>
                <div>
                  <label className={authLabelClass}>Confirm new password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required={showPasswordForm}
                    autoComplete="new-password"
                    className={authInputClass}
                  />
                </div>
                {pwError && <p className="text-sm text-error">{pwError}</p>}
                {pwSuccess && <p className="text-sm text-success">Password changed successfully.</p>}
                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={pwLoading}
                    className="flex h-11 flex-1 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-ink transition-colors duration-short ease-out hover:bg-accent-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {pwLoading ? "Changing…" : "Change password"}
                  </button>
                  <button
                    type="button"
                    onClick={closePasswordForm}
                    className="h-11 shrink-0 rounded-md border border-rule-2 px-4 text-sm font-medium text-ink-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </section>

        <ApiKeysSection />

        {/* Storage */}
        <section className="border-t border-rule pt-8">
          <h2 className="mb-4 text-lg font-semibold text-ink">Storage Usage</h2>
          {data ? (
            <div className="space-y-1">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-2xl font-semibold tabular-nums text-ink">
                  {formatSize(data.storageUsage.totalBytes)}
                </span>
                <span className="text-sm text-muted">used</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-sm tabular-nums text-ink-2">
                  {data.storageUsage.fileCount.toLocaleString()}
                </span>
                <span className="text-sm text-muted">files</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">Loading…</p>
          )}
        </section>

        {/* Colour mode */}
        <section className="border-t border-rule pt-8">
          <h2 className="mb-1 text-lg font-semibold text-ink">Appearance</h2>
          <p className="mb-4 text-sm text-muted">Light, dark, or match your system.</p>
          <div className="flex gap-2">
            {(
              [
                { mode: "light" as ColorMode, label: "Light" },
                { mode: "dark" as ColorMode, label: "Dark" },
                { mode: "system" as ColorMode, label: "System" },
              ]
            ).map(({ mode, label }) => {
              const active = colorMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setColorMode(mode)}
                  className={`rounded-md border px-4 py-2 text-sm font-medium transition-colors duration-short ease-out ${
                    active
                      ? "border-accent bg-paper-2 text-ink"
                      : "border-rule-2 text-ink-2 hover:bg-paper-2 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </section>

        {/* Theme */}
        <section className="border-t border-rule pt-8">
          <h2 className="mb-1 text-lg font-semibold text-ink">Accent Colour</h2>
          <p className="mb-4 text-sm text-muted">
            Applied to progress bars, speed indicators and primary buttons.
          </p>

          {/* Presets */}
          <div className="flex flex-wrap gap-4">
            {THEME_PRESETS.map((preset) => {
              const isSelected = accentName === preset.name;
              return (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => setAccentPreset(preset.name)}
                  aria-pressed={isSelected}
                  aria-label={preset.name}
                  title={preset.name}
                  className="flex flex-col items-center gap-1.5"
                >
                  <span
                    className={`block h-9 w-9 rounded-full ring-offset-2 ring-offset-paper transition-shadow duration-short ease-out ${
                      isSelected ? "ring-2 ring-ink" : "ring-1 ring-rule-2 hover:ring-ink"
                    }`}
                    style={{ backgroundColor: preset.accent }}
                  />
                  <span
                    className={`font-mono text-[10px] uppercase tracking-wide ${
                      isSelected ? "text-ink" : "text-muted"
                    }`}
                  >
                    {preset.name}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Preview — a static swatch, not a live reading */}
          <div className="mt-5 flex items-center gap-3 border-t border-rule pt-5">
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-paper-3">
              <div className="h-full w-2/3 rounded-full bg-accent" />
            </div>
            <span className="font-mono text-xs font-medium uppercase tracking-wide text-muted">Preview</span>
          </div>
        </section>

        <div className="border-t border-rule pt-8">
          <button
            type="button"
            onClick={logout}
            className="h-11 w-full rounded-md border border-error px-4 text-sm font-medium text-error transition-colors duration-short ease-out hover:bg-error hover:text-error-ink md:w-auto"
          >
            Log out
          </button>
        </div>
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
