// DiscorDrive v4 — SHA-256 streaming hash (browser-compatible)

import { createSHA256 } from "hash-wasm";

export async function hashStream(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
  } finally {
    reader.releaseLock();
  }

  return hasher.digest("hex");
}

export async function hashFile(file: File): Promise<string> {
  return hashStream(file.stream());
}

export async function hashBuffer(buffer: ArrayBuffer): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  hasher.update(new Uint8Array(buffer));
  return hasher.digest("hex");
}
