import { useState } from "react";
import { FolderPlus, X } from "lucide-react";
import { gqlRequest } from "../../lib/graphql.js";
import { useAuthStore } from "../../stores/auth.js";
import { generateFolderKey, encryptFolderBody, wrapKey, toBase64, packWrappedKey } from "../../lib/crypto.js";

const CREATE_FOLDER = `
  mutation CreateFolder($encryptedBodyB64: String!, $wrappedFolderKeyB64: String!, $parentFolderId: ID) {
    createFolder(encryptedBodyB64: $encryptedBodyB64, wrappedFolderKeyB64: $wrappedFolderKeyB64, parentFolderId: $parentFolderId) {
      id
    }
  }
`;

interface Props {
  parentFolderId: string | null;
  onCreated: () => void;
  onClose: () => void;
}

export function NewFolderModal({ parentFolderId, onCreated, onClose }: Props) {
  const filesKey = useAuthStore((s) => s.filesKey);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!filesKey) { setError("Not authenticated"); return; }
    setLoading(true);
    setError("");
    try {
      const folderKey = await generateFolderKey();
      const encryptedBodyB64 = await encryptFolderBody({ name: trimmed }, folderKey);
      const wrapped = await wrapKey(folderKey, filesKey);
      const wrappedFolderKeyB64 = toBase64(packWrappedKey(wrapped.data, wrapped.iv));
      await gqlRequest(CREATE_FOLDER, { encryptedBodyB64, wrappedFolderKeyB64, parentFolderId });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold text-white">
            <FolderPlus size={18} className="text-zinc-400" />
            New folder
          </h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            autoFocus
            placeholder="Folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-blue-500 focus:outline-none"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-zinc-700 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
              Cancel
            </button>
            <button type="submit" disabled={loading || !name.trim()} className="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {loading ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
