import { useState } from "react";
import { Pencil, X } from "lucide-react";
import { gqlRequest } from "../../lib/graphql.js";
import { useAuthStore } from "../../stores/auth.js";
import { unwrapFolderKey, encryptFolderBody } from "../../lib/crypto.js";
import type { FolderItem } from "./FileTable.js";
import { authInputClass } from "../layout/AuthCard.js";

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
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-sm rounded-card border border-rule bg-paper p-6 shadow-[0_1px_2px_oklch(24%_0.02_258/0.08)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold text-ink">
            <Pencil size={16} className="text-muted" />
            Rename folder
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted transition-colors duration-micro ease-out hover:bg-paper-2 hover:text-ink"
          >
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
            className={authInputClass}
          />
          {error && <p className="text-xs text-error">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md border border-rule-2 py-2 text-sm text-ink-2 transition-colors duration-micro ease-out hover:bg-paper-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="flex-1 rounded-md bg-accent py-2 text-sm font-medium text-accent-ink transition-colors duration-short ease-out hover:bg-accent-hover active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Saving…" : "Rename"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
