import { useState, useEffect } from "react";
import { useParams } from "react-router";
import { getShareInfo, verifySharePassword } from "../lib/api.js";
import { unwrapSharedFEK } from "../lib/crypto.js";
import { downloadSharedFile } from "../lib/download.js";
import type { ShareInfoResponse } from "@ddv4/types/api";

export function SharedFile() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<ShareInfoResponse | null>(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordVerified, setPasswordVerified] = useState(false);

  useEffect(() => {
    if (!token) return;
    getShareInfo(token).then((data) => {
      if (!data) {
        setError("Share link not found or expired");
        return;
      }
      setInfo(data);
      setNeedsPassword(data.isPasswordProtected);
    });
  }, [token]);

  const handleVerifyPassword = async () => {
    if (!token) return;
    const valid = await verifySharePassword(token, password);
    if (valid) {
      setPasswordVerified(true);
      setNeedsPassword(false);
    } else {
      setError("Invalid password");
    }
  };

  const handleDownload = async () => {
    if (!token || !info) return;

    // Extract share key from URL fragment
    const hash = window.location.hash;
    const keyMatch = hash.match(/key=([A-Za-z0-9+/=]+)/);
    if (!keyMatch) {
      setError("Share key not found in URL");
      return;
    }

    setDownloading(true);
    setError("");

    try {
      const fek = await unwrapSharedFEK(
        keyMatch[1],
        info.wrappedFEK,
        info.wrapIv,
      );

      await downloadSharedFile({
        token,
        fileName: info.fileName,
        mimeType: info.mimeType,
        chunkCount: info.chunkCount,
        fek,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  };

  if (error && !info) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-red-400">{error}</div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <div className="w-full max-w-md p-8 bg-zinc-900 rounded-xl border border-zinc-800">
        <h1 className="text-xl font-bold text-white mb-2">{info.fileName}</h1>
        <p className="text-zinc-400 text-sm mb-6">
          {formatSize(info.fileSize)} &middot; {info.mimeType}
        </p>

        {needsPassword && !passwordVerified ? (
          <div className="space-y-3">
            <input
              type="password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white"
            />
            <button
              onClick={handleVerifyPassword}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
            >
              Verify
            </button>
          </div>
        ) : (
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium"
          >
            {downloading ? "Downloading..." : "Download"}
          </button>
        )}

        {error && <p className="mt-3 text-red-400 text-sm">{error}</p>}
      </div>
    </div>
  );
}

function formatSize(bytes: string): string {
  const size = Number(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
