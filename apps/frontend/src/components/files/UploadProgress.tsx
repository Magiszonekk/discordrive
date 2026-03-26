import { useUploadStore } from "../../stores/upload.js";
import { UploadStatus } from "@ddv4/types";

function formatSpeed(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${bps} B/s`;
}

export function UploadProgress() {
  const uploads = useUploadStore((s) => s.uploads);
  const cancelUpload = useUploadStore((s) => s.cancelUpload);

  if (uploads.size === 0) return null;

  return (
    <div className="mb-6 space-y-2">
      {Array.from(uploads.values()).map((upload) => {
        const percent =
          upload.bytesTotal > 0
            ? Math.round((upload.bytesUploaded / upload.bytesTotal) * 100)
            : 0;

        const isActive = upload.status === "UPLOADING";
        const isCancellable = upload.status === UploadStatus.UPLOADING ||
          upload.status === UploadStatus.PENDING ||
          upload.status === UploadStatus.HASHING;

        return (
          <div
            key={upload.fileId}
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-3"
          >
            <div className="flex justify-between text-sm mb-1">
              <span className="text-white truncate mr-4">
                {upload.fileName}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-zinc-400">
                  {upload.status === "DONE"
                    ? "Complete"
                    : upload.status === "FAILED"
                      ? "Failed"
                      : upload.status === "CANCELLED"
                        ? "Cancelled"
                        : `${percent}%`}
                </span>
                {isCancellable && (
                  <button
                    onClick={() => cancelUpload(upload.fileId)}
                    className="text-zinc-500 hover:text-zinc-200 transition-colors leading-none"
                    title="Cancel upload"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-1.5">
              <div
                className={`h-1.5 rounded-full transition-all ${
                  upload.status === "FAILED"
                    ? "bg-red-500"
                    : upload.status === "CANCELLED"
                      ? "bg-zinc-600"
                      : upload.status === "DONE"
                        ? "bg-green-500"
                        : "bg-blue-500"
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="text-xs text-zinc-500 mt-1 flex justify-between">
              <span>
                {upload.uploadedChunks}/{upload.totalChunks} chunks &middot;{" "}
                {upload.status}
              </span>
              {isActive && upload.speedBps != null && upload.speedBps > 0 && (
                <span className="text-zinc-400">{formatSpeed(upload.speedBps)}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
