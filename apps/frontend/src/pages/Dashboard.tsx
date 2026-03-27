import { useCallback, useRef, useState } from "react";
import { useParams } from "react-router";
import { UploadCloud } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gqlRequest } from "../lib/graphql.js";
import { uploadFile } from "../lib/upload.js";
import { downloadFile } from "../lib/download.js";
import { useUploadStore } from "../stores/upload.js";
import { FileTable } from "../components/files/FileTable.js";
import { UploadProgress } from "../components/files/UploadProgress.js";
import { FolderBreadcrumb } from "../components/files/FolderBreadcrumb.js";
import { VideoPlayer } from "../components/video/VideoPlayer.js";
import { ShareModal } from "../components/files/ShareModal.js";

const DELETE_FILE_MUTATION = `
  mutation DeleteFile($fileId: ID!) {
    deleteFile(fileId: $fileId)
  }
`;

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

export function Dashboard() {
  const { folderId } = useParams<{ folderId?: string }>();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploads = useUploadStore((s) => s.uploads);
  const [sharingFile, setSharingFile] = useState<{
    id: string;
    name: string;
    encryptedFEK: string;
    fekIv: string;
  } | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

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
        files: Array<{
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
        }>;
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

  const handleDownload = useCallback(
    async (file: {
      id: string;
      name: string;
      mimeType: string;
      chunkCount: number;
      encryptedFEK: string;
      fekIv: string;
    }) => {
      try {
        await downloadFile({
          fileId: file.id,
          fileName: file.name,
          mimeType: file.mimeType,
          chunkCount: file.chunkCount,
          encryptedFEK: file.encryptedFEK,
          fekIv: file.fekIv,
        });
      } catch (err) {
        console.error("Download failed:", err);
      }
    },
    [],
  );

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

  const handlePlay = useCallback(
    (file: {
      id: string;
      name: string;
      mimeType: string;
      size: string;
      chunkSize: number;
      chunkCount: number;
      encryptedFEK: string;
      fekIv: string;
    }) => {
      setPlayingFile(file);
    },
    [],
  );

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

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        handleUpload(e.dataTransfer.files);
      }
    },
    [handleUpload],
  );

  return (
    <div
      className="flex-1 p-6"
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between mb-6">
        <FolderBreadcrumb folderId={folderId ?? null} />
        <div className="flex gap-2">
          <input
            type="file"
            ref={fileInputRef}
            multiple
            className="hidden"
            onChange={(e) => e.target.files && handleUpload(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
          >
            Upload Files
          </button>
        </div>
      </div>

      <div
        className={`mb-4 border-2 border-dashed rounded-xl p-5 text-center text-sm transition-colors ${
          isDragging
            ? "border-blue-500 bg-blue-500/10 text-blue-400"
            : "border-zinc-700 text-zinc-500 hover:border-zinc-600"
        }`}
      >
        <UploadCloud size={18} className="mx-auto mb-1.5 opacity-60" />
        Drop files here to upload
      </div>

      {uploads.size > 0 && <UploadProgress />}

      {isLoading ? (
        <div className="text-zinc-500">Loading...</div>
      ) : (
        <FileTable
          files={data?.files ?? []}
          folders={data?.folders ?? []}
          onDownload={handleDownload}
          onPlay={handlePlay}
          onDelete={handleDelete}
          onShare={(file) => setSharingFile(file)}
        />
      )}

      {sharingFile && (
        <ShareModal
          file={sharingFile}
          onClose={() => setSharingFile(null)}
        />
      )}

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
    </div>
  );
}
