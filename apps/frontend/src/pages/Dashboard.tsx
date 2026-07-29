import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadStatus } from "@ddv4/types";
import { useParams } from "react-router";
import { FolderPlus, UploadCloud } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gqlRequest } from "../lib/graphql.js";
import { unwrapRootFek, decryptMeta, unwrapFolderKey, decryptFolderBody } from "../lib/crypto.js";
import { uploadFile } from "../lib/upload.js";
import { downloadFile, downloadFolderAsZip, DOWNLOAD_SUCCESS_EVENT } from "../lib/download.js";
import { createOwnerPreview, revokePreview, type PreviewResult } from "../lib/preview.js";
import { useUploadStore } from "../stores/upload.js";
import { useDownloadStore } from "../stores/download.js";
import { FileTable, type FolderItem } from "../components/files/FileTable.js";
import { UploadProgress } from "../components/files/UploadProgress.js";
import { DownloadProgress } from "../components/files/DownloadProgress.js";
import { FolderBreadcrumb } from "../components/files/FolderBreadcrumb.js";
import { VideoPlayer } from "../components/video/VideoPlayer.js";
import { ShareModal } from "../components/files/ShareModal.js";
import { NewFolderModal } from "../components/files/NewFolderModal.js";
import { RenameFolderModal } from "../components/files/RenameFolderModal.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useAuthStore } from "../stores/auth.js";
import { ImagePreview } from "../components/media/ImagePreview.js";

const DELETE_FILE_MUTATION = `
  mutation DeleteFile($fileId: ID!) {
    deleteFile(fileId: $fileId)
  }
`;

const DELETE_FOLDER_MUTATION = `
  mutation DeleteFolder($folderId: ID!) {
    deleteFolder(folderId: $folderId)
  }
`;

const MOVE_FILE_MUTATION = `
  mutation MoveFile($fileId: ID!, $parentFolderId: ID) {
    moveFile(fileId: $fileId, parentFolderId: $parentFolderId)
  }
`;

const MOVE_FOLDER_MUTATION = `
  mutation MoveFolder($folderId: ID!, $parentFolderId: ID) {
    moveFolder(folderId: $folderId, parentFolderId: $parentFolderId)
  }
`;

const FILES_QUERY = `
  query Files($parentFolderId: ID) {
    files(parentFolderId: $parentFolderId) {
      id
      encryptedName
      encryptedMimeType
      primaryManifestBlobId
      wrappedFEK
      status
      totalCiphertextBytes
      chunkCount
      createdAt
      updatedAt
    }
    folders(parentFolderId: $parentFolderId) {
      id
      encryptedBody
      wrappedFolderKey
      itemCount
      totalSizeBytes
      createdAt
      updatedAt
    }
  }
`;

