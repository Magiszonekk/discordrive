import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { gqlRequest } from "../lib/graphql.js";
import { downloadSharedFile, DOWNLOAD_SUCCESS_EVENT } from "../lib/download.js";
import { unwrapKeyPacked, toBase64, fromBase64, decryptMeta } from "../lib/crypto.js";
import { deriveShareWrapKey, deriveShareAuthKey, deriveShareCapabilityToken } from "@ddv4/processing";
import type { ShareAccessResponse } from "@ddv4/types/api";
import { useNotificationStore } from "../stores/notifications.js";
import { AuthCard, authPrimaryButtonClass } from "../components/layout/AuthCard.js";

const ACCESS_SHARE = `
  query AccessShare($shareId: ID!, $capabilityToken: String!) {
    accessShare(shareId: $shareId, capabilityToken: $capabilityToken) {
      shareId
      wrappedAKShare
      wrappedObjectKeys { fileId primaryManifestBlobId encryptedName encryptedMimeType wrappedFEK }
      allowContent
    }
  }
`;

interface ResolvedShareInfo {
  shareId: string;
  fileName: string;
  mimeType: string;
  allowContent: boolean;
  manifestBlobId: string;
  rootFek: CryptoKey;
  capabilityTokenB64: string;
}

export function SharedFile() {
  const { shareId } = useParams<{ shareId: string }>();
  const [info, setInfo] = useState<ResolvedShareInfo | null>(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const pushNotification = useNotificationStore((s) => s.push);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ fileName: string; bytes: number }>).detail;
      if (!detail) return;
      pushNotification("success", `Download started: ${detail.fileName} (${detail.bytes} B)`);
    };
    window.addEventListener(DOWNLOAD_SUCCESS_EVENT, handler as EventListener);
    return () => window.removeEventListener(DOWNLOAD_SUCCESS_EVENT, handler as EventListener);
  }, [pushNotification]);

  useEffect(() => {
    if (!shareId) return;

    const linkSecret = window.location.hash.replace(/^#/, "");
    if (!linkSecret) {
      setError("Share secret not found in URL fragment");
      return;
    }

    (async () => {
      try {
        const secretBytes = fromBase64(linkSecret);
        const shareAuthKey = await deriveShareAuthKey(secretBytes);
        const capabilityTokenB64 = toBase64(await deriveShareCapabilityToken(shareAuthKey));

        const { accessShare } = await gqlRequest<{ accessShare: ShareAccessResponse | null }>(ACCESS_SHARE, {
          shareId,
          capabilityToken: capabilityTokenB64,
        });

        if (!accessShare) {
          setError("Share link not found or expired");
          return;
        }

        const shareWrapKey = await deriveShareWrapKey(secretBytes);
        const shareKey = await unwrapKeyPacked(accessShare.wrappedAKShare, shareWrapKey, ["wrapKey", "unwrapKey"]);
        const wrappedFEK = accessShare.wrappedObjectKeys[0]?.wrappedFEK;
        if (!wrappedFEK) throw new Error("Share does not include file decryption material");
        const rootFek = await unwrapKeyPacked(wrappedFEK, shareKey, ["wrapKey", "unwrapKey"]);

        const key = accessShare.wrappedObjectKeys[0];
        const fileName = key?.encryptedName
          ? await decryptMeta(rootFek, key.encryptedName)
          : key?.fileId ?? "shared-file";
        const mimeType = key?.encryptedMimeType
          ? await decryptMeta(rootFek, key.encryptedMimeType)
          : "application/octet-stream";

        const manifestBlobId = key?.primaryManifestBlobId ?? "";

        setInfo({
          shareId: accessShare.shareId,
          fileName,
          mimeType,
          allowContent: accessShare.allowContent,
          manifestBlobId,
          rootFek,
          capabilityTokenB64,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load share");
      }
    })();
  }, [shareId]);

  const handleDownload = async () => {
    if (!shareId || !info) return;
    setDownloading(true);
    setError("");
    try {
      await downloadSharedFile({
        fileName: info.fileName,
        mimeType: info.mimeType,
        manifestBlobId: info.manifestBlobId,
        rootFek: info.rootFek,
        shareId,
        capabilityToken: info.capabilityTokenB64,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Download failed";
      setError(message);
      pushNotification("error", message);
    } finally {
      setDownloading(false);
    }
  };

  if (error && !info) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-4">
        <p className="text-sm text-error">{error}</p>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-4">
        <p className="text-sm text-muted">Loading…</p>
      </div>
    );
  }

  return (
    <AuthCard title="Shared file">
      <div className="mb-6 space-y-1 text-sm text-ink-2">
        <p className="truncate font-medium text-ink">{info.fileName}</p>
        <p className="font-mono text-xs text-muted">{info.mimeType}</p>
      </div>
      <button
        onClick={handleDownload}
        disabled={downloading || !info.allowContent}
        className={authPrimaryButtonClass}
      >
        {downloading ? "Downloading…" : "Download"}
      </button>
      {error && <p className="mt-3 text-sm text-error">{error}</p>}
    </AuthCard>
  );
}
