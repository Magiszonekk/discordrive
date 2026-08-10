import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router";
import { gqlRequest } from "../lib/graphql.js";
import { loginCryptoFromKey, deriveLoginMaterial, toBase64 } from "../lib/crypto.js";
import { getRateLimitWaitSeconds } from "../lib/rateLimit.js";
import { useAuthStore } from "../stores/auth.js";
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

export function Login() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [rateLimitWait, setRateLimitWait] = useState(0);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  // Live countdown for rate-limit rejections; the button stays disabled while > 0.
  const countdownActive = rateLimitWait > 0;

  useEffect(() => {
    if (rateLimitWait <= 0) return;
    const id = window.setTimeout(() => setRateLimitWait((w) => Math.max(0, w - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [rateLimitWait]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (countdownActive) return;
    setError("");
    setLoading(true);

    try {
      const trimmedIdentifier = identifier.trim();
      const trimmedPassword = password.trim();

      // Step 1: fetch Argon2 params for this account (no secrets disclosed)
      const { getLoginChallenge } = await gqlRequest<{ getLoginChallenge: LoginChallengeDto | null }>(
        GET_LOGIN_CHALLENGE,
        { emailOrUsername: trimmedIdentifier },
      );
      if (!getLoginChallenge) throw new Error("Account not found");

      // Step 2: single Argon2 run — derives ARK-wrapping key AND server auth proof
      const { arkWrapKey, serverAuthProof } = await deriveLoginMaterial(
        trimmedPassword,
        getLoginChallenge.argon2Params,
      );

      // Step 3: prove knowledge of password to server
      const { login } = await gqlRequest<{ login: LoginResponse }>(LOGIN_MUTATION, {
        emailOrUsername: trimmedIdentifier,
        serverAuthProof: toBase64(serverAuthProof),
      });

      // Step 4: unwrap ARK with pre-computed key (no second Argon2)
      const { ark, filesKey } = await loginCryptoFromKey(
        arkWrapKey,
        login.user.crypto.wrappedARKByPassword,
      );

      setAuth(login.token, login.user, ark, filesKey ?? ark);
      navigate("/");
    } catch (err) {
      const wait = getRateLimitWaitSeconds(err);
      if (wait !== null) {
        setError(`Too many attempts. Wait ${wait}s before trying again.`);
        setRateLimitWait(wait);
      } else {
        setError(err instanceof Error ? err.message : "Login failed");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard
      title="DiscorDrive"
      footer={
        <>
          Don&rsquo;t have an account?{" "}
          <Link to="/register" className="font-medium text-accent underline-offset-2 hover:underline">
            Register
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={authLabelClass}>Email or username</label>
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            autoComplete="username"
            className={authInputClass}
          />
        </div>
        <div>
          <label className={authLabelClass}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
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
          {countdownActive ? `Wait ${rateLimitWait}s…` : loading ? "Logging in…" : "Log in"}
        </button>
      </form>
    </AuthCard>
  );
}
