import { useEffect, useState } from "react";
import { Check, Copy, Link2, ShieldX, X } from "lucide-react";
import { gqlRequest } from "../../lib/graphql.js";
import { prepareShareLink, unwrapRootFek } from "../../lib/crypto.js";
import { useAuthStore } from "../../stores/auth.js";

const CREATE_SHARE = `
  mutation CreateShare(
    $fileId: ID!
    $capabilityToken: String!
    $wrappedAKShare: String!
    $wrappedFEK: String
    $allowContent: Boolean!
    $expiresAt: String
    $maxViews: Int
  ) {
    createShare(
      fileId: $fileId
      capabilityToken: $capabilityToken
      wrappedAKShare: $wrappedAKShare
      wrappedFEK: $wrappedFEK
      allowContent: $allowContent
      expiresAt: $expiresAt
      maxViews: $maxViews
    ) {
      shareId
    }
  }
`;

const SHARES_QUERY = `
  query Shares($fileId: ID!) {
    shares(fileId: $fileId) {
      shareId
      status
      expiresAt
      maxViews
      viewCount
      createdAt
    }
  }
`;

const REVOKE_SHARE = `
  mutation RevokeShare($shareId: ID!) {
    revokeShare(shareId: $shareId)
  }
`;

interface Props {
  file: {
    id: string;
    name?: string;
    wrappedFEK?: string;
  };
  onClose: () => void;
}

interface ShareItem {
  shareId: string;
  status: string;
  expiresAt?: string | null;
  maxViews?: number | null;
  viewCount: number;
  createdAt: string;
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function statusLabel(status: string, expiresAt?: string | null): string {
  if (status === "REVOKED") return "Revoked";
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return "Expired";
  return "Active";
}

export function ShareModal({ file, onClose }: Props) {
  const filesKey = useAuthStore((s) => s.filesKey);
  const [expiresAt, setExpiresAt] = useState("");
  const [maxViews, setMaxViews] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [loadingShares, setLoadingShares] = useState(true);
  const [revokingShareId, setRevokingShareId] = useState<string | null>(null);
  const loadShares = async () => {
    setLoadingShares(true);
    try {
      const result = await gqlRequest<{ shares: ShareItem[] }>(SHARES_QUERY, { fileId: file.id });
      setShares(result.shares ?? []);
    } catch (err) {
      console.error("Failed to load shares:", err);
    } finally {
      setLoadingShares(false);
    }
  };

  useEffect(() => {
    loadShares();
  }, [file.id]);

  const handleCreate = async () => {
    setLoading(true);
    setError("");

    try {
      if (!filesKey || !file.wrappedFEK) {
        throw new Error("Missing file key material for sharing");
      }

      const rootFek = await unwrapRootFek(filesKey, file.wrappedFEK);
      const prepared = await prepareShareLink(rootFek, file.id);
      const { createShare } = await gqlRequest<{ createShare: { shareId: string } }>(CREATE_SHARE, {
        fileId: file.id,
        capabilityToken: prepared.capabilityToken,
        wrappedAKShare: prepared.wrappedAKShare,
        wrappedFEK: prepared.wrappedFEK,
        allowContent: true,
        expiresAt: expiresAt || null,
        maxViews: maxViews ? Number(maxViews) : null,
      });

      const url = `${window.location.origin}/share/${createShare.shareId}#${prepared.linkSecret}`;
      setShareUrl(url);
      await loadShares();
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

  const handleRevoke = async (shareId: string) => {
    setRevokingShareId(shareId);
    try {
      await gqlRequest(REVOKE_SHARE, { shareId });
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke share link");
    } finally {
      setRevokingShareId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60 md:items-center md:justify-center">
      <div className="w-full rounded-t-2xl border border-zinc-800 bg-zinc-900 p-5 pb-6 shadow-2xl md:max-w-2xl md:rounded-xl md:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="truncate font-semibold text-white">Share "{file.name ?? file.id}"</h2>
          <button onClick={onClose} className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <div>
              <h3 className="mb-3 text-sm font-medium text-white">Create new share link</h3>
              <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                <div>
                  <label className="mb-1 block text-sm text-zinc-400">Expires <span className="text-zinc-600">(optional)</span></label>
                  <input
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-3 text-sm text-white focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm text-zinc-400">Max views <span className="text-zinc-600">(optional)</span></label>
                  <input
                    type="number"
                    min="1"
                    value={maxViews}
                    onChange={(e) => setMaxViews(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-3 text-sm text-white focus:border-blue-500 focus:outline-none"
                  />
                </div>
                {error &&<p className="text-sm text-red-400">{error}</p>}
                <button
                  onClick={handleCreate}
                  disabled={loading}
                  className="w-full rounded-lg bg-violet-600 py-3 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  {loading ? "Creating..." : "Create share link"}
                </button>
              </div>
            </div>

            {shareUrl && (
              <div className="space-y-3 rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-4">
                <p className="text-sm text-zinc-300">Link created — copy it before closing. Full URL cannot be reconstructed later because the secret lives in the <code>#fragment</code>.</p>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={shareUrl}
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-3 text-xs text-zinc-300 focus:outline-none"
                  />
                  <button
                    onClick={handleCopy}
                    title="Copy"
                    className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-3 text-zinc-300 hover:bg-zinc-700 hover:text-white"
                  >
                    {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div>
            <h3 className="mb-3 text-sm font-medium text-white">Existing share links</h3>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
              {loadingShares ? (
                <p className="text-sm text-zinc-500">Loading shares...</p>
              ) : shares.length === 0 ? (
                <p className="text-sm text-zinc-500">No share links yet.</p>
              ) : (
                <div className="max-h-[22rem] space-y-3 overflow-y-auto pr-0.5">
                  {[...shares]
                    .sort((a, b) => {
                      const aActive = statusLabel(a.status, a.expiresAt) === "Active";
                      const bActive = statusLabel(b.status, b.expiresAt) === "Active";
                      return aActive === bActive ? 0 : aActive ? -1 : 1;
                    })
                    .map((share) => {
                      const label = statusLabel(share.status, share.expiresAt);
                      const active = label === "Active";
                      return (
                        <div key={share.shareId} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                          <div className="mb-2 flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-sm text-white">
                                <Link2 size={14} className="text-zinc-400" />
                                <span className="truncate font-mono text-xs">{share.shareId}</span>
                              </div>
                              <div className="mt-1 text-xs text-zinc-500">
                                Created: {formatDate(share.createdAt)}
                              </div>
                            </div>
                            <span className={`rounded-full px-2 py-1 text-[11px] ${active ? "bg-emerald-500/10 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>
                              {label}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs text-zinc-500">
                            <div>Expires: <span className="text-zinc-300">{formatDate(share.expiresAt)}</span></div>
                            <div>Views: <span className="text-zinc-300">{share.viewCount}{share.maxViews ? ` / ${share.maxViews}` : ""}</span></div>
                          </div>
                          <div className="mt-3 flex justify-end">
                            <button
                              onClick={() => handleRevoke(share.shareId)}
                              disabled={!active || revokingShareId === share.shareId}
                              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <ShieldX size={14} />
                              {revokingShareId === share.shareId ? "Revoking..." : "Revoke"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
