import { useNavigate } from "react-router";
import { Play, Download, Trash2, Share2, Folder } from "lucide-react";

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

export function FileTable({ files, folders, onDownload, onPlay, onDelete, onShare }: Props) {
  const navigate = useNavigate();

  if (folders.length === 0 && files.length === 0) {
    return (
      <div className="text-center py-16 text-zinc-500">
        <p className="text-lg mb-2">No files yet</p>
        <p className="text-sm">Drop files here or click Upload</p>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-zinc-800">
            <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">
              Name
            </th>
            <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">
              Size
            </th>
            <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500 uppercase">
              Date
            </th>
            <th className="w-32" />
          </tr>
        </thead>
        <tbody>
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
              <td className="px-4 py-3 text-zinc-400 text-sm">
                {folder.fileCount} files
              </td>
              <td className="px-4 py-3 text-zinc-400 text-sm">—</td>
              <td />
            </tr>
          ))}
          {files.map((file) => (
            <tr
              key={file.id}
              className="border-b border-zinc-800/50 hover:bg-zinc-800/30"
            >
              <td className="px-4 py-3 text-white">{file.name}</td>
              <td className="px-4 py-3 text-zinc-400 text-sm">
                {formatSize(file.size)}
              </td>
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
                      onClick={() => {
                        if (confirm(`Delete "${file.name}"?`)) onDelete(file);
                      }}
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
  if (size < 1024 * 1024 * 1024)
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
