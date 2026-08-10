import { beforeEach, describe, expect, it } from "vitest";
import { createShare, accessShare, revokeShare } from "../../resolvers/sharing.js";
import { db } from "@ddv4/database";

const ownerUserId = "user_preview_contract";
const fileId = "file_preview_contract";

async function resetShareFixtures() {
  await db.shareWrappedObjectKey.deleteMany({ where: { fileId } });
  await db.grantedAccess.deleteMany({ where: { share: { ownerUserId } } });
  await db.share.deleteMany({ where: { ownerUserId } });
  await db.file.deleteMany({ where: { id: fileId } });
  await db.userCrypto.deleteMany({ where: { userId: ownerUserId } });
  await db.user.deleteMany({ where: { id: ownerUserId } });

  await db.user.create({
    data: {
      id: ownerUserId,
      email: "preview-contract@example.com",
      username: "preview-contract",
      crypto: {
        create: {
          wrappedARKByPassword: Buffer.from("pw"),
          wrappedARKByRecovery: Buffer.from("recovery"),
          argon2MemoryKB: 65536,
          argon2Iterations: 3,
          argon2Parallelism: 1,
          argon2SaltB64: "c2FsdA==",
        },
      },
    },
  });

  await db.file.create({
    data: {
      id: fileId,
      ownerUserId,
      primaryManifestBlobId: `${fileId}:manifest`,
      previewBlobId: `${fileId}:preview`,
      wrappedFEK: Buffer.from("wrapped-fek"),
      status: "READY",
      totalCiphertextBytes: BigInt(321),
      chunkCount: 1,
    },
  });
}

async function createDefaultShare(overrides: Partial<Parameters<typeof createShare>[1]> = {}) {
  const capabilityToken = Buffer.from(overrides.capabilityToken ?? "capability-token").toString("base64");

  const input = {
    fileId,
    capabilityToken,
    wrappedAKShare: Buffer.from("wrapped-ak").toString("base64"),
    wrappedFEK: Buffer.from("wrapped-share-fek").toString("base64"),
    allowContent: true,
    allowMetadata: false,
    allowPreview: true,
    expiresAt: undefined,
    maxViews: undefined,
    ...overrides,
  };

  const share = await createShare(ownerUserId, input);
  return { shareId: share.shareId, capabilityToken, input };
}

describe("share access core contract", () => {
  beforeEach(async () => {
    await resetShareFixtures();
  });

  it("returns only cryptographic share contract fields without UI heuristics", async () => {
    const { shareId, capabilityToken } = await createDefaultShare();

    const result = await accessShare(shareId, capabilityToken);

    expect(result).not.toBeNull();
    expect(result?.shareId).toBe(shareId);
    expect(result?.wrappedAKShare).toBe(Buffer.from("wrapped-ak").toString("base64"));
    expect(result?.allowContent).toBe(true);
    expect(result?.allowMetadata).toBe(false);
    expect(result?.allowPreview).toBe(true);
    expect(result?.wrappedObjectKeys).toEqual([
      {
        fileId,
        primaryManifestBlobId: `${fileId}:manifest`,
        previewBlobId: `${fileId}:preview`,
        wrappedFEK: Buffer.from("wrapped-share-fek").toString("base64"),
        wrappedFEKPreview: undefined,
        // Not permission-gated (transport shape, not content) — always present.
        totalCiphertextBytes: "321",
        chunkCount: 1,
      },
    ]);
  });

  it("denies access for revoked share", async () => {
    const { shareId, capabilityToken } = await createDefaultShare();

    await revokeShare(ownerUserId, shareId);

    await expect(accessShare(shareId, capabilityToken)).resolves.toBeNull();
  });

  it("denies access for expired share", async () => {
    const { shareId, capabilityToken } = await createDefaultShare({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await expect(accessShare(shareId, capabilityToken)).resolves.toBeNull();
  });

  it("denies access for capability mismatch", async () => {
    const { shareId } = await createDefaultShare();
    const wrongCapabilityToken = Buffer.from("wrong-capability-token").toString("base64");

    await expect(accessShare(shareId, wrongCapabilityToken)).resolves.toBeNull();
  });

  it("denies access after max views is reached", async () => {
    const { shareId, capabilityToken } = await createDefaultShare({ maxViews: 1 });

    await expect(accessShare(shareId, capabilityToken)).resolves.not.toBeNull();
    await expect(accessShare(shareId, capabilityToken)).resolves.toBeNull();
  });
});
