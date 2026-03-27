import { useState } from "react";
import { useNavigate } from "react-router";
import { Play, Download, Trash2, Share2, Folder, Search, ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

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
  onShare?: (file: FileItem) => void;
}

type SortKey = "name" | "size" | "date";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 20;

export function FileTable({ files, folders, onDownload, onPlay, onDelete, onShare }: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: "desc" });
  const [page, setPage] = useState(1);

  const handleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }
    );
    setPage(1);
  };

  const filtered = files.filter((f) =>
    f.name.toLowerCase().includes(query.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sort.key === "name") {
      cmp = a.name.localeCompare(b.name);
    } else if (sort.key === "size") {
      cmp = Number(a.size) - Number(b.size);
    } else {
      cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    }
    return sort.dir === "asc" ? cmp : -cmp;
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const isEmpty = folders.length === 0 && files.length === 0;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
        <input
          type="text"
          placeholder="Search files..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1); }}
          className="w-full pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
        />
      </div>

      <div className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-zinc-800">
              <SortHeader label="Name" sortKey="name" current={sort} onSort={handleSort} />
              <SortHeader label="Size" sortKey="size" current={sort} onSort={handleSort} />
              <SortHeader label="Date" sortKey="date" current={sort} onSort={handleSort} />
              <th className="w-32" />
            </tr>
          </thead>
          <tbody>
            {isEmpty && (
              <tr>
                <td colSpan={4} className="px-4 py-16 text-center text-zinc-500 text-sm">
                  <p className="text-base mb-1">No files yet</p>
                  <p>Drop files above or click Upload</p>
                </td>
              </tr>
            )}
            {folders.map((folder) => (
              <tr
                key={`folder-${folder.id}`}
                className="border-b border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer"
                onClick={() => navigate(`/folder/${folder.id}`)}
              >
                <td className="px-4 py-3 text-white">
                  <span className="inline-flex items-center gap-2">
                    <Folder size={16} className="text-zinc-400" />
                    {folder.name}
                  </span>
                </td>
                <td className="px-4 py-3 text-zinc-400 text-sm">{folder.fileCount} files</td>
                <td className="px-4 py-3 text-zinc-400 text-sm">—</td>
                <td />
              </tr>
            ))}
            {paginated.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-zinc-500 text-sm">
                  No files match your search
                </td>
              </tr>
            )}
            {paginated.map((file) => (
              <tr
                key={file.id}
                className="border-b border-zinc-800/50 hover:bg-zinc-800/30"
              >
                <td className="px-4 py-3 text-white">{file.name}</td>
                <td className="px-4 py-3 text-zinc-400 text-sm">{formatSize(file.size)}</td>
                <td className="px-4 py-3 text-zinc-400 text-sm">
                  {new Date(file.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1 justify-end">
                    {onPlay && file.status === "READY" && file.mimeType.startsWith("video/") && (
                      <IconButton
                        onClick={() => onPlay(file)}
                        title="Play"
                        className="text-green-400 hover:text-green-300 hover:bg-green-400/10"
                      >
                        <Play size={15} />
                      </IconButton>
                    )}
                    <IconButton
                      onClick={() => onDownload(file)}
                      title="Download"
                      className="text-blue-400 hover:text-blue-300 hover:bg-blue-400/10"
                    >
                      <Download size={15} />
                    </IconButton>
                    {onShare && file.status === "READY" && (
                      <IconButton
                        onClick={() => onShare(file)}
                        title="Share"
                        className="text-violet-400 hover:text-violet-300 hover:bg-violet-400/10"
                      >
                        <Share2 size={15} />
                      </IconButton>
                    )}
                    {onDelete && (
                      <IconButton
                        onClick={() => { if (confirm(`Delete "${file.name}"?`)) onDelete(file); }}
                        title="Delete"
                        className="text-red-400 hover:text-red-300 hover:bg-red-400/10"
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm text-zinc-400">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage === 1}
            className="p-1 rounded hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            Page <span className="text-white">{safePage}</span> / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage === totalPages}
            className="p-1 rounded hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  current,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  current: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
}) {
  const active = current.key === sortKey;
  return (
    <th
      className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase cursor-pointer select-none hover:text-zinc-300 transition-colors"
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          current.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />
        ) : (
          <span className="w-3" />
        )}
      </span>
    </th>
  );
}

function IconButton({
  children,
  onClick,
  title,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  className: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded-md transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

function formatSize(bytes: string): string {
  const size = Number(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
