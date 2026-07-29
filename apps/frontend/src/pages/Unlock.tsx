import { useState } from "react";
import { loginCryptoFromKey, deriveLoginMaterial, toBase64 } from "../lib/crypto.js";
import { gqlRequest } from "../lib/graphql.js";
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

export function Unlock() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const user = useAuthStore((s) => s.user);
  const setAuth = useAuthStore((s) => s.setAuth);
  const logout = useAuthStore((s) => s.logout);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
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
    } catch {
      setError("Wrong password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard title="DiscorDrive" subtitle="Enter your password to unlock the session.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={authLabelClass}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            className={authInputClass}
          />
        </div>
        {error && <p className="text-sm text-error">{error}</p>}
        <button type="submit" disabled={loading} className={authPrimaryButtonClass}>
          {loading ? "Unlocking…" : "Unlock"}
        </button>
      </form>
      <button
        onClick={logout}
        className="mt-4 w-full rounded-md py-2 text-sm text-muted transition-colors duration-short ease-out hover:text-ink-2"
      >
        Log out
      </button>
    </AuthCard>
  );
}
