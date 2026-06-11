import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { db } from "@ddv4/database";
import { createYoga } from "graphql-yoga";
import { buildSchema } from "../../schema.js";
import { initUpload, commitManifest } from "../../resolvers/files.js";
import { createShare, accessShare } from "../../resolvers/sharing.js";
import { handleBlobContent, handleBlobUpload } from "../../handlers/blob.js";

vi.mock("../../plugin-registry.js", () => ({
  pluginRegistry: {
    emitAsync: vi.fn().mockResolvedValue(undefined),
    getGraphqlExtensions: vi.fn().mockReturnValue({ typeDefs: [], resolvers: [] }),
  },
}));

const smokeSchema = buildSchema();
const yoga = createYoga({ schema: smokeSchema, graphqlEndpoint: "/graphql" });

type GraphqlResult<T> = { data?: T; errors?: Array<{ message: string }> };

type AuthPayload = {
  token: string;
  user: {
    id: string;
    email: string;
    username: string | null;
    crypto: {
      wrappedARKByPassword: string;
      wrappedARKByRecovery: string;
      argon2Params: {
        memoryKB: number;
        iterations: number;
        parallelism: number;
        saltB64: string;
      };
      lastPasswordChangeAt: string;
    };
  };
};

const smokeUser = {
  email: "core-v1-smoke@example.com",
  username: "core-v1-smoke",
};

const serverAuthProof = Buffer.from("core-v1-smoke-proof").toString("base64");

const bootstrap = {
  wrappedARKByPassword: Buffer.from("ark-password-smoke").toString("base64"),
  wrappedARKByRecovery: Buffer.from("ark-recovery-smoke").toString("base64"),
  argon2Params: {
    memoryKB: 65536,
    iterations: 3,
    parallelism: 1,
    saltB64: Buffer.from("smoke-salt").toString("base64"),
  },
  serverAuthProof,
};

const manifestBlobId = "manifest-derived-core-v1-smoke";
const ciphertext = new Uint8Array([11, 22, 33, 44, 55, 66]);
const capabilityToken = Buffer.from("core-v1-smoke-capability").toString("base64");
const wrappedAKShare = Buffer.from("wrapped-ak-share-smoke").toString("base64");
const wrappedFEK = Buffer.from("wrapped-fek-smoke").toString("base64");

async function resetSmokeFixtures() {
  await db.shareWrappedObjectKey.deleteMany({ where: { file: { ownerUserId: smokeUser.username } } }).catch(() => undefined);
  await db.grantedAccess.deleteMany({ where: { share: { ownerUserId: smokeUser.username } } }).catch(() => undefined);
  await db.share.deleteMany({ where: { ownerUserId: smokeUser.username } }).catch(() => undefined);
  await db.blobTransport.deleteMany({ where: { ownerUserId: smokeUser.username } }).catch(() => undefined);
  await db.file.deleteMany({ where: { ownerUserId: smokeUser.username } }).catch(() => undefined);
  await db.userCrypto.deleteMany({ where: { user: { email: smokeUser.email } } });
  await db.user.deleteMany({ where: { email: smokeUser.email } });
}

