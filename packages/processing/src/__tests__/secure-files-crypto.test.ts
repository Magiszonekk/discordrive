import { describe, it, expect } from "vitest";
import {
  toBase64,
  fromBase64,
  generateSalt,
  randomBytes,
  generateRootFEK,
  generateARK,
  generateDomainKey,
  deriveFileContentKey,
  deriveFileMetadataKey,
  deriveShareCapabilityToken,
  deriveShareAuthKey,
  deriveShareWrapKey,
  wrapARKWithPassword,
  unwrapARKWithPassword,
  wrapDomainKey,
  unwrapDomainKey,
  wrapKey,
  unwrapKey,
  exportKey,
  encryptChunk,
  decryptChunk,
  encryptFileMetadataPlaintext,
  decryptFileMetadataPlaintext,
  encryptFileManifestPlaintext,
  decryptFileManifestPlaintext,
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

describe("secure files key hierarchy", () => {
  it("wraps and unwraps ARK with password-derived KEK", async () => {
    const ark = await generateARK();
    const wrapped = await wrapARKWithPassword(ark, "secret-password", {
      memoryKB: 19456,
      iterations: 2,
      parallelism: 1,
      saltB64: toBase64(generateSalt(16)),
    });

    const unwrapped = await unwrapARKWithPassword(
      wrapped.wrappedARK,
      wrapped.iv,
      "secret-password",
      wrapped.params,
    );

    expect(new Uint8Array(await exportKey(unwrapped))).toEqual(new Uint8Array(await exportKey(ark)));
  });

  it("wraps and unwraps domain key with ARK", async () => {
    const ark = await generateARK();
    const domainKey = await generateDomainKey();
    const wrapped = await wrapDomainKey(domainKey, ark);
    const unwrapped = await unwrapDomainKey(wrapped.data, wrapped.iv, ark);

    expect(new Uint8Array(await exportKey(unwrapped))).toEqual(new Uint8Array(await exportKey(domainKey)));
  });

  it("derives distinct content and metadata keys from root FEK", async () => {
    const root = await generateRootFEK();
    const content = await deriveFileContentKey(root);
    const metadata = await deriveFileMetadataKey(root);

    expect(new Uint8Array(await exportKey(content))).not.toEqual(new Uint8Array(await exportKey(metadata)));
  });

  it("derives deterministic share keys and capability token from link secret", async () => {
    const linkSecret = randomBytes(32);
    const wrapKey1 = await deriveShareWrapKey(linkSecret);
    const wrapKey2 = await deriveShareWrapKey(linkSecret);
    const authKey = await deriveShareAuthKey(linkSecret);
    const token1 = await deriveShareCapabilityToken(authKey);
    const token2 = await deriveShareCapabilityToken(authKey);

    expect(new Uint8Array(await exportKey(wrapKey1))).toEqual(new Uint8Array(await exportKey(wrapKey2)));
    expect(token1).toEqual(token2);
  });

  it("fails unwrap with wrong parent key", async () => {
    const root = await generateRootFEK();
    const wrongRoot = await generateRootFEK();
    const child = await deriveFileContentKey(root);
    const wrapped = await wrapKey(child, root);

    await expect(unwrapKey(wrapped.data, wrongRoot, wrapped.iv, ["encrypt", "decrypt"])).rejects.toThrow();
  });
});

describe("encryptChunk / decryptChunk", () => {
  it("round-trips a chunk through encrypt/decrypt", async () => {
    const fek = await generateRootFEK();
    const contentKey = await deriveFileContentKey(fek);
    const plaintext = new TextEncoder().encode("Hello, world!").buffer as ArrayBuffer;
    const encrypted = await encryptChunk(plaintext, contentKey);
    const decrypted = await decryptChunk(encrypted, contentKey);
    expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(plaintext));
  });

  it("encrypted output is larger than plaintext (contains IV + auth tag)", async () => {
    const fek = await generateRootFEK();
    const contentKey = await deriveFileContentKey(fek);
    const plaintext = new Uint8Array(100).buffer as ArrayBuffer;
    const encrypted = await encryptChunk(plaintext, contentKey);
    expect(encrypted.byteLength).toBe(100 + 12 + 16);
  });
});

describe("secure files metadata + manifest encryption", () => {
  it("round-trips metadata payload with metadata subkey", async () => {
    const root = await generateRootFEK();
    const metadata = {
      schemaVersion: 1,
      fileName: "secret.txt",
      mimeType: "text/plain",
      plaintextSizeBytes: 42,
      tags: [],
      removedTags: [],
      favorite: false,
      hidden: false,
      scalarLWW: {},
    };

    const encrypted = await encryptFileMetadataPlaintext(metadata, root);
    const decrypted = await decryptFileMetadataPlaintext(encrypted, root);
    expect(decrypted).toEqual(metadata);
  });

  it("round-trips manifest payload with content subkey", async () => {
    const root = await generateRootFEK();
    const manifest = {
      schemaVersion: 1,
      chunkSizeBytes: 1024,
      chunks: [
        { index: 0, blobId: "blob-1", ciphertextSizeBytes: 1040, ciphertextHash: "abc" },
      ],
    };

    const encrypted = await encryptFileManifestPlaintext(manifest, root);
    const decrypted = await decryptFileManifestPlaintext(encrypted, root);
    expect(decrypted).toEqual(manifest);
  });
});
