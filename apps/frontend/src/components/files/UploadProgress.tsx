import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useUploadStore } from "../../stores/upload.js";
import { useThemeStore } from "../../stores/theme.js";

const ETA_TICK_MS = 300;

function etaAlpha(prevEtaS: number): number {
  const MIN = 0.04, MAX = 0.30, LO = 5, HI = 300;
  if (prevEtaS <= LO) return MAX;
  if (prevEtaS >= HI) return MIN;
  const t = Math.log(prevEtaS / LO) / Math.log(HI / LO);
  return MAX + (MIN - MAX) * t;
}

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
  const smoothEtaRef = useRef(new Map<string, number>());
  const accentColor = useThemeStore((s) => s.accentColor);
  const scheduledRef = useRef(new Set<string>());

  useEffect(() => {
    if (uploads.size > 0) setCollapsed(false);
  }, [uploads.size, setCollapsed]);

  useEffect(() => {
    const id = setInterval(() => {
      const next: Record<string, number> = {};
      for (const upload of uploads.values()) {
        const spd = upload.speedBps ?? 0;
        const remaining = upload.bytesTotal - upload.bytesUploaded;
        const isActive = upload.status !== "DONE" && upload.status !== "FAILED";
        if (isActive && spd > 0 && remaining > 0) {
          const raw = remaining / spd;
          const prev = smoothEtaRef.current.get(upload.fileId) ?? raw;
          const alpha = etaAlpha(prev);
          const smoothed = prev * (1 - alpha) + raw * alpha;
          smoothEtaRef.current.set(upload.fileId, smoothed);
          next[upload.fileId] = smoothed;
        } else {
          smoothEtaRef.current.delete(upload.fileId);
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
    <div className="mb-6 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      <button onClick={() => setCollapsed(!collapsed)} className="flex w-full items-center justify-between px-4 py-3 text-left">
        <div>
          <p className="text-sm font-medium text-white">Uploads</p>
          <p className="text-xs text-zinc-500">{uploads.size} active or recent</p>
        </div>
        <span className="text-zinc-400">{collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}</span>
      </button>

      {!collapsed && (
        <div className="space-y-2 border-t border-zinc-800 px-3 py-3">
          {Array.from(uploads.values()).map((upload) => {
            const percent = upload.bytesTotal > 0 ? Math.round((upload.bytesUploaded / upload.bytesTotal) * 100) : 0;
            const isActive = upload.status !== "DONE" && upload.status !== "FAILED";
            const speedBps = upload.speedBps ?? 0;
            const speedStr = isActive ? formatSpeed(speedBps) : "";
            const etaStr = isActive ? formatEta(etas[upload.fileId] ?? 0) : "";

            return (
              <div key={upload.fileId} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                {/* Row 1: filename + cancel + percent */}
                <div className="mb-2 flex justify-between gap-3 text-sm">
                  <span className="truncate text-white">{upload.fileName ?? upload.fileId}</span>
                  <span className="flex shrink-0 items-center gap-1 text-zinc-400">
                    {isActive && (
                      <button
                        onClick={() => cancelUpload(upload.fileId)}
                        title="Cancel"
                        className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400"
                      >
                        <X size={13} />
                      </button>
                    )}
                    {upload.status === "DONE" ? "Complete" : upload.status === "FAILED" ? "Failed" : `${percent}%`}
                  </span>
                </div>
                {/* Progress bar */}
                <div className="h-1.5 w-full rounded-full bg-zinc-800">
                  <div
                    className="h-1.5 rounded-full transition-all"
                    style={{
                      width: `${percent}%`,
                      backgroundColor: upload.status === "FAILED" ? "#ef4444" : upload.status === "DONE" ? "#22c55e" : accentColor,
                    }}
                  />
                </div>
                {/* Row 3: blobs counter + speed + ETA */}
                <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
                  <span>
                    {upload.uploadedBlobs}/{upload.totalBlobs} blobs
                    {upload.status === "DONE" && <span className="ml-2 text-green-500">✓</span>}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {speedStr && isActive ? (
                      <>
                        <span className="font-medium" style={{ color: accentColor }}>{speedStr}</span>
                        {etaStr && (
                          <>
                            <span className="text-zinc-700">·</span>
                            <span>{etaStr}</span>
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
