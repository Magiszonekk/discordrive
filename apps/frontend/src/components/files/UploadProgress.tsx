import { useUploadStore } from "../../stores/upload.js";

export function UploadProgress() {
  const uploads = useUploadStore((s) => s.uploads);

  if (uploads.size === 0) return null;

  return (
    <div className="mb-6 space-y-2">
      {Array.from(uploads.values()).map((upload) => {
        const percent =
          upload.bytesTotal > 0
            ? Math.round((upload.bytesUploaded / upload.bytesTotal) * 100)
            : 0;

        return (
          <div
            key={upload.fileId}
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-3"
          >
            <div className="flex justify-between text-sm mb-1">
              <span className="text-white truncate mr-4">
                {upload.fileName}
              </span>
              <span className="text-zinc-400 shrink-0">
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
