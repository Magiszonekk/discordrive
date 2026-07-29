import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useUploadStore } from "../../stores/upload.js";

const ETA_TICK_MS = 300;

function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 5) return "< 5 s";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return secs > 0 ? `${mins} min ${secs} s` : `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours} h ${remainMins} min` : `${hours} h`;
}

export function UploadProgress() {
  const uploads = useUploadStore((s) => s.uploads);
  const cancelUpload = useUploadStore((s) => s.cancelUpload);
  const removeUpload = useUploadStore((s) => s.removeUpload);
  const [collapsed, setCollapsed] = useState(true);
  const [etas, setEtas] = useState<Record<string, number>>({});
  const scheduledRef = useRef(new Set<string>());

  useEffect(() => {
    if (uploads.size > 0) setCollapsed(false);
  }, [uploads.size, setCollapsed]);

  useEffect(() => {
    const id = setInterval(() => {
      // Derived fresh from the store's windowed speed, never smoothed on its own:
      // ETA is a reciprocal of what we measure, so averaging it lets a stale
      // slow-start estimate outlive the slow start and tick down by minutes per
      // second once the transfer reaches full speed.
      const next: Record<string, number> = {};
      for (const upload of uploads.values()) {
        const spd = upload.speedBps ?? 0;
        const remaining = upload.bytesTotal - upload.bytesUploaded;
        const isActive = upload.status !== "DONE" && upload.status !== "FAILED";
        if (isActive && spd > 0 && remaining > 0) {
          next[upload.fileId] = remaining / spd;
        }
      }
      setEtas(next);
    }, ETA_TICK_MS);
    return () => clearInterval(id);
  }, [uploads]);

  useEffect(() => {
    for (const upload of uploads.values()) {
      if ((upload.status === "DONE" || upload.status === "FAILED") && !scheduledRef.current.has(upload.fileId)) {
        scheduledRef.current.add(upload.fileId);
        setTimeout(() => {
          removeUpload(upload.fileId);
          scheduledRef.current.delete(upload.fileId);
        }, 3000);
      }
    }
  }, [uploads, removeUpload]);

  if (uploads.size === 0) return null;

  return (
    <div className="mb-6 overflow-hidden rounded-card border border-rule bg-paper">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors duration-micro ease-out hover:bg-paper-2"
      >
        <div>
          <p className="text-sm font-medium text-ink">Uploads</p>
          <p className="text-xs text-muted">{uploads.size} active or recent</p>
        </div>
        <span className="text-muted">{collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}</span>
      </button>

      {!collapsed && (
        <div className="space-y-2 border-t border-rule px-3 py-3">
          {Array.from(uploads.values()).map((upload) => {
            const percent = upload.bytesTotal > 0 ? Math.round((upload.bytesUploaded / upload.bytesTotal) * 100) : 0;
            const isActive = upload.status !== "DONE" && upload.status !== "FAILED";
            const speedBps = upload.speedBps ?? 0;
            const speedStr = isActive ? formatSpeed(speedBps) : "";
            const etaStr = isActive ? formatEta(etas[upload.fileId] ?? 0) : "";

            return (
              <div key={upload.fileId} className="rounded-md bg-paper-2 p-3">
                {/* Row 1: filename + cancel + percent */}
                <div className="mb-2 flex justify-between gap-3 text-sm">
                  <span className="truncate text-ink">{upload.fileName ?? upload.fileId}</span>
                  <span className="flex shrink-0 items-center gap-1 text-muted">
                    {isActive && (
                      <button
                        onClick={() => cancelUpload(upload.fileId)}
                        title="Cancel"
                        className="rounded-md p-1.5 text-muted transition-colors duration-micro ease-out hover:bg-paper-3 hover:text-error"
                      >
                        <X size={13} />
                      </button>
                    )}
                    {upload.status === "DONE" ? (
                      "Complete"
                    ) : upload.status === "FAILED" ? (
                      "Failed"
                    ) : (
                      <span className="font-mono tabular-nums">{percent}%</span>
                    )}
                  </span>
                </div>
                {/* Progress bar */}
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-paper-3">
                  <div
                    className={`h-1.5 w-full origin-left rounded-full transition-transform duration-short ease-out ${
                      upload.status === "FAILED" ? "bg-error" : upload.status === "DONE" ? "bg-success" : "bg-accent"
                    }`}
                    style={{ transform: `scaleX(${percent / 100})` }}
                  />
                </div>
                {/* Row 3: blobs counter + speed + ETA */}
                <div className="mt-2 flex items-center justify-between text-xs text-muted">
                  <span>
                    <span className="font-mono tabular-nums">
                      {upload.uploadedBlobs}/{upload.totalBlobs}
                    </span>{" "}
                    blobs
                    {upload.status === "DONE" && <span className="ml-2 text-success">✓</span>}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {speedStr && isActive ? (
                      <>
                        <span className="font-mono font-medium tabular-nums text-accent">{speedStr}</span>
                        {etaStr && (
                          <>
                            <span className="text-muted">·</span>
                            <span className="font-mono tabular-nums">{etaStr}</span>
                          </>
                        )}
                      </>
                    ) : (
                      <span>{upload.status}</span>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