async function execGraphql<T>(query: string, variables?: Record<string, unknown>, token?: string): Promise<T> {
  const request = new Request("http://localhost/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const response = await yoga.fetch(request);
  const result = (await response.json()) as GraphqlResult<T>;
  expect(result.errors).toBeUndefined();
  expect(result.data).toBeDefined();
  return result.data as T;
}

describe("core v1 smoke flow", () => {
  let tempBlobRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempBlobRoot = await mkdtemp(path.join(os.tmpdir(), "ddv4-core-v1-smoke-"));
    process.env.DDV4_BLOB_ROOT_DIR = tempBlobRoot;
    delete process.env.BLOB_STORAGE_KIND;
    await resetSmokeFixtures();
  });

  afterEach(async () => {
    delete process.env.DDV4_BLOB_ROOT_DIR;
    delete process.env.BLOB_STORAGE_KIND;
    await rm(tempBlobRoot, { recursive: true, force: true });
  });

  it("runs register -> login -> initUpload -> blob upload -> commitManifest -> owner fetch -> share access", async () => {
    const registerData = await execGraphql<{ register: AuthPayload }>(
      /* GraphQL */ `
        mutation Register(
          $email: String!
          $username: String!
          $wrappedARKByPassword: String!
          $wrappedARKByRecovery: String!
          $argon2Params: Argon2ParamsInput!
          $serverAuthProof: String!
        ) {
          register(
            email: $email
            username: $username
            wrappedARKByPassword: $wrappedARKByPassword
            wrappedARKByRecovery: $wrappedARKByRecovery
            argon2Params: $argon2Params
            serverAuthProof: $serverAuthProof
          ) {
            token
            user {
              id
              email
              username
              crypto {
                wrappedARKByPassword
                wrappedARKByRecovery
                argon2Params {
                  memoryKB
                  iterations
                  parallelism
                  saltB64
                }
                lastPasswordChangeAt
              }
            }
          }
        }
      `,
      { ...smokeUser, ...bootstrap },
    );

    expect(registerData.register.user.email).toBe(smokeUser.email);
    expect(registerData.register.user.crypto.wrappedARKByPassword).toBe(bootstrap.wrappedARKByPassword);
    expect(registerData.register.user.crypto.wrappedARKByRecovery).toBe(bootstrap.wrappedARKByRecovery);
    expect(registerData.register.user.crypto.argon2Params).toEqual(bootstrap.argon2Params);

    const loginData = await execGraphql<{ login: AuthPayload }>(
      /* GraphQL */ `
        mutation Login($emailOrUsername: String!, $serverAuthProof: String!) {
          login(emailOrUsername: $emailOrUsername, serverAuthProof: $serverAuthProof) {
            token
            user {
              id
              email
              username
              crypto {
                wrappedARKByPassword
                wrappedARKByRecovery
                argon2Params {
                  memoryKB
                  iterations
                  parallelism
                  saltB64
                }
                lastPasswordChangeAt
              }
            }
          }
        }
      `,
      {
        emailOrUsername: smokeUser.email,
        serverAuthProof,
      },
    );

    expect(loginData.login.user.id).toBe(registerData.register.user.id);
    expect(loginData.login.user.crypto).toEqual(registerData.register.user.crypto);

    const ownerToken = loginData.login.token;
    const ownerUserId = loginData.login.user.id;

    const initUploadData = await initUpload(ownerUserId, {
      wrappedFEK,
      totalCiphertextBytes: ciphertext.byteLength.toString(),
      chunkCount: 1,
    });

    expect(initUploadData.status).toBe("uploading");

    const uploadResponse = await handleBlobUpload(
      new Request(`http://localhost/api/blob/${manifestBlobId}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${ownerToken}` },
        body: ciphertext,
      }),
      { blobId: manifestBlobId },
    );

    expect(uploadResponse.status).toBe(200);
    await expect(uploadResponse.json()).resolves.toMatchObject({
      blobId: manifestBlobId,
      ciphertextSizeBytes: ciphertext.byteLength.toString(),
    });

    const commitData = await commitManifest(
      ownerUserId,
      initUploadData.fileId,
      manifestBlobId,
      ciphertext.byteLength.toString(),
      1,
      [
        {
          blobId: manifestBlobId,
          storageKind: "LOCAL",
          storagePath: path.join(tempBlobRoot, manifestBlobId),
          ciphertextSizeBytes: ciphertext.byteLength.toString(),
        },
      ],
    );

    expect(commitData.success).toBe(true);

    const blobContentResponse = await handleBlobContent(
      new Request(`http://localhost/api/blob/${manifestBlobId}`, {
        method: "GET",
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
      { blobId: manifestBlobId },
    );

    expect(blobContentResponse.status).toBe(200);
    expect(new Uint8Array(await blobContentResponse.arrayBuffer())).toEqual(ciphertext);

    const createShareData = await createShare(ownerUserId, {
      fileId: initUploadData.fileId,
      capabilityToken,
      wrappedAKShare,
      wrappedFEK,
      allowContent: true,
      allowMetadata: false,
      allowPreview: false,
    });

    const accessShareData = await accessShare(createShareData.shareId, capabilityToken);

    expect(accessShareData).toEqual({
      shareId: createShareData.shareId,
      wrappedAKShare,
      allowContent: true,
      allowMetadata: false,
      allowPreview: false,
      wrappedObjectKeys: [
        {
          fileId: initUploadData.fileId,
          primaryManifestBlobId: manifestBlobId,
          wrappedFEK,
        },
      ],
    });
  });
});
