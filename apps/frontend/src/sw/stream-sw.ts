// DiscorDrive v4 — Service Worker adapter
// Thin wrapper over @ddv4/stream-engine. Handles browser-specific SW lifecycle,
// message protocol, and fetch interception. All core logic lives in the engine.
//
// NOTE: This file is compiled by esbuild (via Vite plugin) into public/stream-sw.js.
// It runs in a ServiceWorkerGlobalScope, not in the main thread.
// TypeScript ServiceWorker types come from the "webworker" lib.

/// <reference lib="webworker" />

import {
  DownloadEngine,
  UploadEngine,
  type ChunkSource,
  type ChunkSink,
} from "@ddv4/stream-engine";

declare const self: ServiceWorkerGlobalScope;

const downloadEngine = new DownloadEngine();
const uploadEngine = new UploadEngine();

// === Browser-specific adapters ===

class SwChunkSource implements ChunkSource {
  constructor(private token: string) {}

  async fetch(fileId: string, chunkIndex: number): Promise<ArrayBuffer> {
    const res = await globalThis.fetch(
      `/api/download/${fileId}/chunk/${chunkIndex}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!res.ok) {
      throw new Error(`Chunk ${chunkIndex} fetch failed: ${res.status}`);
    }
    return res.arrayBuffer();
  }
}

class SwChunkSink implements ChunkSink {
  constructor(private token: string) {}

  async upload(
    fileId: string,
    chunkIndex: number,
    encrypted: ArrayBuffer,
  ): Promise<void> {
    const res = await globalThis.fetch(
      `/api/upload/${fileId}/chunk/${chunkIndex}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: encrypted,
      },
    );
    if (!res.ok) {
      throw new Error(`Upload chunk ${chunkIndex} failed: ${res.status}`);
    }
  }
}

// Token per-stream source registry (needed because each stream has its own token)
const sources = new Map<string, SwChunkSource>();

// === Helpers ===

function broadcast(message: Record<string, unknown>): void {
  self.clients.matchAll().then((clients: readonly Client[]) => {
    for (const client of clients) {
      client.postMessage(message);
    }
  });
}

// === Message Handler ===

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  // Download registration (existing protocol — backwards compatible)
  if (msg.type === "REGISTER_STREAM") {
    crypto.subtle
      .importKey("raw", msg.fekRaw, { name: "AES-GCM" }, false, ["decrypt"])
      .then((fek: CryptoKey) => {
        downloadEngine.register({
          fileId: msg.fileId,
          fek,
          chunkSize: msg.chunkSize,
          chunkCount: msg.chunkCount,
          totalSize: msg.totalSize,
          mimeType: msg.mimeType,
          chunksAhead: msg.chunksAhead,
          chunksBehind: msg.chunksBehind,
        });
        sources.set(msg.fileId, new SwChunkSource(msg.token));
      });
  }

  if (msg.type === "UNREGISTER_STREAM") {
    downloadEngine.unregister(msg.fileId);
    sources.delete(msg.fileId);
  }

  // Upload (new protocol)
  if (msg.type === "UPLOAD_CHUNKS") {
    const handleUpload = async () => {
      const fek = await crypto.subtle.importKey(
        "raw",
        msg.fekRaw,
        { name: "AES-GCM" },
        false,
        ["encrypt"],
      );
      const sink = new SwChunkSink(msg.token);

      // Convert transferred ArrayBuffers to Uint8Arrays
      const chunks: Uint8Array[] = (msg.chunks as ArrayBuffer[]).map(
        (buf) => new Uint8Array(buf),
      );

      try {
        await uploadEngine.uploadChunks(
          msg.fileId,
          chunks,
          {
            fek,
            chunkSize: msg.chunkSize,
            concurrency: msg.concurrency ?? 3,
          },
          sink,
          (progress) => {
            broadcast({
              type: "UPLOAD_PROGRESS",
              fileId: msg.fileId,
              ...progress,
            });
          },
        );

        broadcast({ type: "UPLOAD_DONE", fileId: msg.fileId });
      } catch (err) {
        broadcast({
          type: "UPLOAD_ERROR",
          fileId: msg.fileId,
          error: err instanceof Error ? err.message : "Upload failed",
        });
      }
    };

    event.waitUntil(handleUpload());
  }
});

// === Fetch Handler (download) ===

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/sw-stream\/(.+)$/);
  if (!match) return;

  const fileId = match[1];
  event.respondWith(handleStreamRequest(event.request, fileId));
});

async function handleStreamRequest(
  request: Request,
  fileId: string,
): Promise<Response> {
  const cfg = downloadEngine.getConfig(fileId);
  if (!cfg) {
    return new Response("Stream not registered", { status: 404 });
  }

  const source = sources.get(fileId);
  if (!source) {
    return new Response("Source not available", { status: 404 });
  }

  const { totalSize, mimeType, chunkSize } = cfg;
  const rangeHeader = request.headers.get("Range");

  // No Range header — return full streaming response
  if (!rangeHeader) {
    const body = downloadEngine.createFullStream(fileId, source);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": mimeType || "video/mp4",
        "Content-Length": totalSize.toString(),
        "Accept-Ranges": "bytes",
      },
    });
  }

  // Parse Range header: "bytes=start-end"
  const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!rangeMatch) {
    return new Response("Invalid range", { status: 416 });
  }

  const start = parseInt(rangeMatch[1], 10);
  const end = rangeMatch[2]
    ? parseInt(rangeMatch[2], 10)
    : Math.min(start + chunkSize - 1, totalSize - 1);
  const clampedEnd = Math.min(end, totalSize - 1);

  if (start >= totalSize || start > clampedEnd) {
    return new Response("Range not satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${totalSize}` },
    });
  }

  try {
    const data = await downloadEngine.getByteRange(
      fileId,
      start,
      clampedEnd,
      source,
    );

    return new Response(data, {
      status: 206,
      headers: {
        "Content-Type": mimeType || "video/mp4",
        "Content-Range": `bytes ${start}-${clampedEnd}/${totalSize}`,
        "Content-Length": (clampedEnd - start + 1).toString(),
        "Accept-Ranges": "bytes",
      },
    });
  } catch (err) {
    console.error("[stream-sw] Range request failed:", err);
    return new Response("Chunk fetch failed", { status: 502 });
  }
}

// === SW Lifecycle ===

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});
