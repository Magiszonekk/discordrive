// DiscorDrive v4 — Video Streaming Service Worker
// Intercepts /sw-stream/:fileId requests, decrypts chunks client-side,
// serves byte ranges to <video> element. FEK never leaves the browser.

const IV_LENGTH = 12;

// State maps
const streams = new Map();    // fileId → { fek, token, chunkSize, chunkCount, totalSize, mimeType, chunksAhead, chunksBehind }
const chunkCache = new Map();  // fileId → Map<chunkIndex, ArrayBuffer>
const fetching = new Map();    // fileId → Map<chunkIndex, Promise<ArrayBuffer>>

// === Message Handler ===

self.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === "REGISTER_STREAM") {
    const fek = await crypto.subtle.importKey(
      "raw",
      msg.fekRaw,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );

    streams.set(msg.fileId, {
      fek,
      token: msg.token,
      chunkSize: msg.chunkSize,
      chunkCount: msg.chunkCount,
      totalSize: msg.totalSize,
      mimeType: msg.mimeType,
      chunksAhead: msg.chunksAhead,
      chunksBehind: msg.chunksBehind,
    });
    chunkCache.set(msg.fileId, new Map());
    fetching.set(msg.fileId, new Map());
  }

  if (msg.type === "UNREGISTER_STREAM") {
    streams.delete(msg.fileId);
    chunkCache.delete(msg.fileId);
    fetching.delete(msg.fileId);
  }
});

// === Fetch Handler ===

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/sw-stream\/(.+)$/);
  if (!match) return;

  const fileId = match[1];
  event.respondWith(handleStreamRequest(event.request, fileId));
});

async function handleStreamRequest(request, fileId) {
  const stream = streams.get(fileId);
  if (!stream) {
    return new Response("Stream not registered", { status: 404 });
  }

  const { totalSize, mimeType, chunkSize, chunkCount } = stream;
  const rangeHeader = request.headers.get("Range");

  // No Range header — return streaming response so browser can detect codec,
  // then it will cancel and switch to Range requests
  if (!rangeHeader) {
    const body = createFullStream(fileId, stream);
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
    const data = await getByteRange(fileId, stream, start, clampedEnd);

    // Schedule prefetch in background
    const currentChunk = Math.floor(start / chunkSize);
    schedulePrefetch(fileId, stream, currentChunk);
    scheduleEviction(fileId, stream, currentChunk);

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

// === Full stream (no Range header) ===

function createFullStream(fileId, stream) {
  const { chunkCount } = stream;
  let currentChunk = 0;
  let cancelled = false;

  return new ReadableStream({
    async pull(controller) {
      if (cancelled || currentChunk >= chunkCount) {
        controller.close();
        return;
      }
      try {
        const decrypted = await getDecryptedChunk(fileId, stream, currentChunk);
        controller.enqueue(new Uint8Array(decrypted));
        currentChunk++;
      } catch (err) {
        console.error("[stream-sw] Full stream chunk failed:", err);
        controller.error(err);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

// === Byte range extraction ===

async function getByteRange(fileId, stream, start, end) {
  const { chunkSize } = stream;
  const startChunk = Math.floor(start / chunkSize);
  const endChunk = Math.floor(end / chunkSize);
  const totalBytes = end - start + 1;

  if (startChunk === endChunk) {
    // Single chunk — fast path
    const decrypted = await getDecryptedChunk(fileId, stream, startChunk);
    const offsetInChunk = start - startChunk * chunkSize;
    return decrypted.slice(offsetInChunk, offsetInChunk + totalBytes);
  }

  // Multiple chunks — assemble
  const result = new Uint8Array(totalBytes);
  let written = 0;

  for (let ci = startChunk; ci <= endChunk; ci++) {
    const decrypted = await getDecryptedChunk(fileId, stream, ci);
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

async function getDecryptedChunk(fileId, stream, chunkIndex) {
  const cache = chunkCache.get(fileId);
  if (cache && cache.has(chunkIndex)) {
    return cache.get(chunkIndex);
  }

  // Deduplicate in-flight fetches
  const inflight = fetching.get(fileId);
  if (inflight && inflight.has(chunkIndex)) {
    return inflight.get(chunkIndex);
  }

  const promise = fetchAndDecrypt(fileId, stream, chunkIndex);
  if (inflight) inflight.set(chunkIndex, promise);

  try {
    const decrypted = await promise;
    if (cache) cache.set(chunkIndex, decrypted);
    return decrypted;
  } finally {
    if (inflight) inflight.delete(chunkIndex);
  }
}

async function fetchAndDecrypt(fileId, stream, chunkIndex) {
  const { token, fek } = stream;

  const response = await fetch(`/api/download/${fileId}/chunk/${chunkIndex}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

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

function schedulePrefetch(fileId, stream, currentChunk) {
  const { chunkCount, chunksAhead } = stream;
  const limit = Math.min(currentChunk + chunksAhead + 1, chunkCount);

  for (let ci = currentChunk + 1; ci < limit; ci++) {
    const cache = chunkCache.get(fileId);
    const inflight = fetching.get(fileId);
    if (cache && !cache.has(ci) && inflight && !inflight.has(ci)) {
      // Fire and forget — prefetch in background
      getDecryptedChunk(fileId, stream, ci).catch(() => {});
    }
  }
}

function scheduleEviction(fileId, stream, currentChunk) {
  const { chunksBehind } = stream;
  const cache = chunkCache.get(fileId);
  if (!cache) return;

  const evictBefore = currentChunk - chunksBehind;
  for (const key of cache.keys()) {
    if (key < evictBefore) {
      cache.delete(key);
    }
  }
}

// === SW Lifecycle ===

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
