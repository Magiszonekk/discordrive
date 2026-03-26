import { useState } from "react";
import { loginCrypto } from "../lib/crypto.js";
import { useAuthStore } from "../stores/auth.js";

export function Unlock() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const user = useAuthStore((s) => s.user);
  const setMasterKey = useAuthStore((s) => s.setMasterKey);
  const logout = useAuthStore((s) => s.logout);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setError("");
    setLoading(true);

    try {
      const masterKey = await loginCrypto(
        password,
        user.kekSalt,
        user.wrapIv,
        user.encryptedMasterKey,
      );
      setMasterKey(masterKey);
    } catch {
      setError("Wrong password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <div className="w-full max-w-md p-8 bg-zinc-900 rounded-xl border border-zinc-800">
        <h1 className="text-2xl font-bold text-white mb-1">DiscorDrive</h1>
        <p className="text-zinc-400 text-sm mb-6">
          Enter your password to unlock the session.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium"
          >
            {loading ? "Unlocking..." : "Unlock"}
          </button>
        </form>
        <button
          onClick={logout}
          className="mt-4 w-full py-2 text-sm text-zinc-500 hover:text-zinc-300"
        >
          Log out
        </button>
      </div>
    </div>
  );
}