export function Dashboard() {
  const { folderId } = useParams<{ folderId?: string }>();
  const queryClient = useQueryClient();
  const filesKey = useAuthStore((s) => s.filesKey);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploads = useUploadStore((s) => s.uploads);
  const addDownload = useDownloadStore((s) => s.addDownload);
  const updateDownload = useDownloadStore((s) => s.updateDownload);
  const pushNotification = useNotificationStore((s) => s.push);
  const [sharingFile, setSharingFile] = useState<{
    id: string;
    name: string;
    wrappedFEK?: string;
  } | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<FolderItem | null>(null);
  const [zipProgress, setZipProgress] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ fileName: string; bytes: number }>).detail;
      if (!detail) return;
      pushNotification("success", `Download started: ${detail.fileName} (${detail.bytes} B)`);
    };
    window.addEventListener(DOWNLOAD_SUCCESS_EVENT, handler as EventListener);
    return () => window.removeEventListener(DOWNLOAD_SUCCESS_EVENT, handler as EventListener);
  }, [pushNotification]);

  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const [playingFile, setPlayingFile] = useState<{
    id: string;
    name: string;
    mimeType: string;
    size: string;
    chunkSize: number;
    chunkCount: number;
    wrappedFEK: string;
    manifestBlobId: string;
  } | null>(null);
  const [imagePreview, setImagePreview] = useState<PreviewResult | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["files", folderId ?? null],
    queryFn: async () => {
      const result = await gqlRequest<{
        files: Array<{
          id: string;
          encryptedName: string | null;
          encryptedMimeType: string | null;
          primaryManifestBlobId: string | null;
          wrappedFEK: string;
          status: string;
          totalCiphertextBytes: string;
          chunkCount: number;
          createdAt: string;
          updatedAt: string;
        }>;
        folders: Array<{
          id: string;
          encryptedBody: string;
          wrappedFolderKey: string;
          itemCount: number;
          totalSizeBytes: string;
          createdAt: string;
          updatedAt: string;
        }>;
      }>(FILES_QUERY, { parentFolderId: folderId ?? null });

      const [files, folders] = await Promise.all([
        Promise.all(
          result.files.filter((f) => f.status === "READY").map(async (file) => {
            let name = file.id;
            let mimeType = "application/octet-stream";
            try {
              const fek = await unwrapRootFek(filesKey!, file.wrappedFEK);
              if (file.encryptedName) name = await decryptMeta(fek, file.encryptedName);
              if (file.encryptedMimeType) mimeType = await decryptMeta(fek, file.encryptedMimeType);
            } catch { /* show id as fallback if decrypt fails */ }
            return {
              id: file.id,
              name,
              mimeType,
              size: file.totalCiphertextBytes,
              chunkSize: file.chunkCount > 0 ? Math.ceil(Number(file.totalCiphertextBytes) / file.chunkCount) : 0,
              chunkCount: file.chunkCount,
              status: file.status,
              createdAt: file.createdAt,
              wrappedFEK: file.wrappedFEK,
              manifestBlobId: file.primaryManifestBlobId ?? "",
            };
          }),
        ),
        Promise.all(
          result.folders.map(async (folder) => {
            let name = folder.id;
            try {
              const folderKey = await unwrapFolderKey(folder.wrappedFolderKey, filesKey!);
              const body = await decryptFolderBody(folder.encryptedBody, folderKey);
              name = body.name;
            } catch { /* fallback */ }
            return {
              id: folder.id,
              name,
              fileCount: folder.itemCount,
              subfolderCount: 0,
              totalSizeBytes: folder.totalSizeBytes,
              wrappedFolderKey: folder.wrappedFolderKey,
              encryptedBody: folder.encryptedBody,
            };
          }),
        ),
      ]);

      return { files, folders };
    },
    enabled: Boolean(filesKey),
  });

  const uiFiles = data?.files ?? [];
  const uiFolders = data?.folders ?? [];

  useEffect(() => {
    return () => revokePreview(imagePreview);
  }, [imagePreview]);

  const handleUpload = useCallback(
    async (files: FileList) => {
      for (const file of files) {
        try {
          await uploadFile(file, folderId ?? null);
          queryClient.invalidateQueries({ queryKey: ["files"] });
        } catch (err) {
          console.error("Upload failed:", err);
        }
      }
    },
    [folderId, queryClient],
  );

  const handleDownload = useCallback(async (file: {
    id: string;
    name: string;
    mimeType: string;
    manifestBlobId?: string;
    wrappedFEK?: string;
    chunkCount?: number;
    size?: string;
  }) => {
    try {
      addDownload(
        file.id,
        file.name,
        file.mimeType,
        file.chunkCount ?? 0,
        Number(file.size ?? 0),
      );

      await downloadFile({
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        manifestBlobId: file.manifestBlobId ?? "",
        wrappedFEK: file.wrappedFEK ?? "",
      });

      updateDownload(file.id, {
        status: DownloadStatus.DONE,
        downloadedChunks: file.chunkCount ?? 0,
        bytesDownloaded: Number(file.size ?? 0),
      });
    } catch (err) {
      console.error("Download failed:", err);
      updateDownload(file.id, { status: DownloadStatus.FAILED });
      pushNotification("error", err instanceof Error ? err.message : "Download failed");
    }
  }, [addDownload, updateDownload, pushNotification]);


  const handlePreview = useCallback(async (file: {
    id: string;
    name: string;
    mimeType: string;
    manifestBlobId?: string;
    wrappedFEK?: string;
  }) => {
    try {
      const nextPreview = await createOwnerPreview({
        fileName: file.name,
        mimeType: file.mimeType,
        manifestBlobId: file.manifestBlobId ?? "",
        wrappedFEK: file.wrappedFEK ?? "",
      });
      setImagePreview((current) => {
        revokePreview(current);
        return nextPreview;
      });
    } catch (err) {
      console.error("Preview failed:", err);
      pushNotification("error", err instanceof Error ? err.message : "Preview failed");
    }
  }, [pushNotification]);

  const handleDelete = useCallback(
    async (file: { id: string }) => {
      try {
        await gqlRequest(DELETE_FILE_MUTATION, { fileId: file.id });
        queryClient.invalidateQueries({ queryKey: ["files"] });
      } catch (err) {
        console.error("Delete failed:", err);
      }
    },
    [queryClient],
  );

  const handleDownloadFolder = useCallback(async (folder: FolderItem) => {
    setZipProgress("Collecting files…");
    try {
      await downloadFolderAsZip(folder.id, folder.name, (msg) => setZipProgress(msg));
    } catch (err) {
      pushNotification("error", err instanceof Error ? err.message : "ZIP download failed");
    } finally {
      setZipProgress(null);
    }
  }, [pushNotification]);

  const handleDeleteFolder = useCallback(async (folder: FolderItem) => {
    if (!confirm(`Delete folder "${folder.name}" and all its contents? This cannot be undone.`)) return;
    try {
      await gqlRequest(DELETE_FOLDER_MUTATION, { folderId: folder.id });
      queryClient.invalidateQueries({ queryKey: ["files"] });
    } catch (err) {
      pushNotification("error", err instanceof Error ? err.message : "Failed to delete folder");
    }
  }, [queryClient, pushNotification]);

  const handleMoveFile = useCallback(async (fileId: string, targetFolderId: string) => {
    try {
      await gqlRequest(MOVE_FILE_MUTATION, { fileId, parentFolderId: targetFolderId });
      queryClient.invalidateQueries({ queryKey: ["files"] });
    } catch (err) {
      pushNotification("error", err instanceof Error ? err.message : "Failed to move file");
    }
  }, [queryClient, pushNotification]);

  const handleMoveFolder = useCallback(async (folderId: string, targetFolderId: string) => {
    try {
      await gqlRequest(MOVE_FOLDER_MUTATION, { folderId, parentFolderId: targetFolderId });
      queryClient.invalidateQueries({ queryKey: ["files"] });
      queryClient.invalidateQueries({ queryKey: ["folderPath"] });
    } catch (err) {
      pushNotification("error", err instanceof Error ? err.message : "Failed to move folder");
    }
  }, [queryClient, pushNotification]);

  const handlePlay = useCallback((file: {
    id: string;
    name: string;
    mimeType: string;
    size: string;
    chunkSize: number;
    chunkCount: number;
    wrappedFEK?: string;
    manifestBlobId?: string;
  }) => {
    setPlayingFile({
      ...file,
      wrappedFEK: file.wrappedFEK ?? "",
      manifestBlobId: file.manifestBlobId ?? "",
    });
  }, []);

  const isOsFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isOsFileDrag(e)) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isOsFileDrag(e)) return;
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    // Let folder-drop handlers inside FileTable handle internal item moves
    if (!isOsFileDrag(e)) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleUpload(e.dataTransfer.files);
    }
  }, [handleUpload]);

  return (
    <div
      className="flex-1 p-4 md:p-6"
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <FolderBreadcrumb
          folderId={folderId ?? null}
          onMoveFile={(fileId, targetFolderId) =>
            targetFolderId === null
              ? gqlRequest(MOVE_FILE_MUTATION, { fileId, parentFolderId: null }).then(() => queryClient.invalidateQueries({ queryKey: ["files"] }))
              : handleMoveFile(fileId, targetFolderId)
          }
          onMoveFolder={(movingFolderId, targetFolderId) =>
            targetFolderId === null
              ? gqlRequest(MOVE_FOLDER_MUTATION, { folderId: movingFolderId, parentFolderId: null }).then(() => { queryClient.invalidateQueries({ queryKey: ["files"] }); queryClient.invalidateQueries({ queryKey: ["folderPath"] }); })
              : handleMoveFolder(movingFolderId, targetFolderId)
          }
        />
        <div className="flex w-full gap-2 md:w-auto md:justify-end">
          <input
            type="file"
            ref={fileInputRef}
            multiple
            className="hidden"
            onChange={(e) => e.target.files && handleUpload(e.target.files)}
          />
          <button
            onClick={() => setShowNewFolder(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule-2 bg-paper px-3 py-3 text-sm font-medium text-ink-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink md:py-2"
          >
            <FolderPlus size={16} />
            <span className="hidden md:inline">New Folder</span>
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full rounded-md bg-accent px-4 py-3 text-sm font-medium text-accent-ink transition-colors duration-short ease-out hover:bg-accent-hover md:w-auto md:py-2"
          >
            Upload Files
          </button>
        </div>
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`mb-4 hidden cursor-pointer rounded-card border-2 border-dashed p-5 text-center text-sm transition-colors duration-short ease-out md:block ${
          isDragging ? "border-accent bg-accent/10 text-accent" : "border-rule text-muted hover:border-rule-2"
        }`}
      >
        <UploadCloud size={18} className="mx-auto mb-1.5 opacity-60" />
        Drop files here to upload
      </div>

      {uploads.size > 0 && <UploadProgress />}
      <DownloadProgress />

      {imagePreview && (
        <div className="mb-6 rounded-card border border-rule bg-paper p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">Image preview</p>
              <p className="text-xs text-muted">
                {imagePreview.fileName} · <span className="font-mono tabular-nums">{imagePreview.bytes} B</span>
              </p>
            </div>
            <button
              onClick={() => setImagePreview((current) => {
                revokePreview(current);
                return null;
              })}
              className="rounded-md border border-rule-2 bg-paper px-3 py-2 text-xs text-ink-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink"
            >
              Close preview
            </button>
          </div>
          <ImagePreview preview={imagePreview} />
        </div>
      )}

      {isLoading ? (
        <div className="text-muted">Loading…</div>
      ) : (
        <FileTable
          files={uiFiles}
          folders={uiFolders}
          onDownload={handleDownload}
          onPreview={handlePreview}
          onPlay={handlePlay}
          onDelete={handleDelete}
          onShare={(file) => setSharingFile({ id: file.id, name: file.name, wrappedFEK: file.wrappedFEK })}
          onDownloadFolder={handleDownloadFolder}
          onRenameFolder={(folder) => setRenamingFolder(folder)}
          onDeleteFolder={handleDeleteFolder}
          onMoveFile={handleMoveFile}
          onMoveFolder={handleMoveFolder}
        />
      )}

      {zipProgress && (
        <div className="fixed bottom-6 left-1/2 z-toast -translate-x-1/2 rounded-card border border-rule bg-paper px-5 py-3 text-sm text-ink-2 shadow-[0_1px_2px_oklch(24%_0.02_258/0.08)]">
          {zipProgress}
        </div>
      )}

      {showNewFolder && (
        <NewFolderModal
          parentFolderId={folderId ?? null}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ["files"] })}
          onClose={() => setShowNewFolder(false)}
        />
      )}

      {renamingFolder && (
        <RenameFolderModal
          folder={renamingFolder}
          onRenamed={() => queryClient.invalidateQueries({ queryKey: ["files"] })}
          onClose={() => setRenamingFolder(null)}
        />
      )}

      {sharingFile && <ShareModal file={sharingFile} onClose={() => setSharingFile(null)} />}

      {playingFile && (
        <VideoPlayer
          file={{
            fileId: playingFile.id,
            fileName: playingFile.name,
            mimeType: playingFile.mimeType,
            size: playingFile.size,
            chunkSize: playingFile.chunkSize,
            chunkCount: playingFile.chunkCount,
            wrappedFEK: playingFile.wrappedFEK,
            manifestBlobId: playingFile.manifestBlobId,
          }}
          onClose={() => setPlayingFile(null)}
        />
      )}
    </div>
  );
}
