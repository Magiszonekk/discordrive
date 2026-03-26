import { X } from "lucide-react";
import { useUploadStore } from "../../stores/upload.js";

function formatSpeed(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
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

        const isActive =
          upload.status !== "DONE" && upload.status !== "FAILED";

        return (
          <div
            key={upload.fileId}
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-3"
          >
            <div className="flex justify-between text-sm mb-1">
              <span className="text-white truncate mr-4">
                {upload.fileName}
              </span>
              <span className="text-zinc-400 shrink-0 flex items-center gap-2">
                {isActive && (
                  <button
                    onClick={() => cancelUpload(upload.fileId)}
                    title="Cancel"
                    className="text-zinc-500 hover:text-red-400 transition-colors"
                  >
                    <X size={14} />
                  </button>
                )}
                {isActive && upload.speedBps !== undefined && upload.speedBps > 0 && (
                  <span className="text-zinc-500">
                    {formatSpeed(upload.speedBps)}
                  </span>
                )}
                {upload.status === "DONE"
                  ? "Complete"
                  : upload.status === "FAILED"
                    ? "Failed"
                    : `${percent}%`}
              </span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-1.5">
              <div
                className={`h-1.5 rounded-full transition-all ${
                  upload.status === "FAILED"
                    ? "bg-red-500"
                    : upload.status === "DONE"
                      ? "bg-green-500"
                      : "bg-blue-500"
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              {upload.uploadedChunks}/{upload.totalChunks} chunks &middot;{" "}
              {upload.status}
            </div>
          </div>
        );
      })}
    </div>
  );
}
