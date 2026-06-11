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
import { chunkFileStream } from "@ddv4/processing";

declare const self: ServiceWorkerGlobalScope;

const downloadEngine = new DownloadEngine();
const uploadEngine = new UploadEngine();

// === Browser-specific adapters ===

class SwChunkSource implements ChunkSource {
  constructor(
    private token: string,
    private blobIds: string[],
    private apiBaseUrl = "",
  ) {}

  async fetch(_fileId: string, chunkIndex: number): Promise<ArrayBuffer> {
    const blobId = this.blobIds[chunkIndex];
    if (!blobId) throw new Error(`No blobId for chunk ${chunkIndex}`);
    const res = await globalThis.fetch(
      `${this.apiBaseUrl}/api/blob/${blobId}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!res.ok) {
      throw new Error(`Blob ${blobId} fetch failed: ${res.status}`);
    }
    return res.arrayBuffer();
  }
}

class SwChunkSink implements ChunkSink {
  constructor(private token: string, private signal?: AbortSignal, private apiBaseUrl = "") {}

  async upload(
    fileId: string,
    chunkIndex: number,
    encrypted: ArrayBuffer,
  ): Promise<void> {
    const res = await globalThis.fetch(
      `${this.apiBaseUrl}/api/upload/${fileId}/chunk/${chunkIndex}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: encrypted,
        signal: this.signal,
      },
    );
    if (!res.ok) {
      throw new Error(`Upload chunk ${chunkIndex} failed: ${res.status}`);
    }
  }
}

// Token per-stream source registry (needed because each stream has its own token)
const sources = new Map<string, SwChunkSource>();

// AbortControllers for in-progress uploads
const uploadControllers = new Map<string, AbortController>();

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

  // Page asks SW to claim it (handles race on first install where the page
  // missed the initial controllerchange event fired during activation).
  if (msg.type === "CLAIM") {
    event.waitUntil(
      self.clients.claim().then(() =>
        self.clients.matchAll().then((clients) => {
          for (const client of clients) {
            client.postMessage({ type: "SW_ACTIVATED" });
          }
        }),
      ),
    );
    return;
  }

  if (msg.type === "REGISTER_STREAM") {
    const port = event.ports[0] ?? null;
    event.waitUntil(
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
            chunksAhead: msg.chunksAhead ?? 3,
            chunksBehind: msg.chunksBehind ?? 1,
          });
          sources.set(
            msg.fileId,
            new SwChunkSource(msg.token, msg.blobIds as string[], msg.apiBaseUrl ?? ""),
          );
          port?.postMessage({ type: "STREAM_REGISTERED", fileId: msg.fileId });
        })
        .catch((err: unknown) => {
          port?.postMessage({
            type: "STREAM_ERROR",
            fileId: msg.fileId,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    );
  }

  if (msg.type === "UNREGISTER_STREAM") {
    downloadEngine.unregister(msg.fileId);
    sources.delete(msg.fileId);
  }

  // Upload — streaming protocol: SW reads File directly, chunks on demand
  if (msg.type === "UPLOAD_FILE") {
    const handleUpload = async () => {
      const controller = new AbortController();
      uploadControllers.set(msg.fileId, controller);

      const fek = await crypto.subtle.importKey(
        "raw",
        msg.fekRaw,
        { name: "AES-GCM" },
        false,
        ["encrypt"],
      );
      const sink = new SwChunkSink(msg.token, controller.signal, msg.apiBaseUrl ?? "");

      try {
        await uploadEngine.uploadStream(
          msg.fileId,
          chunkFileStream(msg.file as File, msg.chunkSize),
          msg.totalChunks,
          {
            fek,
            chunkSize: msg.chunkSize,
            concurrency: msg.concurrency ?? 20,
            maxRetries: msg.maxRetries ?? 5,
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
        if ((err as DOMException).name === "AbortError") {
          broadcast({ type: "UPLOAD_CANCELLED", fileId: msg.fileId });
        } else {
          broadcast({
            type: "UPLOAD_ERROR",
            fileId: msg.fileId,
            error: err instanceof Error ? err.message : "Upload failed",
          });
        }
      } finally {
        uploadControllers.delete(msg.fileId);
      }
    };

    event.waitUntil(handleUpload());
  }

  if (msg.type === "CANCEL_UPLOAD") {
    uploadControllers.get(msg.fileId)?.abort();
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

  // No Range header — stream sequentially from the start
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

self.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    self.clients.claim().then(() => {
      // Notify all clients that the SW is now in control
      return self.clients.matchAll().then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: "SW_ACTIVATED" });
        }
      });
    }),
  );
});
