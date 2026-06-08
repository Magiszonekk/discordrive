// DiscorDrive v4 — Download progress component

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useDownloadStore } from "../../stores/download.js";
import { useThemeStore } from "../../stores/theme.js";

const WINDOW_MS = 5000;
const TICK_MS   = 300;
const EMA_ALPHA = 0.10;
const MIN_WINDOW_FOR_DISPLAY_MS = 2000;

function etaAlpha(prevEtaS: number): number {
  const MIN = 0.04, MAX = 0.30, LO = 5, HI = 300;
  if (prevEtaS <= LO) return MAX;
  if (prevEtaS >= HI) return MIN;
  const t = Math.log(prevEtaS / LO) / Math.log(HI / LO);
  return MAX + (MIN - MAX) * t;
}

function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
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

type Sample = { ts: number; bytes: number };

export function DownloadProgress() {
  const downloads = useDownloadStore((s) => s.downloads);
  const removeDownload = useDownloadStore((s) => s.removeDownload);
  const cancelDownload = useDownloadStore((s) => s.cancelDownload);
  const accentColor = useThemeStore((s) => s.accentColor);

  const scheduledRef  = useRef(new Set<string>());
  const historyRef    = useRef(new Map<string, Sample[]>());
  const smoothRef     = useRef(new Map<string, number>());
  const smoothEtaRef  = useRef(new Map<string, number>());
  const [speeds, setSpeeds] = useState<Record<string, number>>({});
  const [etas, setEtas] = useState<Record<string, number>>({});

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const cutoff = now - WINDOW_MS;
      const next: Record<string, number> = {};

      for (const dl of downloads.values()) {
        const fid = dl.fileId;

        const hist = historyRef.current.get(fid) ?? [];
        hist.push({ ts: now, bytes: dl.bytesDownloaded });
        while (hist.length > 1 && hist[0]!.ts < cutoff) hist.shift();
        historyRef.current.set(fid, hist);

        if ((dl.status === "DONE" || dl.status === "FAILED") && !scheduledRef.current.has(fid)) {
          scheduledRef.current.add(fid);
          setTimeout(() => {
            removeDownload(fid);
            scheduledRef.current.delete(fid);
            historyRef.current.delete(fid);
            smoothRef.current.delete(fid);
            setSpeeds((s) => { const c = { ...s }; delete c[fid]; return c; });
          }, 3000);
        }

        if (dl.status === "DONE" || dl.status === "FAILED") {
          next[fid] = 0;
          smoothRef.current.set(fid, 0);
          continue;
        }

        let instant = 0;
        if (hist.length >= 2) {
          const oldest = hist[0]!;
          const newest = hist[hist.length - 1]!;
          const deltaMs = newest.ts - oldest.ts;
          if (deltaMs >= MIN_WINDOW_FOR_DISPLAY_MS) {
            instant = ((newest.bytes - oldest.bytes) / deltaMs) * 1000;
          }
        }

        const prev = smoothRef.current.get(fid) ?? instant;
        const smoothed = instant > 0
          ? prev * (1 - EMA_ALPHA) + instant * EMA_ALPHA
          : prev * 0.85;
        smoothRef.current.set(fid, smoothed);
        next[fid] = smoothed;
      }

      setSpeeds(next);
      const etaMap: Record<string, number> = {};
      for (const dl of downloads.values()) {
        const spd = next[dl.fileId] ?? 0;
        const remaining = dl.bytesTotal - dl.bytesDownloaded;
        if (spd > 0 && remaining > 0 && dl.status !== "DONE" && dl.status !== "FAILED") {
          const raw = remaining / spd;
          const prev = smoothEtaRef.current.get(dl.fileId) ?? raw;
          const alpha = etaAlpha(prev);
          const smoothed = prev * (1 - alpha) + raw * alpha;
          smoothEtaRef.current.set(dl.fileId, smoothed);
          etaMap[dl.fileId] = smoothed;
        } else {
          smoothEtaRef.current.delete(dl.fileId);
        }
      }
      setEtas(etaMap);
    }, TICK_MS);

    return () => clearInterval(id);
  }, [downloads, removeDownload]);

  if (downloads.size === 0) return null;

  return (
    <div className="mb-6 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <p className="text-sm font-medium text-white">Downloads</p>
          <p className="text-xs text-zinc-500">{downloads.size} active or recent</p>
        </div>
      </div>

      <div className="space-y-2 border-t border-zinc-800 px-3 py-3">
        {Array.from(downloads.values()).map((download) => {
          const percent = download.bytesTotal > 0
            ? Math.round((download.bytesDownloaded / download.bytesTotal) * 100)
            : download.totalChunks > 0
              ? Math.round((download.downloadedChunks / download.totalChunks) * 100)
              : 0;
          const isActive = download.status !== "DONE" && download.status !== "FAILED";
          const speedStr = isActive ? formatSpeed(speeds[download.fileId] ?? 0) : "";

          return (
            <div key={download.fileId} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
              {/* Row 1: filename + cancel + percent */}
              <div className="mb-2 flex justify-between gap-3 text-sm">
                <span className="truncate text-white">{download.fileName}</span>
                <span className="flex shrink-0 items-center gap-1 text-zinc-400">
                  {isActive && (
                    <button
                      onClick={() => cancelDownload(download.fileId)}
                      title="Cancel"
                      className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-red-400"
                    >
                      <X size={13} />
                    </button>
                  )}
                  {download.status === "DONE" ? "Complete" : download.status === "FAILED" ? "Failed" : `${percent}%`}
                </span>
              </div>
              {/* Progress bar */}
              <div className="h-1.5 w-full rounded-full bg-zinc-800">
                <div
                  className="h-1.5 rounded-full transition-all"
                  style={{
                    width: `${percent}%`,
                    backgroundColor: download.status === "FAILED" ? "#ef4444" : download.status === "DONE" ? "#22c55e" : accentColor,
                  }}
                />
              </div>
              {/* Row 3: chunks counter + speed + ETA */}
              <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
                <span>
                  {download.downloadedChunks}/{download.totalChunks} chunks
                  {download.status === "DONE" && <span className="ml-2 text-green-500">✓</span>}
                </span>
                <span className="flex items-center gap-1.5">
                  {speedStr && isActive ? (
                    <>
                      <span className="font-medium" style={{ color: accentColor }}>{speedStr}</span>
                      {formatEta(etas[download.fileId] ?? 0) && (
                        <>
                          <span className="text-zinc-700">·</span>
                          <span>{formatEta(etas[download.fileId] ?? 0)}</span>
                        </>
                      )}
                    </>
                  ) : (
                    <span>{download.status}</span>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
