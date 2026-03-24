import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gqlRequest } from "../../lib/graphql.js";
import { useAuthStore } from "../../stores/auth.js";
import { unwrapFEK, prepareShareLink } from "../../lib/crypto.js";

const SHARE_LINKS_QUERY = `
  query ShareLinks($fileId: ID!) {
    shareLinks(fileId: $fileId) {
      token fileId wrappedFEK wrapIv
      isPasswordProtected expiresAt label
      downloads maxDownloads createdAt
    }
  }
`;

const CREATE_SHARE_LINK = `
  mutation CreateShareLink(
    $fileId: ID!, $wrappedFEK: String!, $wrapIv: String!,
    $password: String, $label: String, $maxDownloads: Int
  ) {
    createShareLink(
      fileId: $fileId, wrappedFEK: $wrappedFEK, wrapIv: $wrapIv,
      password: $password, label: $label, maxDownloads: $maxDownloads
    ) { token }
  }
`;

const DELETE_SHARE_LINK = `
  mutation DeleteShareLink($token: String!) { deleteShareLink(token: $token) }
`;

interface FileInfo {
  id: string;
  name: string;
  encryptedFEK: string;
  fekIv: string;
}

interface ShareLink {
  token: string;
  isPasswordProtected: boolean;
  expiresAt: string | null;
  label: string | null;
  downloads: number;
  maxDownloads: number | null;
  createdAt: string;
}

interface Props {
  file: FileInfo;
  onClose: () => void;
}

export function ShareDialog({ file, onClose }: Props) {
  const queryClient = useQueryClient();
  const masterKey = useAuthStore((s) => s.masterKey);

  const [creating, setCreating] = useState(false);
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [maxDownloads, setMaxDownloads] = useState("");
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [newLink, setNewLink] = useState<{ token: string; shareKey: string } | null>(null);

  const { data } = useQuery({
    queryKey: ["shareLinks", file.id],
    queryFn: () =>
      gqlRequest<{ shareLinks: ShareLink[] }>(SHARE_LINKS_QUERY, { fileId: file.id }),
  });

  const handleCreate = useCallback(async () => {
    if (!masterKey) return;
    setCreating(true);
    try {
      const fek = await unwrapFEK(masterKey, file.encryptedFEK, file.fekIv);
      const share = await prepareShareLink(fek);

      const result = await gqlRequest<{ createShareLink: { token: string } }>(
        CREATE_SHARE_LINK,
        {
          fileId: file.id,
          wrappedFEK: share.wrappedFEK,
          wrapIv: share.wrapIv,
          password: password || undefined,
          label: label || undefined,
          maxDownloads: maxDownloads ? parseInt(maxDownloads, 10) : undefined,
        },
      );

      setNewLink({ token: result.createShareLink.token, shareKey: share.shareKey });
      setPassword("");
      setLabel("");
      setMaxDownloads("");
      queryClient.invalidateQueries({ queryKey: ["shareLinks", file.id] });
    } catch (err) {
      console.error("Create share link failed:", err);
    }
    setCreating(false);
  }, [masterKey, file, password, label, maxDownloads, queryClient]);

  const handleDelete = useCallback(
    async (token: string) => {
      try {
        await gqlRequest(DELETE_SHARE_LINK, { token });
        queryClient.invalidateQueries({ queryKey: ["shareLinks", file.id] });
      } catch (err) {
        console.error("Delete share link failed:", err);
      }
    },
    [file.id, queryClient],
  );

  function getShareUrl(token: string, shareKey?: string) {
    const base = `${window.location.origin}/share/${token}`;
    return shareKey ? `${base}#key=${shareKey}` : base;
  }

  async function copyLink(url: string, token: string) {
    await navigator.clipboard.writeText(url);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2000);
  }

  // Auto-copy new link
  useEffect(() => {
    if (newLink) {
      copyLink(getShareUrl(newLink.token, newLink.shareKey), newLink.token);
    }
  }, [newLink]);

  const links = data?.shareLinks ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h3 className="text-white font-medium">Share file</h3>
            <p className="text-zinc-500 text-sm truncate mt-0.5">{file.name}</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* New link form */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-zinc-300">Create new link</h4>
            <div className="grid grid-cols-2 gap-2">
              <input
                placeholder="Label (optional)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-zinc-600"
              />
              <input
                placeholder="Max downloads"
                type="number"
                min="1"
                value={maxDownloads}
                onChange={(e) => setMaxDownloads(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-zinc-600"
              />
            </div>
            <input
              placeholder="Password (optional)"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-zinc-600"
            />
            <button
              onClick={handleCreate}
              disabled={creating}
              className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium"
            >
              {creating ? "Creating..." : "Create Share Link"}
            </button>
          </div>

          {/* Newly created link */}
          {newLink && (
            <div className="bg-green-900/20 border border-green-800/50 rounded-lg p-3">
              <p className="text-green-400 text-xs mb-1">Link created and copied to clipboard!</p>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={getShareUrl(newLink.token, newLink.shareKey)}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none min-w-0"
                />
                <button
                  onClick={() => copyLink(getShareUrl(newLink.token, newLink.shareKey), newLink.token)}
                  className="text-green-400 hover:text-green-300 text-xs shrink-0"
                >
                  Copy
                </button>
              </div>
            </div>
          )}

          {/* Existing links */}
          {links.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-zinc-300">
                Existing links ({links.length})
              </h4>
              {links.map((link) => (
                <div
                  key={link.token}
                  className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-white">
                      {link.label || `Link ...${link.token.slice(-6)}`}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => copyLink(getShareUrl(link.token), link.token)}
                        className="text-blue-400 hover:text-blue-300 text-xs"
                      >
                        {copiedToken === link.token ? "Copied!" : "Copy"}
                      </button>
                      <button
                        onClick={() => handleDelete(link.token)}
                        className="text-red-400 hover:text-red-300 text-xs"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="flex gap-3 text-xs text-zinc-500">
                    <span>{link.downloads} download{link.downloads !== 1 ? "s" : ""}</span>
                    {link.maxDownloads && <span>max: {link.maxDownloads}</span>}
                    {link.isPasswordProtected && <span>password protected</span>}
                    <span>{new Date(link.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
