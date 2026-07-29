// DiscorDrive v4 — Download progress component

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useDownloadStore } from "../../stores/download.js";

const WINDOW_MS = 8000;
const TICK_MS   = 300;
const EMA_ALPHA = 0.10;
const MIN_WINDOW_FOR_DISPLAY_MS = 2000;

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

  const scheduledRef  = useRef(new Set<string>());
  const historyRef    = useRef(new Map<string, Sample[]>());
  const smoothRef     = useRef(new Map<string, number>());
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

        // Seed the EMA from the first real measurement. Blending it against the
        // zero of the warm-up window instead ramps the speed up from 0 over
        // several seconds, and every ETA derived during that ramp is inflated.
        const prev = smoothRef.current.get(fid);
        const smoothed = instant > 0
          ? (prev ? prev * (1 - EMA_ALPHA) + instant * EMA_ALPHA : instant)
          : (prev ?? 0) * 0.85;
        smoothRef.current.set(fid, smoothed);
        next[fid] = smoothed;
      }

      setSpeeds(next);
      // Derived fresh from the windowed speed, never smoothed on its own: ETA is
      // a reciprocal of what we measure, so averaging it lets a stale slow-start
      // estimate outlive the slow start — that is what left a stuck "1.5 h"
      // ticking down by minutes per second once the transfer reached full speed.
      const etaMap: Record<string, number> = {};
      for (const dl of downloads.values()) {
        const spd = next[dl.fileId] ?? 0;
        const remaining = dl.bytesTotal - dl.bytesDownloaded;
        if (spd > 0 && remaining > 0 && dl.status !== "DONE" && dl.status !== "FAILED") {
          etaMap[dl.fileId] = remaining / spd;
        }
      }
      setEtas(etaMap);
    }, TICK_MS);

    return () => clearInterval(id);
  }, [downloads, removeDownload]);

  if (downloads.size === 0) return null;

  return (
    <div className="mb-6 overflow-hidden rounded-card border border-rule bg-paper">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <p className="text-sm font-medium text-ink">Downloads</p>
          <p className="text-xs text-muted">{downloads.size} active or recent</p>
        </div>
      </div>

      <div className="space-y-2 border-t border-rule px-3 py-3">
        {Array.from(downloads.values()).map((download) => {
          const percent = download.bytesTotal > 0
            ? Math.round((download.bytesDownloaded / download.bytesTotal) * 100)
            : download.totalChunks > 0
              ? Math.round((download.downloadedChunks / download.totalChunks) * 100)
              : 0;
          const isActive = download.status !== "DONE" && download.status !== "FAILED";
          const speedStr = isActive ? formatSpeed(speeds[download.fileId] ?? 0) : "";

          return (
            <div key={download.fileId} className="rounded-md bg-paper-2 p-3">
              {/* Row 1: filename + cancel + percent */}
              <div className="mb-2 flex justify-between gap-3 text-sm">
                <span className="truncate text-ink">{download.fileName}</span>
                <span className="flex shrink-0 items-center gap-1 text-muted">
                  {isActive && (
                    <button
                      onClick={() => cancelDownload(download.fileId)}
                      title="Cancel"
                      className="rounded-md p-1.5 text-muted transition-colors duration-micro ease-out hover:bg-paper-3 hover:text-error"
                    >
                      <X size={13} />
                    </button>
                  )}
                  {download.status === "DONE" ? (
                    "Complete"
                  ) : download.status === "FAILED" ? (
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
                    download.status === "FAILED" ? "bg-error" : download.status === "DONE" ? "bg-success" : "bg-accent"
                  }`}
                  style={{ transform: `scaleX(${percent / 100})` }}
                />
              </div>
              {/* Row 3: chunks counter + speed + ETA */}
              <div className="mt-2 flex items-center justify-between text-xs text-muted">
                <span>
                  <span className="font-mono tabular-nums">
                    {download.downloadedChunks}/{download.totalChunks}
                  </span>{" "}
                  chunks
                  {download.status === "DONE" && <span className="ml-2 text-success">✓</span>}
                </span>
                <span className="flex items-center gap-1.5">
                  {speedStr && isActive ? (
                    <>
                      <span className="font-mono font-medium tabular-nums text-accent">{speedStr}</span>
                      {formatEta(etas[download.fileId] ?? 0) && (
                        <>
                          <span className="text-muted">·</span>
                          <span className="font-mono tabular-nums">{formatEta(etas[download.fileId] ?? 0)}</span>
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
