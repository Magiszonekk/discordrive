import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@ddv4/database";
import { signToken } from "../../middleware/auth.js";

type StorageUsageResponse = {
  storageUsage?: {
    totalBytes: string;
    fileCount: number;
  };
};

type GraphQLErrorPayload = {
  message: string;
  extensions?: { code?: string };
};

const GQL_URL = "http://localhost:3000/graphql";
const testId = randomUUID().slice(0, 8);
const testEmail = `storage-${testId}@example.com`;
const testUsername = `storage_${testId}`;
let authToken = "";
let createdUserId = "";
let createdFileId = "";

async function gql<T>(query: string, token?: string): Promise<{ data?: T; errors?: GraphQLErrorPayload[] }> {
  const response = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query }),
  });

  return response.json() as Promise<{ data?: T; errors?: GraphQLErrorPayload[] }>;
}

describe("File resolvers", () => {
  beforeAll(async () => {
    const user = await db.user.create({
      data: {
        email: testEmail,
        username: testUsername,
        passwordHash: "not-used-in-test",
        kekSalt: "salt",
        wrapIv: "iv",
        encryptedMasterKey: "master",
      },
    });

    createdUserId = user.id;
    authToken = signToken({ userId: user.id, email: user.email });

    const file = await db.file.create({
      data: {
        userId: user.id,
        name: "fixture.bin",
        mimeType: "application/octet-stream",
        size: BigInt(1234),
        chunkSize: 512,
        chunkCount: 3,
        encryptedFEK: "encfek",
        fekIv: "fekiv",
        status: "READY",
      },
    });

    createdFileId = file.id;
  });

  afterAll(async () => {
    if (createdFileId) {
      await db.file.deleteMany({ where: { id: createdFileId } });
    }
    if (createdUserId) {
      await db.user.deleteMany({ where: { id: createdUserId } });
    }
  });

  it("storageUsage returns valid aggregate for authenticated user", async () => {
    const result = await gql<StorageUsageResponse>("{ storageUsage { totalBytes fileCount } }", authToken);
    expect(result.errors).toBeUndefined();
    expect(result.data?.storageUsage?.totalBytes).toBe("1234");
    expect(result.data?.storageUsage?.fileCount).toBe(1);
  });
});
