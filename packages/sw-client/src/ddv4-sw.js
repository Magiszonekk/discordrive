// DiscorDrive v4 — Generalized decryption proxy Service Worker
// Intercepts /ddv4-file/:id requests, decrypts AES-GCM chunks on-the-fly,
// serves full files or byte ranges. FEK never leaves the browser.
//
// Usage:
//   1. Copy this file to your app's public/ directory as ddv4-sw.js
//   2. Use @ddv4/sw-client to register files and get proxy URLs

const IV_LENGTH = 12;

// State maps keyed by registration ID (UUID)
const files = new Map();     // id → { fek, chunkUrlTemplate, headers, chunkSize, chunkCount, totalSize, mimeType, fileName, chunksAhead, chunksBehind }
const chunkCache = new Map(); // id → Map<chunkIndex, ArrayBuffer>
const fetching = new Map();   // id → Map<chunkIndex, Promise<ArrayBuffer>>

// === Message Handler ===

self.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === "REGISTER_FILE") {
    const port = event.ports[0] ?? null;
    const fek = await crypto.subtle.importKey(
      "raw",
      msg.fekRaw,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );

    files.set(msg.id, {
      fek,
      chunkUrlTemplate: msg.chunkUrlTemplate,
      headers: msg.headers ?? {},
      chunkSize: msg.chunkSize,
      chunkCount: msg.chunkCount,
      totalSize: msg.totalSize,
      mimeType: msg.mimeType,
      fileName: msg.fileName ?? "",
      chunksAhead: msg.chunksAhead ?? 3,
      chunksBehind: msg.chunksBehind ?? 2,
    });
    chunkCache.set(msg.id, new Map());
    fetching.set(msg.id, new Map());

    // ACK — client awaits this before triggering download/stream
    port?.postMessage({ type: "FILE_REGISTERED", id: msg.id });
  }

  if (msg.type === "UNREGISTER_FILE") {
    files.delete(msg.id);
    chunkCache.delete(msg.id);
    fetching.delete(msg.id);
  }

  // Legacy support — old REGISTER_STREAM messages from stream-sw.js clients
  // Remove once all consumers have migrated to REGISTER_FILE
  if (msg.type === "REGISTER_STREAM") {
    const fek = await crypto.subtle.importKey(
      "raw",
      msg.fekRaw,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    files.set(msg.fileId, {
      fek,
      chunkUrlTemplate: `/api/download/${msg.fileId}/chunk/{index}`,
      headers: msg.token ? { Authorization: `Bearer ${msg.token}` } : {},
      chunkSize: msg.chunkSize,
      chunkCount: msg.chunkCount,
      totalSize: msg.totalSize,
      mimeType: msg.mimeType,
      fileName: "",
      chunksAhead: msg.chunksAhead ?? 3,
      chunksBehind: msg.chunksBehind ?? 2,
    });
    chunkCache.set(msg.fileId, new Map());
    fetching.set(msg.fileId, new Map());
  }

  if (msg.type === "UNREGISTER_STREAM") {
    files.delete(msg.fileId);
    chunkCache.delete(msg.fileId);
    fetching.delete(msg.fileId);
  }
});

// === Fetch Handler ===

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // New route: /ddv4-file/:id
  let match = url.pathname.match(/^\/ddv4-file\/([^?]+)$/);
  let download = false;

  if (match) {
    download = url.searchParams.get("download") === "1";
  } else {
    // Legacy route: /sw-stream/:fileId — keep until all consumers migrate
    match = url.pathname.match(/^\/sw-stream\/(.+)$/);
  }

  if (!match) return;

  const id = match[1];
  event.respondWith(handleFileRequest(event.request, id, download));
});

async function handleFileRequest(request, id, download) {
  const file = files.get(id);
  if (!file) {
    return new Response("File not registered", { status: 404 });
  }

  const { totalSize, mimeType, chunkSize, fileName } = file;
  const rangeHeader = request.headers.get("Range");

  // Base response headers
  const baseHeaders = {
    "Content-Type": mimeType || "application/octet-stream",
    "Accept-Ranges": "bytes",
  };

  if (download && fileName) {
    baseHeaders["Content-Disposition"] =
      `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  }

  // No Range header — return full streaming response
  if (!rangeHeader) {
    const body = createFullStream(id, file);
    return new Response(body, {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Length": String(totalSize),
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
    const data = await getByteRange(id, file, start, clampedEnd);

    const currentChunk = Math.floor(start / chunkSize);
    schedulePrefetch(id, file, currentChunk);
    scheduleEviction(id, file, currentChunk);

    return new Response(data, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${clampedEnd}/${totalSize}`,
        "Content-Length": String(clampedEnd - start + 1),
      },
    });
  } catch (err) {
    console.error("[ddv4-sw] Range request failed:", err);
    return new Response("Chunk fetch failed", { status: 502 });
  }
}

