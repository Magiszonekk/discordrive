import { useState, useCallback } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gqlRequest } from "../../lib/graphql.js";
import { useAuthStore } from "../../stores/auth.js";
import { ContextMenu } from "../files/ContextMenu.js";
import { ConfirmDialog } from "../files/ConfirmDialog.js";

const SIDEBAR_QUERY = `
  query SidebarData {
    folders(parentId: null) {
      id name subfolderCount fileCount
    }
    storageUsage { totalBytes fileCount }
  }
`;

const CREATE_FOLDER = `
  mutation CreateFolder($name: String!) {
    createFolder(name: $name) { id name }
  }
`;

const RENAME_FOLDER = `
  mutation RenameFolder($folderId: ID!, $name: String!) {
    renameFolder(folderId: $folderId, name: $name)
  }
`;

const DELETE_FOLDER = `
  mutation DeleteFolder($folderId: ID!) {
    deleteFolder(folderId: $folderId)
  }
`;

function formatSize(bytes: string): string {
  const size = Number(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function MainLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [menuFolder, setMenuFolder] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingFolder, setDeletingFolder] = useState<{ id: string; name: string } | null>(null);

  const { data } = useQuery({
    queryKey: ["sidebar"],
    queryFn: () =>
      gqlRequest<{
        folders: Array<{ id: string; name: string; subfolderCount: number; fileCount: number }>;
        storageUsage: { totalBytes: string; fileCount: number };
      }>(SIDEBAR_QUERY),
  });

  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await gqlRequest(CREATE_FOLDER, { name });
      queryClient.invalidateQueries({ queryKey: ["sidebar"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
      setNewFolderName("");
      setCreatingFolder(false);
    } catch (err) {
      console.error("Create folder failed:", err);
    }
  }, [newFolderName, queryClient]);

  const handleRenameFolder = useCallback(async () => {
    if (!renamingFolder) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      await gqlRequest(RENAME_FOLDER, { folderId: renamingFolder.id, name });
      queryClient.invalidateQueries({ queryKey: ["sidebar"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
      setRenamingFolder(null);
    } catch (err) {
      console.error("Rename folder failed:", err);
    }
  }, [renamingFolder, renameValue, queryClient]);

  const handleDeleteFolder = useCallback(async () => {
    if (!deletingFolder) return;
    try {
      await gqlRequest(DELETE_FOLDER, { folderId: deletingFolder.id });
      queryClient.invalidateQueries({ queryKey: ["sidebar"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
      setDeletingFolder(null);
      if (location.pathname === `/folder/${deletingFolder.id}`) {
        navigate("/");
      }
    } catch (err) {
      console.error("Delete folder failed:", err);
      alert("Cannot delete folder. Make sure it is empty first.");
      setDeletingFolder(null);
    }
  }, [deletingFolder, queryClient, location.pathname, navigate]);

  const folders = data?.folders ?? [];
  const storage = data?.storageUsage;

  return (
    <div className="min-h-screen bg-zinc-950 flex">
      {/* Sidebar */}
      <aside className="w-56 bg-zinc-900 border-r border-zinc-800 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-white font-semibold">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            Discordrive
          </Link>
          <Link
            to="/settings"
            className="text-zinc-500 hover:text-white"
            title="Settings"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </Link>
        </div>

        {/* New Folder button */}
        <div className="p-3">
          {creatingFolder ? (
            <form
              onSubmit={(e) => { e.preventDefault(); handleCreateFolder(); }}
              className="flex gap-1"
            >
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onBlur={() => { if (!newFolderName.trim()) setCreatingFolder(false); }}
                placeholder="Folder name"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-white placeholder-zinc-500 outline-none focus:border-zinc-600 min-w-0"
              />
              <button type="submit" className="text-blue-400 hover:text-blue-300 text-sm px-1">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </button>
            </form>
          ) : (
            <button
              onClick={() => setCreatingFolder(true)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-zinc-400 hover:text-white hover:bg-zinc-800 border border-zinc-800 border-dashed"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              New Folder
            </button>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          <Link
            to="/"
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
              location.pathname === "/"
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:text-white hover:bg-zinc-800"
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
            </svg>
            All Files
          </Link>

          {folders.map((folder) => (
            <div key={folder.id} className="group relative">
              {renamingFolder?.id === folder.id ? (
                <form
                  onSubmit={(e) => { e.preventDefault(); handleRenameFolder(); }}
                  className="px-3 py-1"
                >
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => setRenamingFolder(null)}
                    onKeyDown={(e) => { if (e.key === "Escape") setRenamingFolder(null); }}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-white outline-none focus:border-zinc-600"
                  />
                </form>
              ) : (
                <Link
                  to={`/folder/${folder.id}`}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                    location.pathname === `/folder/${folder.id}`
                      ? "bg-zinc-800 text-white"
                      : "text-zinc-400 hover:text-white hover:bg-zinc-800"
                  }`}
                >
                  <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                  <span className="truncate flex-1">{folder.name}</span>
                  <span className="text-xs text-zinc-600">{folder.fileCount}</span>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setMenuFolder({ id: folder.id, name: folder.name, x: rect.right, y: rect.bottom });
                    }}
                    className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-white -mr-1"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <circle cx="12" cy="6" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="12" cy="18" r="1.5" />
                    </svg>
                  </button>
                </Link>
              )}
            </div>
          ))}
        </nav>

        {/* Storage usage */}
        {storage && (
          <div className="p-4 border-t border-zinc-800">
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
              </svg>
              <span>{formatSize(storage.totalBytes)} stored</span>
            </div>
            <div className="text-xs text-zinc-600 mt-0.5 ml-6">
              {storage.fileCount} file{storage.fileCount !== 1 ? "s" : ""}
            </div>
          </div>
        )}
      </aside>

      {/* Folder context menu */}
      {menuFolder && (
        <ContextMenu
          position={{ x: menuFolder.x, y: menuFolder.y }}
          onClose={() => setMenuFolder(null)}
          items={[
            {
              label: "Rename",
              onClick: () => {
                setRenameValue(menuFolder.name);
                setRenamingFolder({ id: menuFolder.id, name: menuFolder.name });
              },
            },
            {
              label: "Delete",
              danger: true,
              onClick: () => setDeletingFolder({ id: menuFolder.id, name: menuFolder.name }),
            },
          ]}
        />
      )}

      {/* Delete folder confirmation */}
      {deletingFolder && (
        <ConfirmDialog
          title="Delete folder"
          message={`Are you sure you want to delete "${deletingFolder.name}"? The folder must be empty.`}
          onConfirm={handleDeleteFolder}
          onCancel={() => setDeletingFolder(null)}
        />
      )}

      {/* Main content */}
      <main className="flex-1 flex flex-col">{children}</main>
    </div>
  );
}
