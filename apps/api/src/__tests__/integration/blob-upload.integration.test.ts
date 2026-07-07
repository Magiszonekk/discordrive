import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { signToken } from "../../middleware/auth.js";
import { clearDiscordBlobStore } from "../../storage/discord-blobs.js";

const blobTransport = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
};

const blobPlacement = {
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  createMany: vi.fn(),
};

vi.mock("@ddv4/database", () => ({
  db: {
    blobTransport,
    blobPlacement,
    // Array form only — the blob handlers pass a list of already-started ops
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  },
}));

vi.mock("@ddv4/discord-client", () => {
  const uploadChunk = vi.fn();
  const getChunkUrl = vi.fn();
  const downloadChunk = vi.fn();
  const parseWebhookUrls = vi.fn((urls: string[]) =>
    urls.map((url, index) => ({
      id: `wh-${index + 1}`,
      token: `token-${index + 1}`,
      url,
    })),
  );
  const WebhookRateLimiter = vi.fn(function WebhookRateLimiter(this: unknown) {
    return {
      waitForAvailable: vi.fn(async (webhookIds: string[]) => webhookIds[0]),
      recordResponse: vi.fn(),
      recordError: vi.fn(),
      canUse: vi.fn(() => true),
      getNextResetMs: vi.fn(() => 0),
      getStateSnapshot: vi.fn(() => ({ remaining: null, inFlight: null })),
    };
  });

  return {
    uploadChunk,
    getChunkUrl,
    downloadChunk,
    parseWebhookUrls,
    WebhookRateLimiter,
  };
});

