import { useState } from "react";
import { useNavigate, Link } from "react-router";
import { gqlRequest } from "../lib/graphql.js";
import { loginCryptoFromKey, deriveLoginMaterial, toBase64 } from "../lib/crypto.js";
import { useAuthStore } from "../stores/auth.js";
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
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 py-8">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5 md:p-8">
        <h1 className="mb-6 text-2xl font-bold text-white">DiscorDrive</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-zinc-400">Email or username</label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoComplete="username"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-3 text-white focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-zinc-400">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-3 text-white focus:border-blue-500 focus:outline-none"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Logging in..." : "Log in"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-zinc-500">
          Don't have an account?{" "}
          <Link to="/register" className="text-blue-400 hover:underline">
            Register
          </Link>
        </p>
      </div>
    </div>
  );
}
