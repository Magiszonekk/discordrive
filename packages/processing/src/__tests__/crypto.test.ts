import { describe, it, expect } from "vitest";
import {
  toBase64,
  fromBase64,
  generateSalt,
  randomBytes,
  generateFEK,
  encryptChunk,
  decryptChunk,
} from "../crypto.js";

describe("toBase64 / fromBase64", () => {
  it("round-trips a buffer through base64", () => {
    const original = new Uint8Array([1, 2, 3, 4, 255, 0, 128]);
    const b64 = toBase64(original);
    const back = fromBase64(b64);
    expect(back).toEqual(original);
  });

  it("toBase64 returns a string", () => {
    const b64 = toBase64(new Uint8Array([72, 101, 108, 108, 111]));
    expect(typeof b64).toBe("string");
    expect(b64).toBe("SGVsbG8=");
  });

  it("fromBase64 decodes known value", () => {
    const result = fromBase64("SGVsbG8=");
    expect(result).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
  });
});

describe("generateSalt / randomBytes", () => {
  it("generateSalt returns correct length", () => {
    const salt = generateSalt(16);
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(16);
  });

  it("randomBytes returns requested length", () => {
    const bytes = randomBytes(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });

  it("two random salts are different", () => {
    const a = generateSalt(16);
    const b = generateSalt(16);
    expect(a).not.toEqual(b);
  });
});

describe("encryptChunk / decryptChunk", () => {
  it("round-trips a chunk through encrypt/decrypt", async () => {
    const fek = await generateFEK();
    const plaintext = new TextEncoder().encode("Hello, world!").buffer as ArrayBuffer;
    const encrypted = await encryptChunk(plaintext, fek);
    const decrypted = await decryptChunk(encrypted, fek);
    expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(plaintext));
  });

  it("encrypted output is larger than plaintext (contains IV + auth tag)", async () => {
    const fek = await generateFEK();
    const plaintext = new Uint8Array(100).buffer as ArrayBuffer;
    const encrypted = await encryptChunk(plaintext, fek);
    // 12B IV + 16B auth tag overhead
    expect(encrypted.byteLength).toBe(100 + 12 + 16);
  });
});
