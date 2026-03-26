import { useCallback, useRef, useState } from "react";
import { useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gqlRequest } from "../lib/graphql.js";
import { uploadFile } from "../lib/upload.js";
import { downloadFile, downloadFolderAsZip } from "../lib/download.js";
import { useUploadStore } from "../stores/upload.js";
import { FileTable } from "../components/files/FileTable.js";
import { UploadProgress } from "../components/files/UploadProgress.js";
import { FolderBreadcrumb } from "../components/files/FolderBreadcrumb.js";
import { VideoPlayer } from "../components/video/VideoPlayer.js";
import { ConfirmDialog } from "../components/files/ConfirmDialog.js";
import { ShareDialog } from "../components/files/ShareDialog.js";

const FILES_QUERY = `
  query Files($folderId: ID) {
    files(folderId: $folderId) {
      id name mimeType size chunkSize chunkCount
      encryptedFEK fekIv sha256 status createdAt
    }
    folders(parentId: $folderId) {
      id name parentId createdAt subfolderCount fileCount
    }
  }
`;

const DELETE_FILE = `mutation DeleteFile($fileId: ID!) { deleteFile(fileId: $fileId) }`;
const RENAME_FILE = `mutation RenameFile($fileId: ID!, $name: String!) { renameFile(fileId: $fileId, name: $name) }`;
const DELETE_FOLDER = `mutation DeleteFolder($folderId: ID!) { deleteFolder(folderId: $folderId) }`;
const RENAME_FOLDER = `mutation RenameFolder($folderId: ID!, $name: String!) { renameFolder(folderId: $folderId, name: $name) }`;

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

