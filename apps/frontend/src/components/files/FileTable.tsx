import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ITEM_DRAG_TYPE, encodeDragPayload, decodeDragPayload } from "../../lib/dragTypes.js";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Folder,
  FolderDown,
  GripVertical,
  MoreVertical,
  Pencil,
  Play,
  Search,
  Share2,
  Trash2,
} from "lucide-react";

export interface FileItem {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  chunkSize: number;
  chunkCount: number;
  wrappedFEK?: string;
  manifestBlobId?: string;
  status: string;
  createdAt: string;
}

export interface FolderItem {
  id: string;
  name: string;
  subfolderCount: number;
  fileCount: number;
  totalSizeBytes?: string;
  wrappedFolderKey?: string;
  encryptedBody?: string;
}

const DRAG_TYPE = ITEM_DRAG_TYPE;
const encodeDrag = encodeDragPayload;
const decodeDrag = decodeDragPayload;

interface Props {
  files: FileItem[];
  folders: FolderItem[];
  onDownload: (file: FileItem) => void;
  onPreview?: (file: FileItem) => void;
  onPlay?: (file: FileItem) => void;
  onDelete?: (file: FileItem) => void;
  onShare?: (file: FileItem) => void;
  onDownloadFolder?: (folder: FolderItem) => void;
  onRenameFolder?: (folder: FolderItem) => void;
  onDeleteFolder?: (folder: FolderItem) => void;
  onMoveFile?: (fileId: string, targetFolderId: string) => void;
  onMoveFolder?: (folderId: string, targetFolderId: string) => void;
}

type SortKey = "name" | "size" | "date";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 20;

