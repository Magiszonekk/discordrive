// DiscorDrive v4 — File chunker (streaming, browser-compatible)

import { config } from "@ddv4/config";

export async function* chunkFileStream(
  file: File | ReadableStream<Uint8Array>,
  chunkSize: number = config.defaultChunkSize,
): AsyncGenerator<{ index: number; data: Uint8Array }> {
  const stream =
    file instanceof ReadableStream ? file : (file as File).stream();
  const reader = stream.getReader();

  let buffer = new Uint8Array(chunkSize);
  let writeOffset = 0;
  let index = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      let readOffset = 0;
      while (readOffset < value.length) {
        const space = chunkSize - writeOffset;
        const toCopy = Math.min(space, value.length - readOffset);
        buffer.set(value.subarray(readOffset, readOffset + toCopy), writeOffset);
        writeOffset += toCopy;
        readOffset += toCopy;

        if (writeOffset === chunkSize) {
          yield { index, data: buffer };
          buffer = new Uint8Array(chunkSize);
          writeOffset = 0;
          index++;
        }
      }
    }

    // Yield remaining data as the last chunk
    if (writeOffset > 0) {
      yield { index, data: buffer.subarray(0, writeOffset) };
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