export function Dashboard() {
  const { folderId } = useParams<{ folderId?: string }>();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploads = useUploadStore((s) => s.uploads);

  const [isDragging, setIsDragging] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [deletingFile, setDeletingFile] = useState<FileItem | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<{ id: string; name: string } | null>(null);
  const [sharingFile, setSharingFile] = useState<FileItem | null>(null);
  const [zipping, setZipping] = useState<{ done: number; total: number } | null>(null);
  const [playingFile, setPlayingFile] = useState<{
    id: string;
    name: string;
    mimeType: string;
    size: string;
    chunkSize: number;
    chunkCount: number;
    encryptedFEK: string;
    fekIv: string;
  } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["files", folderId ?? null],
    queryFn: () =>
      gqlRequest<{
        files: FileItem[];
        folders: Array<{
          id: string;
          name: string;
          parentId: string | null;
          createdAt: string;
          subfolderCount: number;
          fileCount: number;
        }>;
      }>(FILES_QUERY, { folderId: folderId ?? null }),
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["files"] });
    queryClient.invalidateQueries({ queryKey: ["sidebar"] });
    queryClient.invalidateQueries({ queryKey: ["storageUsage"] });
  }, [queryClient]);

  const handleUpload = useCallback(
    async (files: FileList) => {
      for (const file of files) {
        try {
          await uploadFile(file, folderId ?? null);
          invalidate();
        } catch (err) {
          console.error("Upload failed:", err);
        }
      }
    },
    [folderId, invalidate],
  );

  const handleDownload = useCallback(
    async (file: FileItem) => {
      try {
        await downloadFile({
          fileId: file.id,
          fileName: file.name,
          mimeType: file.mimeType,
          chunkCount: file.chunkCount,
          chunkSize: file.chunkSize,
          totalSize: Number(file.size),
          encryptedFEK: file.encryptedFEK,
          fekIv: file.fekIv,
        });
      } catch (err) {
        console.error("Download failed:", err);
      }
    },
    [],
  );

  const handleDeleteFile = useCallback(async () => {
    if (!deletingFile) return;
    try {
      await gqlRequest(DELETE_FILE, { fileId: deletingFile.id });
      invalidate();
    } catch (err) {
      console.error("Delete failed:", err);
    }
    setDeletingFile(null);
  }, [deletingFile, invalidate]);

  const handleRenameFile = useCallback(
    async (file: FileItem, newName: string) => {
      try {
        await gqlRequest(RENAME_FILE, { fileId: file.id, name: newName });
        invalidate();
      } catch (err) {
        console.error("Rename failed:", err);
      }
    },
    [invalidate],
  );

  const handleDeleteFolder = useCallback(async () => {
    if (!deletingFolder) return;
    try {
      await gqlRequest(DELETE_FOLDER, { folderId: deletingFolder.id });
      invalidate();
    } catch (err) {
      console.error("Delete folder failed:", err);
      alert("Cannot delete folder. Make sure it is empty first.");
    }
    setDeletingFolder(null);
  }, [deletingFolder, invalidate]);

  const handleRenameFolder = useCallback(
    async (folder: { id: string; name: string }, newName: string) => {
      try {
        await gqlRequest(RENAME_FOLDER, { folderId: folder.id, name: newName });
        invalidate();
      } catch (err) {
        console.error("Rename folder failed:", err);
      }
    },
    [invalidate],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        handleUpload(e.dataTransfer.files);
      }
    },
    [handleUpload],
  );

  const handleDownloadZip = useCallback(async () => {
    if (!folderId || !data?.files.length) return;
    // Try to get folder name from sidebar cache
    const sidebarData = queryClient.getQueryData<{ folders: Array<{ id: string; name: string }> }>(["sidebar"]);
    const folderName = sidebarData?.folders?.find((f) => f.id === folderId)?.name ?? "folder";
    setZipping({ done: 0, total: data.files.length });
    try {
      await downloadFolderAsZip(
        folderName,
        data.files.map((f) => ({
          fileId: f.id,
          fileName: f.name,
          mimeType: f.mimeType,
          chunkCount: f.chunkCount,
          encryptedFEK: f.encryptedFEK,
          fekIv: f.fekIv,
        })),
        (done, total) => setZipping({ done, total }),
      );
    } catch (err) {
      console.error("ZIP download failed:", err);
    }
    setZipping(null);
  }, [folderId, data, queryClient]);

  // Filter files by search query
  const filteredFiles = (data?.files ?? []).filter((f) =>
    searchQuery ? f.name.toLowerCase().includes(searchQuery.toLowerCase()) : true,
  );
  const filteredFolders = (data?.folders ?? []).filter((f) =>
    searchQuery ? f.name.toLowerCase().includes(searchQuery.toLowerCase()) : true,
  );

  return (
    <div
      className="flex-1 p-6 flex flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <FolderBreadcrumb folderId={folderId ?? null} />
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <svg className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-zinc-600 w-48"
            />
          </div>
          <input
            type="file"
            ref={fileInputRef}
            multiple
            className="hidden"
            onChange={(e) => e.target.files && handleUpload(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            Upload Files
          </button>
          {folderId && data?.files && data.files.length > 0 && (
            <button
              onClick={handleDownloadZip}
              disabled={!!zipping}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium flex items-center gap-2 border border-zinc-700"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              {zipping ? `Zipping ${zipping.done}/${zipping.total}...` : "Download ZIP"}
            </button>
          )}
        </div>
      </div>

      {/* Drop zone overlay */}
      {isDragging && (
        <div className="border-2 border-dashed border-blue-500/50 rounded-xl bg-blue-500/5 p-8 mb-4 text-center">
          <svg className="w-10 h-10 mx-auto mb-2 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          <p className="text-blue-400 text-sm">Drop files here to upload</p>
        </div>
      )}

      {/* Upload progress */}
      {uploads.size > 0 && <UploadProgress />}

      {/* File listing */}
      {isLoading ? (
        <div className="text-zinc-500">Loading...</div>
      ) : (
        <FileTable
          files={filteredFiles}
          folders={filteredFolders}
          onDownload={handleDownload}
          onPlay={setPlayingFile}
          onDelete={setDeletingFile}
          onRename={handleRenameFile}
          onShare={setSharingFile}
          onDeleteFolder={(f) => setDeletingFolder({ id: f.id, name: f.name })}
          onRenameFolder={handleRenameFolder}
        />
      )}

      {/* Video player */}
      {playingFile && (
        <VideoPlayer
          file={{
            fileId: playingFile.id,
            fileName: playingFile.name,
            mimeType: playingFile.mimeType,
            size: playingFile.size,
            chunkSize: playingFile.chunkSize,
            chunkCount: playingFile.chunkCount,
            encryptedFEK: playingFile.encryptedFEK,
            fekIv: playingFile.fekIv,
          }}
          onClose={() => setPlayingFile(null)}
        />
      )}

      {/* Delete file confirmation */}
      {deletingFile && (
        <ConfirmDialog
          title="Delete file"
          message={`Are you sure you want to delete "${deletingFile.name}"? This action cannot be undone.`}
          onConfirm={handleDeleteFile}
          onCancel={() => setDeletingFile(null)}
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

      {/* Share dialog */}
      {sharingFile && (
        <ShareDialog
          file={sharingFile}
          onClose={() => setSharingFile(null)}
        />
      )}
    </div>
  );
}
