import { useState } from "react";
import { useNavigate, Link } from "react-router";
import { gqlRequest } from "../lib/graphql.js";
import { registerCrypto } from "../lib/crypto.js";
import { useAuthStore } from "../stores/auth.js";
import type { LoginResponse } from "@ddv4/types/api";

const REGISTER_MUTATION = `
  mutation Register(
    $email: String!
    $username: String!
    $wrappedARKByPassword: String!
    $wrappedARKByRecovery: String!
    $argon2Params: Argon2ParamsInput!
    $serverAuthProof: String!
  ) {
    register(
      email: $email
      username: $username
      wrappedARKByPassword: $wrappedARKByPassword
      wrappedARKByRecovery: $wrappedARKByRecovery
      argon2Params: $argon2Params
      serverAuthProof: $serverAuthProof
    ) {
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

export function Register() {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);

    try {
      const crypto = await registerCrypto(password);

      const { register } = await gqlRequest<{ register: LoginResponse }>(REGISTER_MUTATION, {
        email,
        username,
        wrappedARKByPassword: crypto.wrappedARKByPassword,
        wrappedARKByRecovery: crypto.wrappedARKByRecovery,
        argon2Params: crypto.argon2Params,
        serverAuthProof: crypto.serverAuthProof,
      });

      setAuth(register.token, register.user, crypto.ark, crypto.filesKey);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 py-8">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5 md:p-8">
        <h1 className="mb-6 text-2xl font-bold text-white">Create Account</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-zinc-400">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-3 text-white focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-zinc-400">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
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
          <div>
            <label className="mb-1 block text-sm text-zinc-400">Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
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
            {loading ? "Creating account..." : "Create account"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-zinc-500">
          Already have an account?{" "}
          <Link to="/login" className="text-blue-400 hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
