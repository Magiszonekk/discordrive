import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadStatus } from "@ddv4/types";
import { useParams } from "react-router";
import { UploadCloud } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gqlRequest } from "../lib/graphql.js";
import { unwrapRootFek, decryptMeta } from "../lib/crypto.js";
import { uploadFile } from "../lib/upload.js";
import { downloadFile, DOWNLOAD_SUCCESS_EVENT } from "../lib/download.js";
import { createOwnerPreview, revokePreview, type PreviewResult } from "../lib/preview.js";
import { useUploadStore } from "../stores/upload.js";
import { useDownloadStore } from "../stores/download.js";
import { useThemeStore } from "../stores/theme.js";
import { FileTable } from "../components/files/FileTable.js";
import { UploadProgress } from "../components/files/UploadProgress.js";
import { DownloadProgress } from "../components/files/DownloadProgress.js";
import { FolderBreadcrumb } from "../components/files/FolderBreadcrumb.js";
import { VideoPlayer } from "../components/video/VideoPlayer.js";
import { ShareModal } from "../components/files/ShareModal.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useAuthStore } from "../stores/auth.js";
import { ImagePreview } from "../components/media/ImagePreview.js";

const DELETE_FILE_MUTATION = `
  mutation DeleteFile($fileId: ID!) {
    deleteFile(fileId: $fileId)
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
      itemCount
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
  const accentColor = useThemeStore((s) => s.accentColor);
  const addDownload = useDownloadStore((s) => s.addDownload);
  const updateDownload = useDownloadStore((s) => s.updateDownload);
  const pushNotification = useNotificationStore((s) => s.push);
  const [sharingFile, setSharingFile] = useState<{
    id: string;
    name: string;
    wrappedFEK?: string;
  } | null>(null);

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
          itemCount: number;
          createdAt: string;
          updatedAt: string;
        }>;
      }>(FILES_QUERY, { parentFolderId: folderId ?? null });

      const files = await Promise.all(
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
      );

      return { files, folders: result.folders };
    },
    enabled: Boolean(filesKey),
  });

  const uiFiles = data?.files ?? [];

  const uiFolders = (data?.folders ?? []).map((folder) => ({
    id: folder.id,
    name: folder.id,
    parentId: null,
    createdAt: folder.createdAt,
    subfolderCount: 0,
    fileCount: folder.itemCount,
  }));

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

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
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
        <FolderBreadcrumb folderId={folderId ?? null} />
        <div className="flex w-full gap-2 md:w-auto md:justify-end">
          <input
            type="file"
            ref={fileInputRef}
            multiple
            className="hidden"
            onChange={(e) => e.target.files && handleUpload(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full rounded-lg px-4 py-3 text-sm font-medium text-white md:w-auto md:py-2 transition-opacity hover:opacity-90"
            style={{ backgroundColor: accentColor }}
          >
            Upload Files
          </button>
        </div>
      </div>

      <div
        className={`mb-4 hidden rounded-xl border-2 border-dashed p-5 text-center text-sm transition-colors md:block ${
          isDragging ? "border-blue-500 bg-blue-500/10 text-blue-400" : "border-zinc-700 text-zinc-500 hover:border-zinc-600"
        }`}
      >
        <UploadCloud size={18} className="mx-auto mb-1.5 opacity-60" />
        Drop files here to upload
      </div>

      {uploads.size > 0 && <UploadProgress />}
      <DownloadProgress />

      {imagePreview && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-white">Image preview</p>
              <p className="text-xs text-zinc-500">{imagePreview.fileName} · {imagePreview.bytes} B</p>
            </div>
            <button
              onClick={() => setImagePreview((current) => {
                revokePreview(current);
                return null;
              })}
              className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              Close preview
            </button>
          </div>
          <ImagePreview preview={imagePreview} />
        </div>
      )}

      {isLoading ? (
        <div className="text-zinc-500">Loading...</div>
      ) : (
        <FileTable
          files={uiFiles}
          folders={uiFolders}
          onDownload={handleDownload}
          onPreview={handlePreview}
          onPlay={handlePlay}
          onDelete={handleDelete}
          onShare={(file) => setSharingFile({ id: file.id, name: file.name, wrappedFEK: file.wrappedFEK })}
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
