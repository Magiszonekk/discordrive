"use strict";
(() => {
  // packages/config/src/index.ts
  var config = {
    // Chunking
    defaultChunkSize: 10 * 1024 * 1024,
    // 10 MB
    maxChunkSize: 25 * 1024 * 1024,
    // 25 MB (Nitro/boost only)
    // Argon2id parameters
    argon2: {
      memory: 65536,
      // 64 MB
      iterations: 3,
      parallelism: 4,
      hashLength: 32
      // 256-bit output
    },
    // Crypto constants
    ivLength: 12,
    // AES-GCM standard IV length
    saltLength: 16,
    // 128-bit salt
    // Upload concurrency
    defaultUploadConcurrency: 3,
    // Discord rate limiting
    webhookRateLimitDefault: 120,
    // req/min starting point
    webhookRateLimitWindow: 6e4,
    // 1 minute window
    cloudflareErrorThreshold: 8e3,
    // stop before 10k/10min IP ban
    cloudflareWindowMs: 10 * 60 * 1e3,
    // 10 minutes
    // Misc
    anonymousTTLDays: 30
  };

  // packages/stream-engine/src/download.ts
  var IV_LENGTH = config.ivLength;
  var DownloadEngine = class {
    streams = /* @__PURE__ */ new Map();
    chunkCache = /* @__PURE__ */ new Map();
    fetching = /* @__PURE__ */ new Map();
    // === Registration ===
    register(cfg) {
      this.streams.set(cfg.fileId, cfg);
      this.chunkCache.set(cfg.fileId, /* @__PURE__ */ new Map());
      this.fetching.set(cfg.fileId, /* @__PURE__ */ new Map());
    }
    unregister(fileId) {
      this.streams.delete(fileId);
      this.chunkCache.delete(fileId);
      this.fetching.delete(fileId);
    }
    getConfig(fileId) {
      return this.streams.get(fileId);
    }
    // === Public API ===
    /**
     * Get a single decrypted chunk (cache-first, dedup in-flight requests).
     */
    async getDecryptedChunk(fileId, chunkIndex, source) {
      const cache = this.chunkCache.get(fileId);
      if (cache?.has(chunkIndex)) {
        return cache.get(chunkIndex);
      }
      const inflight = this.fetching.get(fileId);
      if (inflight?.has(chunkIndex)) {
        return inflight.get(chunkIndex);
      }
      const stream = this.streams.get(fileId);
      if (!stream) throw new Error(`Stream ${fileId} not registered`);
      const promise = this.fetchAndDecrypt(fileId, stream, chunkIndex, source);
      inflight?.set(chunkIndex, promise);
      try {
        const decrypted = await promise;
        cache?.set(chunkIndex, decrypted);
        return decrypted;
      } finally {
        inflight?.delete(chunkIndex);
      }
    }
    /**
     * Assemble a byte range from one or more decrypted chunks.
     * Handles single-chunk fast path and multi-chunk assembly.
     * Triggers prefetch/eviction as side effects.
     */
    async getByteRange(fileId, start, end, source) {
      const stream = this.streams.get(fileId);
      if (!stream) throw new Error(`Stream ${fileId} not registered`);
      const { chunkSize } = stream;
      const startChunk = Math.floor(start / chunkSize);
      const endChunk = Math.floor(end / chunkSize);
      const totalBytes = end - start + 1;
      this.schedulePrefetch(fileId, startChunk, source);
      this.scheduleEviction(fileId, startChunk);
      if (startChunk === endChunk) {
        const decrypted = await this.getDecryptedChunk(fileId, startChunk, source);
        const offsetInChunk = start - startChunk * chunkSize;
        return decrypted.slice(offsetInChunk, offsetInChunk + totalBytes);
      }
      const result = new Uint8Array(totalBytes);
      let written = 0;
      for (let ci = startChunk; ci <= endChunk; ci++) {
        const decrypted = await this.getDecryptedChunk(fileId, ci, source);
        const chunkStart = ci * chunkSize;
        const sliceStart = Math.max(start, chunkStart) - chunkStart;
        const sliceEnd = Math.min(end + 1, chunkStart + decrypted.byteLength) - chunkStart;
        const slice = new Uint8Array(decrypted, sliceStart, sliceEnd - sliceStart);
        result.set(slice, written);
        written += slice.byteLength;
      }
      return result.buffer;
    }
    /**
     * Create a full ReadableStream of all decrypted chunks (sequential).
     * Used for initial codec detection by <video> elements and full file downloads.
     */
    createFullStream(fileId, source) {
      const stream = this.streams.get(fileId);
      if (!stream) throw new Error(`Stream ${fileId} not registered`);
      const { chunkCount } = stream;
      let currentChunk = 0;
      let cancelled = false;
      return new ReadableStream({
        pull: async (controller) => {
          if (cancelled || currentChunk >= chunkCount) {
            controller.close();
            return;
          }
          try {
            const decrypted = await this.getDecryptedChunk(fileId, currentChunk, source);
            controller.enqueue(new Uint8Array(decrypted));
            currentChunk++;
          } catch (err) {
            controller.error(err);
          }
        },
        cancel: () => {
          cancelled = true;
        }
      });
    }
    /**
     * Download all chunks sequentially, decrypt, return as array.
     * Useful for full file downloads and benchmarks.
     */
    async downloadAll(fileId, source) {
      const stream = this.streams.get(fileId);
      if (!stream) throw new Error(`Stream ${fileId} not registered`);
      const results = [];
      for (let i = 0; i < stream.chunkCount; i++) {
        results.push(await this.getDecryptedChunk(fileId, i, source));
      }
      return results;
    }
    // === Internal ===
    async fetchAndDecrypt(fileId, stream, chunkIndex, source) {
      const encrypted = await source.fetch(fileId, chunkIndex);
      return this.decrypt(encrypted, stream.fek);
    }
    async decrypt(encrypted, fek) {
      const data = new Uint8Array(encrypted);
      const iv = data.subarray(0, IV_LENGTH);
      const ciphertext = data.subarray(IV_LENGTH);
      return crypto.subtle.decrypt({ name: "AES-GCM", iv }, fek, ciphertext);
    }
    schedulePrefetch(fileId, currentChunk, source) {
      const stream = this.streams.get(fileId);
      if (!stream) return;
      const { chunkCount, chunksAhead } = stream;
      const limit = Math.min(currentChunk + chunksAhead + 1, chunkCount);
      for (let ci = currentChunk + 1; ci < limit; ci++) {
        const cache = this.chunkCache.get(fileId);
        const inflight = this.fetching.get(fileId);
        if (cache && !cache.has(ci) && inflight && !inflight.has(ci)) {
          this.getDecryptedChunk(fileId, ci, source).catch(() => {
          });
        }
      }
    }
    scheduleEviction(fileId, currentChunk) {
      const stream = this.streams.get(fileId);
      if (!stream) return;
      const cache = this.chunkCache.get(fileId);
      if (!cache) return;
      const evictBefore = currentChunk - stream.chunksBehind;
      for (const key of cache.keys()) {
        if (key < evictBefore) {
          cache.delete(key);
        }
      }
    }
  };

  // packages/stream-engine/src/upload.ts
  var IV_LENGTH2 = config.ivLength;
  var UploadEngine = class {
    /**
     * Encrypt and upload pre-chunked data with concurrency control.
     * Chunks are Uint8Array[] — caller handles chunking (chunkFileStream, Buffer.subarray, etc.).
     */
    async uploadChunks(fileId, chunks, cfg, sink, onProgress) {
      const totalChunks = chunks.length;
      const totalBytes = chunks.reduce((sum, c) => sum + c.byteLength, 0);
      let uploadedChunks = 0;
      let bytesUploaded = 0;
      const tasks = chunks.map((chunk, index) => async () => {
        const encrypted = await this.encrypt(
          chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
          cfg.fek
        );
        await sink.upload(fileId, index, encrypted);
        uploadedChunks++;
        bytesUploaded += chunk.byteLength;
        onProgress?.({
          chunkIndex: index,
          uploadedChunks,
          totalChunks,
          bytesUploaded,
          totalBytes
        });
      });
      await this.runPool(tasks, cfg.concurrency);
    }
    /**
     * Encrypt and upload from an async iterable (streaming, no full buffer needed).
     * Accepts output from chunkFileStream() or similar generators.
     */
    async uploadStream(fileId, chunks, totalChunks, cfg, sink, onProgress) {
      let uploadedChunks = 0;
      let bytesUploaded = 0;
      const queue = [];
      for await (const { index, data } of chunks) {
        if (queue.length >= cfg.concurrency) {
          await Promise.race(queue);
        }
        const chunkBytes = data.byteLength;
        const chunkPromise = (async () => {
          const encrypted = await this.encrypt(
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
            cfg.fek
          );
          await sink.upload(fileId, index, encrypted);
          uploadedChunks++;
          bytesUploaded += chunkBytes;
          onProgress?.({
            chunkIndex: index,
            uploadedChunks,
            totalChunks,
            bytesUploaded,
            totalBytes: 0
            // Unknown when streaming
          });
        })();
        const tracked = chunkPromise.finally(() => {
          const idx = queue.indexOf(tracked);
          if (idx !== -1) queue.splice(idx, 1);
        });
        queue.push(tracked);
      }
      await Promise.all(queue);
    }
    async encrypt(chunk, fek) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH2));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        fek,
        chunk
      );
      const output = new Uint8Array(iv.byteLength + ciphertext.byteLength);
      output.set(iv, 0);
      output.set(new Uint8Array(ciphertext), iv.byteLength);
      return output.buffer;
    }
    async runPool(tasks, concurrency) {
      const results = new Array(tasks.length);
      let nextIdx = 0;
      async function worker() {
        while (true) {
          const idx = nextIdx;
          if (idx >= tasks.length) break;
          nextIdx++;
          results[idx] = await tasks[idx]();
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
      );
      return results;
    }
  };

  // apps/frontend/src/sw/stream-sw.ts
  var downloadEngine = new DownloadEngine();
  var uploadEngine = new UploadEngine();
  var SwChunkSource = class {
    constructor(token) {
      this.token = token;
    }
    async fetch(fileId, chunkIndex) {
      const res = await globalThis.fetch(
        `/api/download/${fileId}/chunk/${chunkIndex}`,
        { headers: { Authorization: `Bearer ${this.token}` } }
      );
      if (!res.ok) {
        throw new Error(`Chunk ${chunkIndex} fetch failed: ${res.status}`);
      }
      return res.arrayBuffer();
    }
  };
  var SwChunkSink = class {
    constructor(token) {
      this.token = token;
    }
    async upload(fileId, chunkIndex, encrypted) {
      const res = await globalThis.fetch(
        `/api/upload/${fileId}/chunk/${chunkIndex}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/octet-stream"
          },
          body: encrypted
        }
      );
      if (!res.ok) {
        throw new Error(`Upload chunk ${chunkIndex} failed: ${res.status}`);
      }
    }
  };
  var sources = /* @__PURE__ */ new Map();
  function broadcast(message) {
    self.clients.matchAll().then((clients) => {
      for (const client of clients) {
        client.postMessage(message);
      }
    });
  }
  self.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    if (msg.type === "REGISTER_STREAM") {
      crypto.subtle.importKey("raw", msg.fekRaw, { name: "AES-GCM" }, false, ["decrypt"]).then((fek) => {
        downloadEngine.register({
          fileId: msg.fileId,
          fek,
          chunkSize: msg.chunkSize,
          chunkCount: msg.chunkCount,
          totalSize: msg.totalSize,
          mimeType: msg.mimeType,
          chunksAhead: msg.chunksAhead,
          chunksBehind: msg.chunksBehind
        });
        sources.set(msg.fileId, new SwChunkSource(msg.token));
      });
    }
    if (msg.type === "UNREGISTER_STREAM") {
      downloadEngine.unregister(msg.fileId);
      sources.delete(msg.fileId);
    }
    if (msg.type === "UPLOAD_CHUNKS") {
      const handleUpload = async () => {
        const fek = await crypto.subtle.importKey(
          "raw",
          msg.fekRaw,
          { name: "AES-GCM" },
          false,
          ["encrypt"]
        );
        const sink = new SwChunkSink(msg.token);
        const chunks = msg.chunks.map(
          (buf) => new Uint8Array(buf)
        );
        try {
          await uploadEngine.uploadChunks(
            msg.fileId,
            chunks,
            {
              fek,
              chunkSize: msg.chunkSize,
              concurrency: msg.concurrency ?? 3
            },
            sink,
            (progress) => {
              broadcast({
                type: "UPLOAD_PROGRESS",
                fileId: msg.fileId,
                ...progress
              });
            }
          );
          broadcast({ type: "UPLOAD_DONE", fileId: msg.fileId });
        } catch (err) {
          broadcast({
            type: "UPLOAD_ERROR",
            fileId: msg.fileId,
            error: err instanceof Error ? err.message : "Upload failed"
          });
        }
      };
      event.waitUntil(handleUpload());
    }
  });
  self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    const match = url.pathname.match(/^\/sw-stream\/(.+)$/);
    if (!match) return;
    const fileId = match[1];
    event.respondWith(handleStreamRequest(event.request, fileId));
  });
  async function handleStreamRequest(request, fileId) {
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
    if (!rangeHeader) {
      const body = downloadEngine.createFullStream(fileId, source);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": mimeType || "video/mp4",
          "Content-Length": totalSize.toString(),
          "Accept-Ranges": "bytes"
        }
      });
    }
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!rangeMatch) {
      return new Response("Invalid range", { status: 416 });
    }
    const start = parseInt(rangeMatch[1], 10);
    const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : Math.min(start + chunkSize - 1, totalSize - 1);
    const clampedEnd = Math.min(end, totalSize - 1);
    if (start >= totalSize || start > clampedEnd) {
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${totalSize}` }
      });
    }
    try {
      const data = await downloadEngine.getByteRange(
        fileId,
        start,
        clampedEnd,
        source
      );
      return new Response(data, {
        status: 206,
        headers: {
          "Content-Type": mimeType || "video/mp4",
          "Content-Range": `bytes ${start}-${clampedEnd}/${totalSize}`,
          "Content-Length": (clampedEnd - start + 1).toString(),
          "Accept-Ranges": "bytes"
        }
      });
    } catch (err) {
      console.error("[stream-sw] Range request failed:", err);
      return new Response("Chunk fetch failed", { status: 502 });
    }
  }
  self.addEventListener("install", () => {
    self.skipWaiting();
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
  });
})();