// === Full stream (no Range header) ===

function createFullStream(id, file) {
  const { chunkCount } = file;
  let currentChunk = 0;
  let cancelled = false;

  return new ReadableStream({
    async pull(controller) {
      if (cancelled || currentChunk >= chunkCount) {
        controller.close();
        return;
      }
      try {
        const decrypted = await getDecryptedChunk(id, file, currentChunk);
        controller.enqueue(new Uint8Array(decrypted));
        currentChunk++;
      } catch (err) {
        console.error("[ddv4-sw] Full stream chunk failed:", err);
        controller.error(err);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

// === Byte range extraction ===

async function getByteRange(id, file, start, end) {
  const { chunkSize } = file;
  const startChunk = Math.floor(start / chunkSize);
  const endChunk = Math.floor(end / chunkSize);
  const totalBytes = end - start + 1;

  if (startChunk === endChunk) {
    const decrypted = await getDecryptedChunk(id, file, startChunk);
    const offsetInChunk = start - startChunk * chunkSize;
    return decrypted.slice(offsetInChunk, offsetInChunk + totalBytes);
  }

  const result = new Uint8Array(totalBytes);
  let written = 0;

  for (let ci = startChunk; ci <= endChunk; ci++) {
    const decrypted = await getDecryptedChunk(id, file, ci);
    const chunkStart = ci * chunkSize;
    const sliceStart = Math.max(start, chunkStart) - chunkStart;
    const sliceEnd = Math.min(end + 1, chunkStart + decrypted.byteLength) - chunkStart;
    const slice = new Uint8Array(decrypted, sliceStart, sliceEnd - sliceStart);
    result.set(slice, written);
    written += slice.byteLength;
  }

  return result.buffer;
}

// === Chunk fetching + decryption + caching ===

async function getDecryptedChunk(id, file, chunkIndex) {
  const cache = chunkCache.get(id);
  if (cache?.has(chunkIndex)) return cache.get(chunkIndex);

  const inflight = fetching.get(id);
  if (inflight?.has(chunkIndex)) return inflight.get(chunkIndex);

  const promise = fetchAndDecrypt(id, file, chunkIndex);
  inflight?.set(chunkIndex, promise);

  try {
    const decrypted = await promise;
    cache?.set(chunkIndex, decrypted);
    return decrypted;
  } finally {
    inflight?.delete(chunkIndex);
  }
}

async function fetchAndDecrypt(id, file, chunkIndex) {
  const { chunkUrlTemplate, headers, fek } = file;
  const url = chunkUrlTemplate.replace("{index}", String(chunkIndex));

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Chunk ${chunkIndex} fetch failed: ${response.status}`);
  }

  const encrypted = await response.arrayBuffer();
  return decrypt(encrypted, fek);
}

async function decrypt(encrypted, fek) {
  const data = new Uint8Array(encrypted);
  const iv = data.subarray(0, IV_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, fek, ciphertext);
}

// === Prefetch + Eviction ===

function schedulePrefetch(id, file, currentChunk) {
  const { chunkCount, chunksAhead } = file;
  const limit = Math.min(currentChunk + chunksAhead + 1, chunkCount);

  for (let ci = currentChunk + 1; ci < limit; ci++) {
    const cache = chunkCache.get(id);
    const inflight = fetching.get(id);
    if (cache && !cache.has(ci) && inflight && !inflight.has(ci)) {
      getDecryptedChunk(id, file, ci).catch(() => {});
    }
  }
}

function scheduleEviction(id, file, currentChunk) {
  const { chunksBehind } = file;
  const cache = chunkCache.get(id);
  if (!cache) return;

  const evictBefore = currentChunk - chunksBehind;
  for (const key of cache.keys()) {
    if (key < evictBefore) cache.delete(key);
  }
}

// === SW Lifecycle ===

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
