// DiscorDrive v4 — Video player modal with Service Worker streaming

import { useCallback, useEffect, useRef, useState } from "react";
import {
  registerStream,
  unregisterStream,
  getStreamUrl,
  type StreamFileInfo,
} from "../../lib/videoStream.js";
import { downloadFile } from "../../lib/download.js";

interface VideoPlayerProps {
  file: StreamFileInfo & { fileName: string };
  onClose: () => void;
}

export function VideoPlayer({ file, onClose }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let unmounted = false;

    registerStream(file)
      .then(() => {
        if (!unmounted && videoRef.current) {
          videoRef.current.src = getStreamUrl(file.fileId);
          videoRef.current.load();
        }
      })
      .catch((err) => {
        if (!unmounted) {
          setErrorMsg(err instanceof Error ? err.message : "Stream setup failed");
          setState("error");
        }
      });

    return () => {
      unmounted = true;
      unregisterStream(file.fileId);
    };
  }, [file]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleCanPlay = useCallback(() => setState("ready"), []);

  const handleError = useCallback(() => {
    const video = videoRef.current;
    const code = video?.error?.code;
    const msg = video?.error?.message || "Playback error";

    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      setErrorMsg("This video format is not supported by your browser");
    } else {
      setErrorMsg(msg);
    }
    setState("error");
  }, []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) onClose();
    },
    [onClose],
  );

  const handleDownloadFallback = useCallback(async () => {
    onClose();
    await downloadFile({
      fileId: file.fileId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      manifestBlobId: file.manifestBlobId,
      wrappedFEK: file.wrappedFEK,
    });
  }, [file, onClose]);

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-modal flex items-end bg-graphite/80 backdrop-blur-sm md:items-center md:justify-center"
    >
      <div className="relative flex h-screen w-full flex-col bg-graphite md:h-auto md:max-w-5xl md:rounded-card md:bg-transparent md:px-4">
        <div className="flex items-center justify-between px-4 py-3 md:mb-3 md:px-0">
          <h2 className="max-w-[80%] truncate text-sm font-medium text-graphite-ink">
            {file.fileName}
          </h2>
          <button
            onClick={onClose}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md text-graphite-ink/70 transition-colors duration-micro ease-out hover:bg-white/10 hover:text-graphite-ink"
          >
            &times;
          </button>
        </div>

        <div className="relative flex-1 bg-graphite md:flex-none md:overflow-hidden md:rounded-card md:aspect-video">
          <video
            ref={videoRef}
            controls
            autoPlay
            onCanPlay={handleCanPlay}
            onError={handleError}
            className="h-full w-full"
          />

          {state === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center bg-graphite/60">
              <div className="flex flex-col items-center gap-3">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-graphite-ink/30 border-t-graphite-ink" />
                <span className="text-sm text-graphite-ink/70">Buffering…</span>
              </div>
            </div>
          )}

          {state === "error" && (
            <div className="absolute inset-0 flex items-center justify-center bg-graphite/60">
              <div className="flex flex-col items-center gap-3 px-4 text-center">
                <span className="text-sm text-error">{errorMsg}</span>
                <button
                  onClick={handleDownloadFallback}
                  className="rounded-md bg-accent px-4 py-3 text-sm font-medium text-accent-ink transition-colors duration-micro ease-out hover:bg-accent-hover"
                >
                  Download instead
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
