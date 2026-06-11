import { useState } from "react";
import { Pencil, X } from "lucide-react";
import { gqlRequest } from "../../lib/graphql.js";
import { useAuthStore } from "../../stores/auth.js";
import { unwrapFolderKey, encryptFolderBody } from "../../lib/crypto.js";
import type { FolderItem } from "./FileTable.js";

const RENAME_FOLDER = `
  mutation RenameFolder($folderId: ID!, $encryptedBodyB64: String!) {
    renameFolder(folderId: $folderId, encryptedBodyB64: $encryptedBodyB64)
  }
`;

interface Props {
  folder: FolderItem;
  onRenamed: () => void;
  onClose: () => void;
}

export function RenameFolderModal({ folder, onRenamed, onClose }: Props) {
  const filesKey = useAuthStore((s) => s.filesKey);
  const [name, setName] = useState(folder.name);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === folder.name) { onClose(); return; }
    if (!filesKey || !folder.wrappedFolderKey) { setError("Missing key material"); return; }
    setLoading(true);
    setError("");
    try {
      const folderKey = await unwrapFolderKey(folder.wrappedFolderKey, filesKey);
      const encryptedBodyB64 = await encryptFolderBody({ name: trimmed }, folderKey);
      await gqlRequest(RENAME_FOLDER, { folderId: folder.id, encryptedBodyB64 });
      onRenamed();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename folder");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold text-white">
            <Pencil size={16} className="text-zinc-400" />
            Rename folder
          </h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            autoFocus
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
              {loading ? "Saving…" : "Rename"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
