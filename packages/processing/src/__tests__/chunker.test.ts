import { describe, it, expect } from "vitest";
import { calculateChunkCount, chunkFileStream } from "../chunker.js";

describe("calculateChunkCount", () => {
  it("returns 1 for file smaller than chunk size", () => {
    expect(calculateChunkCount(100, 1000)).toBe(1);
  });

  it("returns exact count when divisible", () => {
    expect(calculateChunkCount(10000, 1000)).toBe(10);
  });

  it("rounds up for remainder", () => {
    expect(calculateChunkCount(1001, 1000)).toBe(2);
  });

  it("handles bigint file size", () => {
    expect(calculateChunkCount(BigInt(3000), 1000)).toBe(3);
  });

  it("returns 0 for empty file", () => {
    expect(calculateChunkCount(0, 1000)).toBe(0);
  });
});

describe("chunkFileStream", () => {
  function makeStream(data: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }

  it("yields single chunk when data fits in one chunk", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const chunks = [];
    for await (const chunk of chunkFileStream(makeStream(data), 10)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].data).toEqual(data);
  });

  it("splits data into multiple chunks", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const chunks = [];
    for await (const chunk of chunkFileStream(makeStream(data), 2)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(3);
    expect(chunks[0].data).toEqual(new Uint8Array([1, 2]));
    expect(chunks[1].data).toEqual(new Uint8Array([3, 4]));
    expect(chunks[2].data).toEqual(new Uint8Array([5]));
    expect(chunks[2].index).toBe(2);
  });

  it("yields nothing for empty stream", async () => {
    const emptyStream = new ReadableStream({
      start(controller) { controller.close(); },
    });
    const chunks = [];
    for await (const chunk of chunkFileStream(emptyStream, 10)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });
});
