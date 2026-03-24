import { useState } from "react";
import { useNavigate } from "react-router";
import { ContextMenu } from "./ContextMenu.js";

interface FileItem {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  chunkSize: number;
  chunkCount: number;
  encryptedFEK: string;
  fekIv: string;
  status: string;
  createdAt: string;
}

interface FolderItem {
  id: string;
  name: string;
  subfolderCount: number;
  fileCount: number;
}

interface Props {
  files: FileItem[];
  folders: FolderItem[];
  onDownload: (file: FileItem) => void;
  onPlay?: (file: FileItem) => void;
  onDelete?: (file: FileItem) => void;
  onRename?: (file: FileItem, newName: string) => void;
  onShare?: (file: FileItem) => void;
  onDeleteFolder?: (folder: FolderItem) => void;
  onRenameFolder?: (folder: FolderItem, newName: string) => void;
}

export function FileTable({
  files,
  folders,
  onDownload,
  onPlay,
  onDelete,
  onRename,
  onShare,
  onDeleteFolder,
  onRenameFolder,
}: Props) {
  const navigate = useNavigate();
  const [menuState, setMenuState] = useState<{
    type: "file" | "folder";
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  if (folders.length === 0 && files.length === 0) {
    return (
      <div className="text-center py-16 text-zinc-500">
        <svg className="w-12 h-12 mx-auto mb-3 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <p className="text-lg mb-1">No files in this folder yet</p>
        <p className="text-sm">Upload a file to get started</p>
      </div>
    );
  }

  function startRename(id: string, currentName: string) {
    setRenamingId(id);
    setRenameValue(currentName);
  }

  function submitRename(type: "file" | "folder", item: FileItem | FolderItem) {
    const name = renameValue.trim();
    if (name && name !== item.name) {
      if (type === "file" && onRename) onRename(item as FileItem, name);
      if (type === "folder" && onRenameFolder) onRenameFolder(item as FolderItem, name);
    }
    setRenamingId(null);
  }

  function openMenu(e: React.MouseEvent, type: "file" | "folder", id: string) {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuState({ type, id, x: rect.right, y: rect.bottom });
  }

  const menuFile = menuState?.type === "file" ? files.find((f) => f.id === menuState.id) : null;
  const menuFolder = menuState?.type === "folder" ? folders.find((f) => f.id === menuState.id) : null;

  return (
    <div className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-zinc-800">
            <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">Name</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase w-28">Size</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase w-32">Date</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {folders.map((folder) => (
            <tr
              key={`folder-${folder.id}`}
              className="border-b border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer group"
              onClick={() => navigate(`/folder/${folder.id}`)}
            >
              <td className="px-4 py-3 text-white">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-zinc-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                  {renamingId === folder.id ? (
                    <form onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); submitRename("folder", folder); }} onClick={(e) => e.stopPropagation()}>
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => submitRename("folder", folder)}
                        onKeyDown={(e) => { if (e.key === "Escape") setRenamingId(null); }}
                        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-sm text-white outline-none focus:border-zinc-600"
                      />
                    </form>
                  ) : (
                    <span className="truncate">{folder.name}</span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-zinc-400 text-sm">{folder.fileCount} files</td>
              <td className="px-4 py-3 text-zinc-400 text-sm">&mdash;</td>
              <td className="px-4 py-3 text-right">
                <button
                  onClick={(e) => openMenu(e, "folder", folder.id)}
                  className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-white p-1"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="6" r="1.5" />
                    <circle cx="12" cy="12" r="1.5" />
                    <circle cx="12" cy="18" r="1.5" />
                  </svg>
                </button>
              </td>
            </tr>
          ))}
          {files.map((file) => (
            <tr
              key={file.id}
              className="border-b border-zinc-800/50 hover:bg-zinc-800/30 group"
            >
              <td className="px-4 py-3 text-white">
                {renamingId === file.id ? (
                  <form onSubmit={(e) => { e.preventDefault(); submitRename("file", file); }}>
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => submitRename("file", file)}
                      onKeyDown={(e) => { if (e.key === "Escape") setRenamingId(null); }}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-sm text-white outline-none focus:border-zinc-600"
                    />
                  </form>
                ) : (
                  <span className="truncate">{file.name}</span>
                )}
              </td>
              <td className="px-4 py-3 text-zinc-400 text-sm">{formatSize(file.size)}</td>
              <td className="px-4 py-3 text-zinc-400 text-sm">{new Date(file.createdAt).toLocaleDateString()}</td>
              <td className="px-4 py-3 text-right">
                <button
                  onClick={(e) => openMenu(e, "file", file.id)}
                  className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-white p-1"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="6" r="1.5" />
                    <circle cx="12" cy="12" r="1.5" />
                    <circle cx="12" cy="18" r="1.5" />
                  </svg>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* File context menu */}
      {menuFile && menuState && (
        <ContextMenu
          position={{ x: menuState.x, y: menuState.y }}
          onClose={() => setMenuState(null)}
          items={[
            { label: "Download", onClick: () => onDownload(menuFile) },
            ...(onPlay && menuFile.status === "READY" && menuFile.mimeType.startsWith("video/")
              ? [{ label: "Play", onClick: () => onPlay(menuFile) }]
              : []),
            ...(onShare ? [{ label: "Share", onClick: () => onShare(menuFile) }] : []),
            ...(onRename
              ? [{ label: "Rename", onClick: () => startRename(menuFile.id, menuFile.name) }]
              : []),
            ...(onDelete
              ? [{ label: "Delete", danger: true, onClick: () => onDelete(menuFile) }]
              : []),
          ]}
        />
      )}

      {/* Folder context menu */}
      {menuFolder && menuState && (
        <ContextMenu
          position={{ x: menuState.x, y: menuState.y }}
          onClose={() => setMenuState(null)}
          items={[
            ...(onRenameFolder
              ? [{ label: "Rename", onClick: () => startRename(menuFolder.id, menuFolder.name) }]
              : []),
            ...(onDeleteFolder
              ? [{ label: "Delete", danger: true, onClick: () => onDeleteFolder(menuFolder) }]
              : []),
          ]}
        />
      )}
    </div>
  );
}

function formatSize(bytes: string): string {
  const size = Number(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
