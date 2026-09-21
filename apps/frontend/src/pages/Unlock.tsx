import { useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";
import { loginCryptoFromKey, deriveLoginMaterial, toBase64 } from "../lib/crypto.js";
import { gqlRequest } from "../lib/graphql.js";
import { getRateLimitWaitSeconds } from "../lib/rateLimit.js";
import { useAuthStore } from "../stores/auth.js";
import { BiometricError, getBiometricStatus, unlockWithBiometric } from "../lib/biometric.js";
import { AuthCard, authInputClass, authLabelClass, authPrimaryButtonClass } from "../components/layout/AuthCard.js";
import type { LoginResponse, LoginChallengeDto } from "@ddv4/types/api";

const GET_LOGIN_CHALLENGE = `
  query GetLoginChallenge($emailOrUsername: String!) {
    getLoginChallenge(emailOrUsername: $emailOrUsername) {
      argon2Params { memoryKB iterations parallelism saltB64 }
    }
  }
`;

const LOGIN_MUTATION = `
  mutation Login($emailOrUsername: String!, $serverAuthProof: String!) {
    login(emailOrUsername: $emailOrUsername, serverAuthProof: $serverAuthProof) {
      token
      user {
        id
        email
        username
        crypto {
          wrappedARKByPassword
          wrappedARKByRecovery
          argon2Params { memoryKB iterations parallelism saltB64 }
          lastPasswordChangeAt
        }
      }
    }
  }
`;

export function Unlock() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [rateLimitWait, setRateLimitWait] = useState(0);
  const [loading, setLoading] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioLabel, setBioLabel] = useState<string | null>(null);
  const [bioBusy, setBioBusy] = useState(false);
  const user = useAuthStore((s) => s.user);
  const setAuth = useAuthStore((s) => s.setAuth);
  const setKeys = useAuthStore((s) => s.setKeys);
  const logout = useAuthStore((s) => s.logout);

  const countdownActive = rateLimitWait > 0;

  useEffect(() => {
    if (rateLimitWait <= 0) return;
    const id = window.setTimeout(() => setRateLimitWait((w) => Math.max(0, w - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [rateLimitWait]);

  // Offer biometrics only when this device actually has an enrolled key for
  // this account — otherwise the password field stays the only thing on screen.
  useEffect(() => {
    let cancelled = false;
    void getBiometricStatus(user?.id ?? null).then((status) => {
      if (cancelled) return;
      setBioAvailable(status.enrolled);
      setBioLabel(status.label);
    });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const handleBiometric = async () => {
    if (!user) return;
    setError("");
    setBioBusy(true);
    try {
      // The JWT is still valid — only the ARK was lost on reload, so this
      // rehydrates the keys without touching the server or Argon2.
      const { ark, filesKey } = await unlockWithBiometric(user.id);
      setKeys(ark, filesKey);
    } catch (err) {
      if (err instanceof BiometricError && err.cancelled) setError("");
      else setError(err instanceof Error ? err.message : "Biometric unlock failed.");
    } finally {
      setBioBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || countdownActive) return;
    setError("");
    setLoading(true);

    try {
      const { getLoginChallenge } = await gqlRequest<{ getLoginChallenge: LoginChallengeDto | null }>(
        GET_LOGIN_CHALLENGE,
        { emailOrUsername: user.email },
      );
      if (!getLoginChallenge) throw new Error("Account not found");

      const { arkWrapKey, serverAuthProof } = await deriveLoginMaterial(password, getLoginChallenge.argon2Params);

      const { login } = await gqlRequest<{ login: LoginResponse }>(LOGIN_MUTATION, {
        emailOrUsername: user.email,
        serverAuthProof: toBase64(serverAuthProof),
      });

      const { ark, filesKey } = await loginCryptoFromKey(arkWrapKey, login.user.crypto.wrappedARKByPassword);

      setAuth(login.token, login.user, ark, filesKey ?? ark);
    } catch (err) {
      const wait = getRateLimitWaitSeconds(err);
      if (wait !== null) {
        setError(`Too many attempts. Wait ${wait}s before trying again.`);
        setRateLimitWait(wait);
      } else {
        setError("Wrong password");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard title="DiscorDrive" subtitle="This session is locked. Unlock it to continue.">
      <form onSubmit={handleSubmit} className="space-y-4">
        {user && (
          <div className="rounded-md border border-rule-2 bg-paper-2 px-3 py-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Signed in as</p>
            <p className="truncate font-display text-sm font-semibold text-ink">
              {user.username || "Unnamed user"}
            </p>
          </div>
        )}
        {bioAvailable && (
          <>
            <button
              type="button"
              onClick={handleBiometric}
              disabled={bioBusy || loading}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-md border border-rule-2 px-4 text-sm font-medium text-ink-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Fingerprint size={16} strokeWidth={1.75} />
              {bioBusy ? "Verifying…" : `Unlock with ${bioLabel ?? "biometrics"}`}
            </button>
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-rule" />
              <span className="font-mono text-[11px] uppercase tracking-wide text-muted">or password</span>
              <span className="h-px flex-1 bg-rule" />
            </div>
          </>
        )}
        <div>
          <label className={authLabelClass}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus={!bioAvailable}
            className={authInputClass}
          />
        </div>
        {error && <p className="text-sm text-error">{error}</p>}
        {countdownActive && (
          <p className="text-sm text-warning" role="status">
            Rate limited — try again in {rateLimitWait}s
          </p>
        )}
        <button type="submit" disabled={loading || countdownActive} className={authPrimaryButtonClass}>
          {countdownActive ? `Wait ${rateLimitWait}s…` : loading ? "Unlocking…" : "Unlock"}
        </button>
      </form>
      <button
        onClick={logout}
        className="mt-4 w-full rounded-md py-2 text-sm text-muted transition-colors duration-short ease-out hover:text-ink-2"
      >
        Not you? Log out
      </button>
    </AuthCard>
  );
}
