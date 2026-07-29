import { useState } from "react";
import { FolderPlus, X } from "lucide-react";
import { gqlRequest } from "../../lib/graphql.js";
import { useAuthStore } from "../../stores/auth.js";
import { generateFolderKey, encryptFolderBody, wrapKey, toBase64, packWrappedKey } from "../../lib/crypto.js";
import { authInputClass } from "../layout/AuthCard.js";

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
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-sm rounded-card border border-rule bg-paper p-6 shadow-[0_1px_2px_oklch(24%_0.02_258/0.08)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold text-ink">
            <FolderPlus size={18} className="text-muted" />
            New folder
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
            placeholder="Folder name"
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
              {loading ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
