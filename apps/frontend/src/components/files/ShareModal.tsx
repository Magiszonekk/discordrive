import { useState } from "react";
import { X, Copy, Check } from "lucide-react";
import { gqlRequest } from "../../lib/graphql.js";
import { unwrapFEK, prepareShareLink } from "../../lib/crypto.js";
import { useAuthStore } from "../../stores/auth.js";

const CREATE_SHARE_LINK = `
  mutation CreateShareLink(
    $fileId: ID!
    $wrappedFEK: String!
    $wrapIv: String!
    $password: String
    $expiresAt: String
    $label: String
  ) {
    createShareLink(
      fileId: $fileId
      wrappedFEK: $wrappedFEK
      wrapIv: $wrapIv
      password: $password
      expiresAt: $expiresAt
      label: $label
    ) {
      token
    }
  }
`;

interface Props {
  file: {
    id: string;
    name: string;
    encryptedFEK: string;
    fekIv: string;
  };
  onClose: () => void;
}

export function ShareModal({ file, onClose }: Props) {
  const masterKey = useAuthStore((s) => s.masterKey);
  const [password, setPassword] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    if (!masterKey) return;
    setLoading(true);
    setError("");

    try {
      const fek = await unwrapFEK(masterKey, file.encryptedFEK, file.fekIv);
      const { shareKey, wrappedFEK, wrapIv } = await prepareShareLink(fek);

      const { createShareLink } = await gqlRequest<{
        createShareLink: { token: string };
      }>(CREATE_SHARE_LINK, {
        fileId: file.id,
        wrappedFEK,
        wrapIv,
        password: password || null,
        expiresAt: expiresAt || null,
      });

      const url = `${window.location.origin}/share/${createShareLink.token}#key=${shareKey}`;
      setShareUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create share link");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md bg-zinc-900 rounded-xl border border-zinc-800 p-6 mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-semibold">Share "{file.name}"</h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white p-1 rounded-md hover:bg-zinc-800"
          >
            <X size={18} />
          </button>
        </div>

        {!shareUrl ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">
                Password <span className="text-zinc-600">(optional)</span>
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave empty for no password"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm text-zinc-400 mb-1">
                Expires <span className="text-zinc-600">(optional)</span>
              </label>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
              />
            </div>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button
              onClick={handleCreate}
              disabled={loading}
              className="w-full py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg font-medium text-sm"
            >
              {loading ? "Creating..." : "Create share link"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">Link created — copy it before closing.</p>
            <div className="flex gap-2">
              <input
                readOnly
                value={shareUrl}
                className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-300 text-xs focus:outline-none"
              />
              <button
                onClick={handleCopy}
                title="Copy"
                className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-300 hover:text-white hover:bg-zinc-700"
              >
                {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
              </button>
            </div>
            <button
              onClick={onClose}
              className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
