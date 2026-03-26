// DiscorDrive v4 — Background SHA-256 hash worker
// Reads the file independently and computes the SHA-256 digest concurrently
// with the upload pipeline, so hashing never blocks chunk dispatch.

import { createSHA256 } from "hash-wasm";
import { config } from "@ddv4/config";

self.onmessage = async (e: MessageEvent) => {
  if (e.data.type !== "hash") return;

  const { file } = e.data as { file: File };
  const chunkSize = config.defaultChunkSize;
  const chunkCount = Math.ceil(file.size / chunkSize);

  try {
    const hasher = await createSHA256();
    hasher.init();

    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const data = new Uint8Array(await file.slice(start, end).arrayBuffer());
      hasher.update(data);
    }

    const sha256 = hasher.digest("hex");
    self.postMessage({ type: "done", sha256 });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err) });
  }
};
