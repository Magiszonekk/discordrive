import { useState } from "react";
import { useNavigate, Link } from "react-router";
import { gqlRequest } from "../lib/graphql.js";
import { registerCrypto } from "../lib/crypto.js";
import { useAuthStore } from "../stores/auth.js";
import { AuthCard, authInputClass, authLabelClass, authPrimaryButtonClass } from "../components/layout/AuthCard.js";
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
    <AuthCard
      title="Create account"
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-accent underline-offset-2 hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={authLabelClass}>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={authInputClass}
          />
        </div>
        <div>
          <label className={authLabelClass}>Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
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
        <div>
          <label className={authLabelClass}>Confirm password</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            className={authInputClass}
          />
        </div>
        {error && <p className="text-sm text-error">{error}</p>}
        <button type="submit" disabled={loading} className={authPrimaryButtonClass}>
          {loading ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthCard>
  );
}
