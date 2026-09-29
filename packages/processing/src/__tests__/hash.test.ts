import { describe, it, expect } from "vitest";
import { hashBuffer, hashStream } from "../hash.js";

describe("hashBuffer", () => {
  it("returns sha256 hex string for empty buffer", async () => {
    const result = await hashBuffer(new ArrayBuffer(0));
    // SHA-256 of empty string
    expect(result).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("returns correct sha256 for known input", async () => {
    const encoder = new TextEncoder();
    const data = encoder.encode("hello");
    const result = await hashBuffer(data.buffer as ArrayBuffer);
    expect(result).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("returns 64-character hex string", async () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = await hashBuffer(buf as ArrayBuffer);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });
});

describe("hashStream", () => {
  it("hashes a readable stream correctly", async () => {
    const encoder = new TextEncoder();
    const data = encoder.encode("hello");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    const result = await hashStream(stream);
    expect(result).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