async function withTempBlobRoot<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ddv4-api-blobs-"));
  const previous = process.env.DDV4_BLOB_ROOT_DIR;
  process.env.DDV4_BLOB_ROOT_DIR = rootDir;

  try {
    return await fn(rootDir);
  } finally {
    if (previous === undefined) {
      delete process.env.DDV4_BLOB_ROOT_DIR;
    } else {
      process.env.DDV4_BLOB_ROOT_DIR = previous;
    }
    delete process.env.BLOB_STORAGE_KIND;
    delete process.env.WEBHOOK_1;
    delete process.env.STORAGE_PRIMARY_PROVIDERS;
    delete process.env.STORAGE_REPLICA_PROVIDERS;
    await rm(rootDir, { recursive: true, force: true });
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("blob transport handlers", () => {
  beforeEach(async () => {
    const discordClient = await import("@ddv4/discord-client");
    const configServer = await import("@ddv4/config/server");
    blobTransport.findUnique.mockReset();
    blobTransport.upsert.mockReset();
    blobPlacement.upsert.mockReset();
    blobPlacement.deleteMany.mockReset();
    blobPlacement.createMany.mockReset();
    vi.mocked(discordClient.uploadChunk).mockReset();
    vi.mocked(discordClient.getChunkUrl).mockReset();
    vi.mocked(discordClient.downloadChunk).mockReset();
    vi.mocked(discordClient.parseWebhookUrls).mockClear();
    vi.mocked(discordClient.WebhookRateLimiter).mockClear();
    configServer.serverConfig.webhooks.length = 0;
    clearDiscordBlobStore();
    delete process.env.BLOB_STORAGE_KIND;
    delete process.env.WEBHOOK_1;
    // Loaded from the developer's real .env — must not leak into these tests
    delete process.env.STORAGE_PRIMARY_PROVIDERS;
    delete process.env.STORAGE_REPLICA_PROVIDERS;
  });

  afterEach(() => {
    delete process.env.DDV4_BLOB_ROOT_DIR;
    delete process.env.BLOB_STORAGE_KIND;
    delete process.env.WEBHOOK_1;
    delete process.env.STORAGE_PRIMARY_PROVIDERS;
    delete process.env.STORAGE_REPLICA_PROVIDERS;
    clearDiscordBlobStore();
  });

  it("rejects unauthenticated metadata access", async () => {
    await withTempBlobRoot(async () => {
      const { handleBlobMetadata } = await import("../../handlers/blob.js");
      const response = await handleBlobMetadata(
        new Request("http://localhost/api/blob/blob-1/meta", { method: "GET" }),
        { blobId: "blob-1" },
      );
      expect(response.status).toBe(401);
      expect(blobTransport.findUnique).not.toHaveBeenCalled();
    });
  });

  it("returns JSON metadata for the local blob metadata route", async () => {
    await withTempBlobRoot(async () => {
      blobTransport.findUnique.mockResolvedValue({
        blobId: "blob-meta",
        ownerUserId: "user-123",
        storageKind: "LOCAL",
        storagePath: path.join("/tmp", "blob-meta.bin"),
        discordMessageId: null,
        discordChannelId: null,
        webhookId: null,
        ciphertextSizeBytes: BigInt(42),
        ciphertextHash: "abc123",
        healthStatus: "healthy",
        healthCheckedAt: new Date("2026-04-28T09:00:00.000Z"),
        createdAt: new Date("2026-04-28T09:01:02.000Z"),
      });

      const { handleBlobMetadata } = await import("../../handlers/blob.js");
      const token = signToken({ userId: "user-123", email: "user@example.com" });
      const response = await handleBlobMetadata(
        new Request("http://localhost/api/blob/blob-meta/meta", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        { blobId: "blob-meta" },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        blobId: "blob-meta",
        ownerUserId: "user-123",
        storageKind: "LOCAL",
        storagePath: path.join("/tmp", "blob-meta.bin"),
        ciphertextSizeBytes: "42",
        ciphertextHash: "abc123",
        healthStatus: "healthy",
        healthCheckedAt: "2026-04-28T09:00:00.000Z",
        createdAt: "2026-04-28T09:01:02.000Z",
      });
    });
  });

  it("returns Discord transport metadata for the blob metadata route", async () => {
    await withTempBlobRoot(async () => {
      blobTransport.findUnique.mockResolvedValue({
        blobId: "blob-discord-meta",
        ownerUserId: "user-123",
        storageKind: "DISCORD",
        storagePath: "discord://attachments/blob-discord-meta",
        discordMessageId: "msg-123",
        discordChannelId: "chan-456",
        webhookId: "wh-789",
        ciphertextSizeBytes: BigInt(84),
        ciphertextHash: "def456",
        healthStatus: "healthy",
        healthCheckedAt: new Date("2026-04-29T09:00:00.000Z"),
        createdAt: new Date("2026-04-29T09:01:02.000Z"),
      });

      const { handleBlobMetadata } = await import("../../handlers/blob.js");
      const token = signToken({ userId: "user-123", email: "user@example.com" });
      const response = await handleBlobMetadata(
        new Request("http://localhost/api/blob/blob-discord-meta/meta", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        { blobId: "blob-discord-meta" },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        blobId: "blob-discord-meta",
        ownerUserId: "user-123",
        storageKind: "DISCORD",
        storagePath: "discord://attachments/blob-discord-meta",
        discordMessageId: "msg-123",
        discordChannelId: "chan-456",
        webhookId: "wh-789",
        ciphertextSizeBytes: "84",
        ciphertextHash: "def456",
        healthStatus: "healthy",
        healthCheckedAt: "2026-04-29T09:00:00.000Z",
        createdAt: "2026-04-29T09:01:02.000Z",
      });
    });
  });

  it("returns exact ciphertext bytes for the local blob content route", async () => {
    await withTempBlobRoot(async () => {
      const manifestProvidedBlobId = "manifest-derived-blob-local";
      const ciphertext = new Uint8Array([9, 8, 7, 6, 5, 4]);
      const expectedHash = sha256Hex(ciphertext);
      const token = signToken({ userId: "user-123", email: "user@example.com" });
      const { handleBlobContent } = await import("../../handlers/blob.js");
      const { writeCiphertextBlob } = await import("../../storage/local-blobs.js");
      const blobPath = await writeCiphertextBlob("user-123", manifestProvidedBlobId, ciphertext);

      blobTransport.findUnique.mockResolvedValue({
        blobId: manifestProvidedBlobId,
        ownerUserId: "user-123",
        storageKind: "LOCAL",
        storagePath: blobPath,
        discordMessageId: null,
        discordChannelId: null,
        webhookId: null,
        ciphertextSizeBytes: BigInt(ciphertext.byteLength),
        ciphertextHash: expectedHash,
        healthStatus: null,
        healthCheckedAt: null,
        createdAt: new Date("2026-04-28T09:01:02.000Z"),
      });

      const response = await handleBlobContent(
        new Request(`http://localhost/api/blob/${manifestProvidedBlobId}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        { blobId: manifestProvidedBlobId },
      );

      expect(blobTransport.findUnique).toHaveBeenCalledWith({
        where: { blobId: manifestProvidedBlobId },
        include: { placements: true },
      });
      expect(response.status).toBe(200);
      const body = new Uint8Array(await response.arrayBuffer());
      expect(Array.from(body)).toEqual(Array.from(ciphertext));
    });
  });

  it("returns exact ciphertext bytes for discord-backed blob content route", async () => {
    await withTempBlobRoot(async () => {
      const manifestProvidedBlobId = "manifest-derived-blob-discord";
      const ciphertext = new Uint8Array([6, 5, 4, 3, 2, 1]);
      const token = signToken({ userId: "user-123", email: "user@example.com" });
      process.env.BLOB_STORAGE_KIND = "DISCORD";
      const configServer = await import("@ddv4/config/server");
      configServer.serverConfig.webhooks.splice(0, configServer.serverConfig.webhooks.length, "https://discord.com/api/webhooks/123/token-1");

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(ciphertext);
          controller.close();
        },
      });
      const discordClient = await import("@ddv4/discord-client");
      vi.mocked(discordClient.downloadChunk).mockResolvedValue(stream);

      blobTransport.findUnique.mockResolvedValue({
        blobId: manifestProvidedBlobId,
        ownerUserId: "user-123",
        storageKind: "DISCORD",
        storagePath: "discord://attachments/blob-discord-content",
        discordMessageId: "msg-abc",
        discordChannelId: "chan-def",
        webhookId: "wh-1",
        ciphertextSizeBytes: BigInt(ciphertext.byteLength),
        ciphertextHash: sha256Hex(ciphertext),
        healthStatus: null,
        healthCheckedAt: null,
        createdAt: new Date("2026-04-29T09:01:02.000Z"),
      });

      const { handleBlobContent } = await import("../../handlers/blob.js");
      const response = await handleBlobContent(
        new Request(`http://localhost/api/blob/${manifestProvidedBlobId}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        { blobId: manifestProvidedBlobId },
      );

      expect(blobTransport.findUnique).toHaveBeenCalledWith({
        where: { blobId: manifestProvidedBlobId },
        include: { placements: true },
      });
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(ciphertext);
    });
  });

  it("returns 500 for invalid blob storage kind configuration", async () => {
    await withTempBlobRoot(async () => {
      const token = signToken({ userId: "user-123", email: "user@example.com" });
      process.env.BLOB_STORAGE_KIND = "BROKEN";
      const { handleBlobUpload } = await import("../../handlers/blob.js");
      const response = await handleBlobUpload(
        new Request("http://localhost/api/blob/blob-invalid-config", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
          body: new Uint8Array([1, 2, 3]),
        }),
        { blobId: "blob-invalid-config" },
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Unsupported BLOB_STORAGE_KIND: BROKEN" });
    });
  });

  it("returns 500 when discord transport is enabled without configured webhooks", async () => {
    await withTempBlobRoot(async () => {
      const token = signToken({ userId: "user-123", email: "user@example.com" });
      process.env.BLOB_STORAGE_KIND = "DISCORD";
      const configServer = await import("@ddv4/config/server");
      configServer.serverConfig.webhooks.length = 0;
      const { handleBlobUpload } = await import("../../handlers/blob.js");
      const response = await handleBlobUpload(
        new Request("http://localhost/api/blob/blob-missing-webhook", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
          body: new Uint8Array([4, 5, 6]),
        }),
        { blobId: "blob-missing-webhook" },
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Discord blob transport requires at least one configured webhook" });
    });
  });

  it("returns 500 when discord upload fails", async () => {
    await withTempBlobRoot(async () => {
      blobTransport.findUnique.mockResolvedValue(null);
      process.env.BLOB_STORAGE_KIND = "DISCORD";
      const configServer = await import("@ddv4/config/server");
      configServer.serverConfig.webhooks.splice(0, configServer.serverConfig.webhooks.length, "https://discord.com/api/webhooks/123/token-1");
      const discordClient = await import("@ddv4/discord-client");
      vi.mocked(discordClient.uploadChunk).mockRejectedValue(new Error("Discord upload failed hard"));
      const { handleBlobUpload } = await import("../../handlers/blob.js");
      const token = signToken({ userId: "user-123", email: "user@example.com" });
      const response = await handleBlobUpload(
        new Request("http://localhost/api/blob/blob-discord-fail", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
          body: new Uint8Array([7, 8, 9]),
        }),
        { blobId: "blob-discord-fail" },
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Discord upload failed hard" });
    });
  });

  it("rejects unauthenticated uploads", async () => {
    await withTempBlobRoot(async () => {
      const { handleBlobUpload } = await import("../../handlers/blob.js");
      const response = await handleBlobUpload(
        new Request("http://localhost/api/blob/blob-1", {
          method: "PUT",
          body: new Uint8Array([1, 2, 3]),
        }),
        { blobId: "blob-1" },
      );
      expect(response.status).toBe(401);
    });
  });

  it("saves ciphertext locally and upserts blob transport metadata", async () => {
    await withTempBlobRoot(async (rootDir) => {
      blobTransport.findUnique.mockResolvedValue(null);
      blobTransport.upsert.mockResolvedValue({});
      const { handleBlobUpload } = await import("../../handlers/blob.js");
      const token = signToken({ userId: "user-123", email: "user@example.com" });
      const ciphertext = new Uint8Array([9, 8, 7, 6, 5, 4]);
      const expectedHash = sha256Hex(ciphertext);
      const response = await handleBlobUpload(
        new Request("http://localhost/api/blob/blob-abc", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
          body: ciphertext,
        }),
        { blobId: "blob-abc" },
      );
      expect(response.status).toBe(200);
      expect(blobTransport.upsert).toHaveBeenCalledWith({
        where: { blobId: "blob-abc" },
        create: {
          blobId: "blob-abc",
          ownerUserId: "user-123",
          storageKind: "LOCAL",
          storagePath: path.resolve(rootDir, "user-123", "blob-abc.bin"),
          ciphertextSizeBytes: BigInt(ciphertext.byteLength),
          ciphertextHash: expectedHash,
        },
        update: {
          ownerUserId: "user-123",
          storageKind: "LOCAL",
          storagePath: path.resolve(rootDir, "user-123", "blob-abc.bin"),
          ciphertextSizeBytes: BigInt(ciphertext.byteLength),
          ciphertextHash: expectedHash,
          healthStatus: null,
          healthCheckedAt: null,
        },
      });
      expect(blobPlacement.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            blobId_provider_poolRole: {
              blobId: "blob-abc",
              provider: "LOCAL",
              poolRole: "PRIMARY",
            },
          },
          create: expect.objectContaining({
            blobId: "blob-abc",
            provider: "LOCAL",
            poolRole: "PRIMARY",
            status: "ACTIVE",
            storagePath: path.resolve(rootDir, "user-123", "blob-abc.bin"),
          }),
        }),
      );
    });
  });

  it("saves ciphertext via discord transport and upserts discord blob metadata", async () => {
    await withTempBlobRoot(async () => {
      blobTransport.findUnique.mockResolvedValue(null);
      blobTransport.upsert.mockResolvedValue({});
      process.env.BLOB_STORAGE_KIND = "DISCORD";
      const configServer = await import("@ddv4/config/server");
      configServer.serverConfig.webhooks.splice(0, configServer.serverConfig.webhooks.length, "https://discord.com/api/webhooks/123/token-1");
      const discordClient = await import("@ddv4/discord-client");
      vi.mocked(discordClient.uploadChunk).mockResolvedValue({
        messageId: "discord-message-blob-discord-upload",
        channelId: "discord-channel-user-123",
        transportPath: "direct",
        attemptCount: 1,
        upstreamStatus: 200,
        elapsedMs: 5,
        relayEgress: null,
      });
      const { handleBlobUpload } = await import("../../handlers/blob.js");
      const token = signToken({ userId: "user-123", email: "user@example.com" });
      const ciphertext = new Uint8Array([1, 3, 3, 7]);
      const expectedHash = sha256Hex(ciphertext);
      const response = await handleBlobUpload(
        new Request("http://localhost/api/blob/blob-discord-upload", {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
          body: ciphertext,
        }),
        { blobId: "blob-discord-upload" },
      );
      expect(response.status).toBe(200);
      expect(blobTransport.upsert).toHaveBeenCalledWith({
        where: { blobId: "blob-discord-upload" },
        create: {
          blobId: "blob-discord-upload",
          ownerUserId: "user-123",
          storageKind: "DISCORD",
          storagePath: "discord://attachments/blob-discord-upload",
          discordMessageId: "discord-message-blob-discord-upload",
          discordChannelId: "discord-channel-user-123",
          webhookId: "wh-1",
          ciphertextSizeBytes: BigInt(ciphertext.byteLength),
          ciphertextHash: expectedHash,
        },
        update: {
          ownerUserId: "user-123",
          storageKind: "DISCORD",
          storagePath: "discord://attachments/blob-discord-upload",
          discordMessageId: "discord-message-blob-discord-upload",
          discordChannelId: "discord-channel-user-123",
          webhookId: "wh-1",
          ciphertextSizeBytes: BigInt(ciphertext.byteLength),
          ciphertextHash: expectedHash,
          healthStatus: null,
          healthCheckedAt: null,
        },
      });
      expect(blobPlacement.deleteMany).toHaveBeenCalledWith({
        where: { blobId: "blob-discord-upload", poolRole: "PRIMARY", NOT: { provider: "DISCORD" } },
      });
      expect(blobPlacement.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            blobId_provider_poolRole: {
              blobId: "blob-discord-upload",
              provider: "DISCORD",
              poolRole: "PRIMARY",
            },
          },
          create: expect.objectContaining({
            status: "ACTIVE",
            storagePath: "discord://attachments/blob-discord-upload",
            messageId: "discord-message-blob-discord-upload",
            locationId: "discord-channel-user-123",
            senderId: "wh-1",
          }),
        }),
      );
    });
  });

  it("serves reads from an ACTIVE placement instead of legacy columns", async () => {
    await withTempBlobRoot(async () => {
      const ciphertext = new Uint8Array([42, 42, 42]);
      const token = signToken({ userId: "user-123", email: "user@example.com" });
      const { handleBlobContent } = await import("../../handlers/blob.js");
      const { writeCiphertextBlob } = await import("../../storage/local-blobs.js");
      const blobPath = await writeCiphertextBlob("user-123", "blob-placed", ciphertext);

      blobTransport.findUnique.mockResolvedValue({
        blobId: "blob-placed",
        ownerUserId: "user-123",
        // Legacy columns deliberately point at a broken location — the read
        // must come from the placement row instead.
        storageKind: "DISCORD",
        storagePath: "discord://attachments/blob-placed",
        discordMessageId: null,
        discordChannelId: null,
        webhookId: null,
        ciphertextSizeBytes: BigInt(ciphertext.byteLength),
        ciphertextHash: sha256Hex(ciphertext),
        healthStatus: null,
        healthCheckedAt: null,
        createdAt: new Date(),
        placements: [
          {
            provider: "LOCAL",
            poolRole: "PRIMARY",
            status: "ACTIVE",
            storagePath: blobPath,
            messageId: null,
            locationId: null,
            senderId: null,
          },
        ],
      });

      const response = await handleBlobContent(
        new Request("http://localhost/api/blob/blob-placed", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        { blobId: "blob-placed" },
      );

      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(ciphertext);
    });
  });
});
