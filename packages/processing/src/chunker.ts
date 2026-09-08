// DiscorDrive v4 — File chunker (streaming, browser-compatible)

import { config } from "@ddv4/config";

export async function* chunkFileStream(
  file: File | ReadableStream<Uint8Array>,
  chunkSize: number = config.defaultChunkSize,
): AsyncGenerator<{ index: number; data: Uint8Array }> {
  const stream =
    file instanceof ReadableStream ? file : (file as File).stream();
  const reader = stream.getReader();

  // Fixed-size accumulator, filled in place. The previous implementation grew a
  // single buffer with `new Uint8Array(len + value.length)` + two `set()` calls
  // on *every* read from the stream, so each ~64 KiB read re-copied everything
  // buffered so far. That is O(n^2) in reads per chunk: measured ~64x write
  // amplification (a 55 GiB upload allocated and copied ~3.5 TiB) and it kept
  // the GC under constant pressure for the whole transfer. Filling a
  // chunk-sized buffer at a known offset copies each byte exactly once.
  //
  // Each yielded chunk gets its own buffer: callers such as the browser E2E
  // benchmark collect chunks into an array, so reusing one buffer across
  // iterations would silently alias every collected chunk to the same bytes.
  let acc = new Uint8Array(chunkSize);
  let accLen = 0;
  let index = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      let offset = 0;
      while (offset < value.length) {
        const take = Math.min(chunkSize - accLen, value.length - offset);
        acc.set(value.subarray(offset, offset + take), accLen);
        accLen += take;
        offset += take;

        if (accLen === chunkSize) {
          yield { index, data: acc };
          acc = new Uint8Array(chunkSize);
          accLen = 0;
          index++;
        }
      }
    }

    // Yield remaining data as the last chunk. Sliced, not subarray'd: a view
    // would pin the whole chunk-sized buffer for a possibly tiny tail.
    if (accLen > 0) {
      yield { index, data: acc.slice(0, accLen) };
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