export function FileTable({
  files, folders, onDownload, onPreview, onPlay, onDelete, onShare,
  onDownloadFolder, onRenameFolder, onDeleteFolder,
  onMoveFile, onMoveFolder,
}: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: "desc" });
  const [page, setPage] = useState(1);
  const [draggingOver, setDraggingOver] = useState<string | null>(null);
  // Counter per folder to handle nested enter/leave events
  const dragCounters = useRef<Record<string, number>>({});

  const handleSort = (key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
    setPage(1);
  };

  const filtered = useMemo(() => files.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())), [files, query]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sort.key === "name") cmp = a.name.localeCompare(b.name);
      else if (sort.key === "size") cmp = Number(a.size) - Number(b.size);
      else cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const isEmpty = folders.length === 0 && files.length === 0;
  const isFilteredEmpty = query.length > 0 && folders.length === 0 && paginated.length === 0;

  // Folder drag-over handlers — shared by both table rows and mobile cards
  const folderDragHandlers = (folderId: string, draggingId?: string) => ({
    onDragOver: (e: React.DragEvent) => {
      // Only accept internal item drags
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      dragCounters.current[folderId] = (dragCounters.current[folderId] ?? 0) + 1;
      if (draggingId !== folderId) setDraggingOver(folderId);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      dragCounters.current[folderId] = (dragCounters.current[folderId] ?? 1) - 1;
      if ((dragCounters.current[folderId] ?? 0) <= 0) {
        dragCounters.current[folderId] = 0;
        setDraggingOver((prev) => (prev === folderId ? null : prev));
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dragCounters.current[folderId] = 0;
      setDraggingOver(null);
      const payload = decodeDrag(e);
      if (!payload) return;
      if (payload.id === folderId) return; // can't drop onto itself
      if (payload.type === "file") onMoveFile?.(payload.id, folderId);
      else if (payload.type === "folder") onMoveFolder?.(payload.id, folderId);
    },
  });

  const isOver = (id: string) => draggingOver === id;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          type="text"
          placeholder="Search files..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1); }}
          className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-3 pl-10 pr-4 text-sm text-white placeholder-zinc-500 focus:border-zinc-600 focus:outline-none"
        />
      </div>

      {/* Mobile layout */}
      <div className="space-y-3 md:hidden">
        {isEmpty && <EmptyState />}
        {isFilteredEmpty && <FilteredEmptyState />}
        {folders.map((folder) => (
          <FolderCard
            key={`folder-${folder.id}`}
            folder={folder}
            isOver={isOver(folder.id)}
            dragHandlers={folderDragHandlers(folder.id)}
            onOpen={() => navigate(`/folder/${folder.id}`)}
            onDownload={onDownloadFolder ? () => onDownloadFolder(folder) : undefined}
            onRename={onRenameFolder ? () => onRenameFolder(folder) : undefined}
            onDelete={onDeleteFolder ? () => onDeleteFolder(folder) : undefined}
          />
        ))}
        {paginated.map((file) => (
          <FileCard
            key={file.id}
            file={file}
            onDownload={() => onDownload(file)}
            onPlay={onPlay && file.status === "READY" && file.mimeType.startsWith("video/") ? () => onPlay(file) : undefined}
            onShare={onShare && file.status === "READY" ? () => onShare(file) : undefined}
            onDelete={onDelete ? () => { if (confirm(`Delete "${file.name}"?`)) onDelete(file); } : undefined}
          />
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 md:block">
        <table className="w-full">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="w-8" />
              <SortHeader label="Name" sortKey="name" current={sort} onSort={handleSort} />
              <SortHeader label="Size" sortKey="size" current={sort} onSort={handleSort} />
              <SortHeader label="Date" sortKey="date" current={sort} onSort={handleSort} />
              <th className="w-32" />
            </tr>
          </thead>
          <tbody>
            {isEmpty && (
              <tr><td colSpan={5} className="px-4 py-16 text-center text-sm text-zinc-500"><EmptyCopy /></td></tr>
            )}

            {folders.map((folder) => (
              <tr
                key={`folder-${folder.id}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, encodeDrag({ type: "folder", id: folder.id }));
                  e.dataTransfer.effectAllowed = "move";
                }}
                className={`border-b transition-colors ${isOver(folder.id) ? "border-blue-500/50 bg-blue-500/10 ring-1 ring-inset ring-blue-500/40" : "border-zinc-800/50 hover:bg-zinc-800/30"}`}
                {...folderDragHandlers(folder.id, folder.id)}
              >
                <td className="px-2 py-3 text-zinc-600">
                  <GripVertical size={14} />
                </td>
                <td className="cursor-pointer px-4 py-3 text-white" onClick={() => navigate(`/folder/${folder.id}`)}>
                  <span className="inline-flex items-center gap-2">
                    <Folder size={16} className={isOver(folder.id) ? "text-blue-400" : "text-zinc-400"} />
                    {folder.name}
                    {isOver(folder.id) && <span className="ml-1 text-xs text-blue-400">Drop here</span>}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-zinc-400">
                  {folder.fileCount} items{folder.totalSizeBytes ? ` · ${formatSize(folder.totalSizeBytes)}` : ""}
                </td>
                <td className="px-4 py-3 text-sm text-zinc-400">—</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {onDownloadFolder && <IconButton onClick={() => onDownloadFolder(folder)} title="Download as ZIP" className="text-blue-400 hover:bg-blue-400/10 hover:text-blue-300"><FolderDown size={15} /></IconButton>}
                    {onRenameFolder && <IconButton onClick={() => onRenameFolder(folder)} title="Rename" className="text-zinc-400 hover:bg-zinc-700 hover:text-white"><Pencil size={15} /></IconButton>}
                    {onDeleteFolder && <IconButton onClick={() => onDeleteFolder(folder)} title="Delete" className="text-red-400 hover:bg-red-400/10 hover:text-red-300"><Trash2 size={15} /></IconButton>}
                  </div>
                </td>
              </tr>
            ))}

            {paginated.length === 0 && !isEmpty && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-zinc-500">No files match your search</td></tr>
            )}

            {paginated.map((file) => (
              <tr
                key={file.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, encodeDrag({ type: "file", id: file.id }));
                  e.dataTransfer.effectAllowed = "move";
                }}
                className="border-b border-zinc-800/50 hover:bg-zinc-800/30"
              >
                <td className="px-2 py-3 text-zinc-600 cursor-grab active:cursor-grabbing">
                  <GripVertical size={14} />
                </td>
                <td className="px-4 py-3 text-white">{file.name}</td>
                <td className="px-4 py-3 text-sm text-zinc-400">{formatSize(file.size)}</td>
                <td className="px-4 py-3 text-sm text-zinc-400">{formatDate(file.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {onPreview && file.mimeType.startsWith("image/") && <IconButton onClick={() => onPreview(file)} title="Preview" className="text-amber-400 hover:bg-amber-400/10 hover:text-amber-300">👁</IconButton>}
                    {onPlay && file.status === "READY" && file.mimeType.startsWith("video/") && <IconButton onClick={() => onPlay(file)} title="Play" className="text-green-400 hover:bg-green-400/10 hover:text-green-300"><Play size={15} /></IconButton>}
                    <IconButton onClick={() => onDownload(file)} title="Download" className="text-blue-400 hover:bg-blue-400/10 hover:text-blue-300"><Download size={15} /></IconButton>
                    {onShare && file.status === "READY" && <IconButton onClick={() => onShare(file)} title="Share" className="text-violet-400 hover:bg-violet-400/10 hover:text-violet-300"><Share2 size={15} /></IconButton>}
                    {onDelete && <IconButton onClick={() => { if (confirm(`Delete "${file.name}"?`)) onDelete(file); }} title="Delete" className="text-red-400 hover:bg-red-400/10 hover:text-red-300"><Trash2 size={15} /></IconButton>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm text-zinc-400">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage === 1} className="rounded-lg p-2 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30"><ChevronLeft size={18} /></button>
          <span>Page <span className="text-white">{safePage}</span> / {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage === totalPages} className="rounded-lg p-2 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30"><ChevronRight size={18} /></button>
        </div>
      )}
    </div>
  );
}

function EmptyState() { return <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900 px-4 py-10 text-center text-sm text-zinc-500"><EmptyCopy /></div>; }
function EmptyCopy() { return <><p className="mb-1 text-base text-zinc-300">No files yet</p><p>Drop files above or click Upload</p></>; }
function FilteredEmptyState() { return <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-8 text-center text-sm text-zinc-500">No files match your search</div>; }

function FolderCard({
  folder, isOver, dragHandlers, onOpen, onDownload, onRename, onDelete,
}: {
  folder: FolderItem;
  isOver: boolean;
  dragHandlers: React.HTMLAttributes<HTMLDivElement>;
  onOpen: () => void;
  onDownload?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={`w-full rounded-xl border p-4 transition-colors ${isOver ? "border-blue-500/60 bg-blue-500/10" : "border-zinc-800 bg-zinc-900 hover:border-zinc-700 hover:bg-zinc-800/60"}`}
      {...dragHandlers}
    >
      <div className="flex items-start gap-3">
        <button onClick={onOpen} className="rounded-lg bg-zinc-800 p-2 text-zinc-300">
          <Folder size={18} className={isOver ? "text-blue-400" : undefined} />
        </button>
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-medium text-white">{folder.name}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {isOver ? "Drop here to move" : [
              `${folder.fileCount} items`,
              folder.totalSizeBytes ? formatSize(folder.totalSizeBytes) : null,
            ].filter(Boolean).join(" · ")}
          </p>
        </button>
        <FolderActionMenu
          folderName={folder.name}
          onOpen={onOpen}
          onDownload={onDownload}
          onRename={onRename}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}

function FolderActionMenu({ folderName, onOpen, onDownload, onRename, onDelete }: { folderName: string; onOpen: () => void; onDownload?: () => void; onRename?: () => void; onDelete?: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  type Action = { label: string; icon: React.FC<{ size?: number }>; onClick: () => void; danger: boolean };
  const actions: Action[] = [
    { label: "Open", icon: Folder, onClick: onOpen, danger: false },
    ...(onDownload ? [{ label: "Download as ZIP", icon: FolderDown, onClick: onDownload, danger: false }] : []),
    ...(onRename ? [{ label: "Rename", icon: Pencil, onClick: onRename, danger: false }] : []),
    ...(onDelete ? [{ label: "Delete", icon: Trash2, onClick: onDelete, danger: true }] : []),
  ];
  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button onClick={() => setOpen((v) => !v)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300 transition-colors hover:border-zinc-700 hover:text-white" aria-label={`Actions for ${folderName}`}>
        <MoreVertical size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-20 min-w-44 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <button key={action.label} onClick={() => { setOpen(false); action.onClick(); }} className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors ${action.danger ? "text-red-300 hover:bg-red-500/10" : "text-zinc-200 hover:bg-zinc-800"}`}>
                <Icon size={16} />{action.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FileCard({ file, onDownload, onPlay, onShare, onDelete }: { file: FileItem; onDownload: () => void; onPlay?: () => void; onShare?: () => void; onDelete?: () => void }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-zinc-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-300">{getFileBadge(file.mimeType)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">{file.name}</p>
              <p className="mt-1 text-xs text-zinc-500">{formatSize(file.size)} · {formatDate(file.createdAt)}</p>
            </div>
            <FileActionMenu fileName={file.name} onDownload={onDownload} onPlay={onPlay} onShare={onShare} onDelete={onDelete} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500">
            <span className="rounded-full bg-zinc-800 px-2 py-1">{file.status}</span>
            <span className="rounded-full bg-zinc-800 px-2 py-1">{file.chunkCount} chunks</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function FileActionMenu({ fileName, onDownload, onPlay, onShare, onDelete }: { fileName: string; onDownload: () => void; onPlay?: () => void; onShare?: () => void; onDelete?: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  const actions = [
    onPlay ? { label: "Play", icon: Play, onClick: onPlay, danger: false } : null,
    { label: "Download", icon: Download, onClick: onDownload, danger: false },
    onShare ? { label: "Share", icon: Share2, onClick: onShare, danger: false } : null,
    onDelete ? { label: "Delete", icon: Trash2, onClick: onDelete, danger: true } : null,
  ].filter(Boolean) as Array<{ label: string; icon: typeof Play; onClick: () => void; danger: boolean }>;
  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button onClick={() => setOpen((v) => !v)} className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-300 transition-colors hover:border-zinc-700 hover:text-white" aria-label={`Open actions for ${fileName}`}>
        <MoreVertical size={18} />
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-20 min-w-44 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <button key={action.label} onClick={() => { setOpen(false); action.onClick(); }} className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors ${action.danger ? "text-red-300 hover:bg-red-500/10" : "text-zinc-200 hover:bg-zinc-800"}`}>
                <Icon size={16} />{action.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SortHeader({ label, sortKey, current, onSort }: { label: string; sortKey: SortKey; current: { key: SortKey; dir: SortDir }; onSort: (key: SortKey) => void }) {
  const active = current.key === sortKey;
  return (
    <th className="cursor-pointer select-none px-4 py-3 text-left text-xs font-medium uppercase text-zinc-500 transition-colors hover:text-zinc-300" onClick={() => onSort(sortKey)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? current.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} /> : <span className="w-3" />}
      </span>
    </th>
  );
}

function IconButton({ children, onClick, title, className }: { children: React.ReactNode; onClick: () => void; title: string; className?: string }) {
  return <button onClick={onClick} title={title} className={`rounded-lg p-2 transition-colors ${className ?? "text-zinc-400 hover:bg-zinc-800 hover:text-white"}`}>{children}</button>;
}

function formatSize(bytes: string): string {
  const size = Number(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(value: string): string { return new Date(value).toLocaleString(); }
function getFileBadge(mimeType: string): string {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}
