// DiscorDrive v4 — Video player modal with Service Worker streaming

import { useEffect, useRef, useState, useCallback } from "react";
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

  // Register stream on mount, cleanup on unmount
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

  // Escape to close
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
      chunkCount: file.chunkCount,
      encryptedFEK: file.encryptedFEK,
      fekIv: file.fekIv,
    });
  }, [file, onClose]);

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
    >
      <div className="relative w-full max-w-5xl mx-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white text-sm font-medium truncate max-w-[80%]">
            {file.fileName}
          </h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white text-xl leading-none px-2"
          >
            &times;
          </button>
        </div>

        {/* Video container */}
        <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
          <video
            ref={videoRef}
            controls
            autoPlay
            onCanPlay={handleCanPlay}
            onError={handleError}
            className="w-full h-full"
          />

          {/* Loading overlay */}
          {state === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60">
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span className="text-zinc-400 text-sm">Buffering...</span>
              </div>
            </div>
          )}

          {/* Error overlay */}
          {state === "error" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60">
              <div className="flex flex-col items-center gap-3 text-center px-4">
                <span className="text-red-400 text-sm">{errorMsg}</span>
                <button
                  onClick={handleDownloadFallback}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
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
