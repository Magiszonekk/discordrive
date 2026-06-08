import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@ddv4/database";
import { buildSchema } from "../../schema.js";

vi.mock("../../plugin-registry.js", () => ({
  pluginRegistry: {
    emitAsync: vi.fn().mockResolvedValue(undefined),
    getGraphqlExtensions: vi.fn().mockReturnValue({ typeDefs: [], resolvers: [] }),
  },
}));

const { initUpload, commitManifest } = await import("../../resolvers/files.js");
const { pluginRegistry } = await import("../../plugin-registry.js");

const ownerUserId = "user_files_lifecycle";
const otherUserId = "user_files_lifecycle_other";
const folderId = "folder_files_lifecycle";

async function resetFixtures() {
  await db.blobTransport.deleteMany({ where: { ownerUserId: { in: [ownerUserId, otherUserId] } } });
  await db.file.deleteMany({ where: { ownerUserId: { in: [ownerUserId, otherUserId] } } });
  await db.folder.deleteMany({ where: { ownerUserId: { in: [ownerUserId, otherUserId] } } });
  await db.userCrypto.deleteMany({ where: { userId: { in: [ownerUserId, otherUserId] } } });
  await db.user.deleteMany({ where: { id: { in: [ownerUserId, otherUserId] } } });

  for (const userId of [ownerUserId, otherUserId]) {
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@example.com`,
        username: userId,
        crypto: {
          create: {
            wrappedARKByPassword: Buffer.from(`pw-${userId}`),
            wrappedARKByRecovery: Buffer.from(`recovery-${userId}`),
            argon2MemoryKB: 65536,
            argon2Iterations: 3,
            argon2Parallelism: 1,
            argon2SaltB64: "c2FsdA==",
          },
        },
      },
    });
  }

  await db.folder.create({
    data: {
      id: folderId,
      ownerUserId,
      encryptedBody: Buffer.from("folder-body"),
      wrappedFolderKey: Buffer.from("folder-key"),
    },
  });
}

describe("secure file lifecycle", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetFixtures();
  });

  it("exposes plaintext filename and mimeType in the initUpload GraphQL contract", async () => {
    const schema = buildSchema();
    const mutationType = schema.getMutationType();
    const initUploadField = mutationType?.getFields().initUpload;

    expect(initUploadField).toBeDefined();
    expect(initUploadField?.args.map((arg) => arg.name)).toEqual([
      "parentFolderId",
      "name",
      "mimeType",
      "dedupeTokenB64",
      "wrappedFEK",
      "wrappedFEKPreview",
      "totalCiphertextBytes",
      "chunkCount",
    ]);
    expect(initUploadField?.args.some((arg) => arg.name === "name")).toBe(true);
    expect(initUploadField?.args.some((arg) => arg.name === "mimeType")).toBe(true);
  });

  it("initUpload requires plaintext filename and mimeType in the resolver input", async () => {
    await expect(() =>
      initUpload(ownerUserId, {
        parentFolderId: folderId,
        dedupeTokenB64: "ZGVkdXBlLXRva2Vu",
        wrappedFEK: Buffer.from("wrapped-fek").toString("base64"),
        wrappedFEKPreview: Buffer.from("wrapped-fek-preview").toString("base64"),
        totalCiphertextBytes: "12345",
        chunkCount: 7,
      }),
    ).rejects.toThrow("Missing file name or mimeType during initUpload");
  });

  it("initUpload creates an UPLOADING file with no manifest blob and preserves encrypted fields", async () => {
    const input = {
      parentFolderId: folderId,
      name: "example.mp4",
      mimeType: "video/mp4",
      dedupeTokenB64: "ZGVkdXBlLXRva2Vu",
      wrappedFEK: Buffer.from("wrapped-fek").toString("base64"),
      wrappedFEKPreview: Buffer.from("wrapped-fek-preview").toString("base64"),
      totalCiphertextBytes: "12345",
      chunkCount: 7,
    };

    const result = await initUpload(ownerUserId, input);
    const saved = await db.file.findUniqueOrThrow({ where: { id: result.fileId } });

    expect(result).toEqual({ fileId: result.fileId, status: "uploading" });
    expect(saved.ownerUserId).toBe(ownerUserId);
    expect(saved.parentFolderId).toBe(folderId);
    expect(saved.primaryManifestBlobId).toBeNull();
    expect(saved.previewBlobId).toBeNull();
    expect(saved.status).toBe("UPLOADING");
    expect(saved.totalCiphertextBytes.toString()).toBe("12345");
    expect(saved.chunkCount).toBe(7);
    expect(saved.dedupeTokenB64).toBe("ZGVkdXBlLXRva2Vu");
    expect(Buffer.from(saved.wrappedFEK).toString("base64")).toBe(input.wrappedFEK);
    expect(Buffer.from(saved.wrappedFEKPreview!).toString("base64")).toBe(input.wrappedFEKPreview);
  });

  it("commitManifest sets manifest blob and moves file from UPLOADING to READY", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      name: "manifest-test-1.bin",
      mimeType: "application/octet-stream",
      wrappedFEK: Buffer.from("wrapped-fek").toString("base64"),
      totalCiphertextBytes: "100",
      chunkCount: 2,
    });

    await db.blobTransport.create({
      data: {
        blobId: "manifest-blob-1",
        ownerUserId,
        storageKind: "LOCAL",
        storagePath: "/tmp/manifest-blob-1",
        ciphertextSizeBytes: BigInt(100),
      },
    });

    await expect(commitManifest(ownerUserId, fileId, "manifest-blob-1", "100", 2)).resolves.toEqual({ success: true });

    const saved = await db.file.findUniqueOrThrow({ where: { id: fileId } });
    expect(saved.primaryManifestBlobId).toBe("manifest-blob-1");
    expect(saved.status).toBe("READY");
    expect(saved.totalCiphertextBytes.toString()).toBe("100");
    expect(saved.chunkCount).toBe(2);
    expect(pluginRegistry.emitAsync).toHaveBeenCalledWith("file:uploaded", {
      fileId,
      userId: ownerUserId,
      mimeType: "application/octet-stream",
      size: BigInt(100),
      sha256: "manifest-blob-1",
    });
  });

  it("commitManifest rejects files that are no longer in UPLOADING state", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      name: "manifest-test-1.bin",
      mimeType: "application/octet-stream",
      wrappedFEK: Buffer.from("wrapped-fek").toString("base64"),
      totalCiphertextBytes: "100",
      chunkCount: 2,
    });

    await db.blobTransport.create({
      data: {
        blobId: "manifest-blob-2",
        ownerUserId,
        storageKind: "LOCAL",
        storagePath: "/tmp/manifest-blob-2",
        ciphertextSizeBytes: BigInt(100),
      },
    });

    await commitManifest(ownerUserId, fileId, "manifest-blob-2", "100", 2);

    await expect(commitManifest(ownerUserId, fileId, "manifest-blob-2", "100", 2)).rejects.toThrow(
      "File is not in UPLOADING state",
    );
  });

  it("commitManifest rejects manifest blobs that do not belong to the owner", async () => {
    const { fileId } = await initUpload(ownerUserId, {
      name: "manifest-test-1.bin",
      mimeType: "application/octet-stream",
      wrappedFEK: Buffer.from("wrapped-fek").toString("base64"),
      totalCiphertextBytes: "100",
      chunkCount: 2,
    });

    await db.blobTransport.create({
      data: {
        blobId: "manifest-blob-foreign",
        ownerUserId: otherUserId,
        storageKind: "LOCAL",
        storagePath: "/tmp/manifest-blob-foreign",
        ciphertextSizeBytes: BigInt(100),
      },
    });

    await expect(commitManifest(ownerUserId, fileId, "manifest-blob-foreign", "100", 2)).rejects.toThrow(
      "Manifest blob not found",
    );

    const saved = await db.file.findUniqueOrThrow({ where: { id: fileId } });
    expect(saved.primaryManifestBlobId).toBeNull();
    expect(saved.status).toBe("UPLOADING");
  });
});
