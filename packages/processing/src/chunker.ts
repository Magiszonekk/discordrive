// DiscorDrive v4 — File chunker (streaming, browser-compatible)

import { config } from "@ddv4/config";

export async function* chunkFileStream(
  file: File | ReadableStream<Uint8Array>,
  chunkSize: number = config.defaultChunkSize,
): AsyncGenerator<{ index: number; data: Uint8Array }> {
  const stream =
    file instanceof ReadableStream ? file : (file as File).stream();
  const reader = stream.getReader();

  let buffer = new Uint8Array(0);
  let index = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      // Append new data to buffer
      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;

      // Yield complete chunks
      while (buffer.length >= chunkSize) {
        yield { index, data: buffer.subarray(0, chunkSize) };
        buffer = buffer.subarray(chunkSize);
        index++;
      }
    }

    // Yield remaining data as the last chunk
    if (buffer.length > 0) {
      yield { index, data: buffer };
    }
  } finally {
    reader.releaseLock();
  }
}

export function calculateChunkCount(
  fileSize: number | bigint,
  chunkSize: number = config.defaultChunkSize,
): number {
  const size = typeof fileSize === "bigint" ? Number(fileSize) : fileSize;
  return Math.ceil(size / chunkSize);
}
