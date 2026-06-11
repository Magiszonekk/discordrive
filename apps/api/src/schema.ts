// DiscorDrive v4 — GraphQL Schema (secure files v2)

import { createSchema } from "graphql-yoga";
import { verifyToken, isBackendOnly, getSystemUserId, type AuthPayload } from "./middleware/auth.js";
import { enforceRateLimit } from "./middleware/rate-limit.js";
import { serverConfig } from "@ddv4/config/server";
import * as authResolvers from "./resolvers/auth.js";
import * as fileResolvers from "./resolvers/files.js";
import * as folderResolvers from "./resolvers/folders.js";
import * as sharingResolvers from "./resolvers/sharing.js";
import { pluginRegistry } from "./plugin-registry.js";

export interface Context {
  auth: AuthPayload | null;
  ip: string;
}

function requireAuth(ctx: Context): AuthPayload {
  if (!ctx.auth) throw new Error("Authentication required");
  return ctx.auth;
}

function requireFullMode(): void {
  if (isBackendOnly()) throw new Error("Not available in backend-only mode");
}

function mergeResolvers(
  ...maps: Record<string, unknown>[]
): Parameters<typeof createSchema<Context>>[0]["resolvers"] {
  return maps.reduce(
    (acc, cur) => {
      for (const [k, v] of Object.entries(cur)) {
        acc[k] =
          v !== null && typeof v === "object" && !Array.isArray(v) && typeof acc[k] === "object" && acc[k] !== null
            ? { ...(acc[k] as object), ...(v as object) }
            : v;
      }
      return acc;
    },
    {} as Record<string, unknown>,
  ) as Parameters<typeof createSchema<Context>>[0]["resolvers"];
}

export function buildSchema() {
  const { typeDefs: pluginTypeDefs, resolvers: pluginResolvers } = pluginRegistry.getGraphqlExtensions();

  return createSchema<Context>({
    typeDefs: [/* GraphQL */ `
      scalar DateTime
      scalar Float

      type Argon2Params {
        memoryKB: Int!
        iterations: Int!
        parallelism: Int!
        saltB64: String!
      }

      type UserCrypto {
        wrappedARKByPassword: String!
        wrappedARKByRecovery: String!
        argon2Params: Argon2Params!
        lastPasswordChangeAt: DateTime!
      }

      type User {
        id: ID!
        email: String!
        username: String
        crypto: UserCrypto!
      }

      type AuthResponse {
        token: String!
        user: User!
      }

      type LoginChallenge {
        argon2Params: Argon2Params!
      }

      type File {
        id: ID!
        parentFolderId: ID
        encryptedName: String
        encryptedMimeType: String
        primaryManifestBlobId: String
        wrappedFEK: String!
        status: String!
        totalCiphertextBytes: String!
        chunkCount: Int!
        createdAt: DateTime!
        updatedAt: DateTime!
        deletedAt: DateTime
      }

      type Folder {
        id: ID!
        parentFolderId: ID
        encryptedBody: String!
        wrappedFolderKey: String!
        itemCount: Int!
        totalSizeBytes: String!
        createdAt: DateTime!
        updatedAt: DateTime!
      }

      type ShareObjectKey {
        fileId: ID!
        primaryManifestBlobId: String
        encryptedName: String
        encryptedMimeType: String
        wrappedFEK: String
      }

      type ShareAccess {
        shareId: ID!
        wrappedAKShare: String!
        wrappedObjectKeys: [ShareObjectKey!]!
        allowContent: Boolean!
      }

      type SecureShare {
        shareId: ID!
        shareType: String!
        allowContent: Boolean!
        allowMetadata: Boolean!
        allowPreview: Boolean!
        status: String!
        expiresAt: DateTime
        maxViews: Int
        viewCount: Int!
        createdAt: DateTime!
      }

      type InitUploadResult {
        fileId: ID!
        status: String!
      }

      type CommitManifestResult {
        success: Boolean!
      }

      input UploadedBlobTransportInput {
        blobId: String!
        storageKind: String!
        storagePath: String!
        ciphertextSizeBytes: String!
        ciphertextHash: String
        discordMessageId: String
        discordChannelId: String
        webhookId: String
      }

      type StorageUsage {
        totalBytes: String!
        fileCount: Int!
      }

      type HealthCheckChunk {
        id: ID!
        index: Int!
        messageId: String!
        webhookId: String!
        size: Int!
        encryptedHash: String
        healthStatus: String
        healthCheckedAt: DateTime
      }

      type HealthCheckFile {
        fileId: ID!
        fileName: String!
        chunkCount: Int!
        chunks: [HealthCheckChunk!]!
      }

      type HealthCheckSummary {
        checked: Int!
        healthy: Int!
        missing: Int!
        modified: Int!
        skipped: Int!
        durationMs: Int!
      }

      input ChunkHealthUpdateInput {
        chunkId: ID!
        status: String!
      }

      input Argon2ParamsInput {
        memoryKB: Int!
        iterations: Int!
        parallelism: Int!
        saltB64: String!
      }

      type Query {
        me: User
        getLoginChallenge(emailOrUsername: String!): LoginChallenge
        files(parentFolderId: ID): [File!]!
        folders(parentFolderId: ID): [Folder!]!
        folderPath(folderId: ID!): [Folder!]!
        file(fileId: ID!): File
        shares(fileId: ID!): [SecureShare!]!
        storageUsage: StorageUsage!
        accessShare(shareId: ID!, capabilityToken: String!): ShareAccess
        filesForHealthCheck(samplePercent: Float, fileId: ID): [HealthCheckFile!]!
      }

      type Mutation {
        register(
          email: String!
          username: String!
          wrappedARKByPassword: String!
          wrappedARKByRecovery: String!
          argon2Params: Argon2ParamsInput!
          serverAuthProof: String!
        ): AuthResponse!

        login(emailOrUsername: String!, serverAuthProof: String!): AuthResponse!

        changePassword(
          currentServerAuthProof: String!
          wrappedARKByPassword: String!
          argon2Params: Argon2ParamsInput!
          serverAuthProof: String!
        ): Boolean!

        initUpload(
          parentFolderId: ID
          encryptedName: String
          encryptedMimeType: String
          wrappedFEK: String!
          totalCiphertextBytes: String!
          chunkCount: Int!
        ): InitUploadResult!

        commitManifest(
          fileId: ID!
          manifestBlobId: String!
          totalCiphertextBytes: String!
          chunkCount: Int!
          blobs: [UploadedBlobTransportInput!]!
        ): CommitManifestResult!

        deleteFile(fileId: ID!): Boolean!
        moveFile(fileId: ID!, parentFolderId: ID): Boolean!

        createFolder(encryptedBodyB64: String!, wrappedFolderKeyB64: String!, parentFolderId: ID): Folder!
        renameFolder(folderId: ID!, encryptedBodyB64: String!): Boolean!
        moveFolder(folderId: ID!, parentFolderId: ID): Boolean!
        deleteFolder(folderId: ID!): Boolean!

        createShare(
          fileId: ID!
          capabilityToken: String!
          wrappedAKShare: String!
          wrappedFEK: String
          allowContent: Boolean!
          expiresAt: String
          maxViews: Int
        ): SecureShare!

        revokeShare(shareId: ID!): Boolean!
        updateChunkHealthBatch(updates: [ChunkHealthUpdateInput!]!): Boolean!
        runHealthCheck(mode: String!, samplePercent: Float, fileId: ID): HealthCheckSummary!
      }
    `, ...pluginTypeDefs],
    resolvers: mergeResolvers({
      DateTime: {
        serialize: (value: unknown) => (value instanceof Date ? value.toISOString() : value),
        parseValue: (value: unknown) => new Date(value as string),
      },
      File: {
        totalCiphertextBytes: (parent: { totalCiphertextBytes: bigint | string }) => parent.totalCiphertextBytes.toString(),
        wrappedFEK: (parent: { wrappedFEK: Uint8Array | Buffer }) => Buffer.from(parent.wrappedFEK).toString("base64"),
      },
      Folder: {
        encryptedBody: (parent: { encryptedBody: Uint8Array | Buffer }) => Buffer.from(parent.encryptedBody).toString("base64"),
        wrappedFolderKey: (parent: { wrappedFolderKey: Uint8Array | Buffer }) => Buffer.from(parent.wrappedFolderKey).toString("base64"),
        totalSizeBytes: (parent: { totalSizeBytes?: string }) => parent.totalSizeBytes ?? "0",
      },
      Query: {
        getLoginChallenge: async (_parent: unknown, args: { emailOrUsername: string }, ctx: Context) => {
          requireFullMode();
          enforceRateLimit(ctx.ip, "auth");
          return authResolvers.getLoginChallenge(args.emailOrUsername);
        },
        me: async (_parent: unknown, _args: unknown, ctx: Context) => {
          requireFullMode();
          const auth = requireAuth(ctx);
          const { db } = await import("@ddv4/database");
          const user = await db.user.findUnique({ where: { id: auth.userId }, include: { crypto: true } });
          if (!user || !user.crypto) return null;
          return {
            id: user.id,
            email: user.email,
            username: user.username,
            crypto: {
              wrappedARKByPassword: Buffer.from(user.crypto.wrappedARKByPassword).toString("base64"),
              wrappedARKByRecovery: Buffer.from(user.crypto.wrappedARKByRecovery).toString("base64"),
              argon2Params: {
                memoryKB: user.crypto.argon2MemoryKB,
                iterations: user.crypto.argon2Iterations,
                parallelism: user.crypto.argon2Parallelism,
                saltB64: user.crypto.argon2SaltB64,
              },
              lastPasswordChangeAt: user.crypto.lastPasswordChangeAt,
            },
          };
        },
        files: async (_parent: unknown, args: { parentFolderId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.getFiles(auth.userId, args.parentFolderId ?? null);
        },
        folders: async (_parent: unknown, args: { parentFolderId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.getFolders(auth.userId, args.parentFolderId ?? null);
        },
        folderPath: async (_parent: unknown, args: { folderId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.getFolderPath(auth.userId, args.folderId);
        },
        file: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.getFile(auth.userId, args.fileId);
        },
        shares: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return sharingResolvers.getShares(auth.userId, args.fileId);
        },
        storageUsage: async (_parent: unknown, _args: unknown, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.getStorageUsage(auth.userId);
        },
        filesForHealthCheck: async (_parent: unknown, _args: unknown, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.getFilesForHealthCheckDisplay(auth.userId);
        },
        accessShare: async (_parent: unknown, args: { shareId: string; capabilityToken: string }, ctx: Context) => {
          enforceRateLimit(ctx.ip, "auth");
          return sharingResolvers.accessShare(args.shareId, args.capabilityToken);
        },
      },
      Mutation: {
        register: async (_parent: unknown, args: {
          email: string;
          username: string;
          wrappedARKByPassword: string;
          wrappedARKByRecovery: string;
          argon2Params: { memoryKB: number; iterations: number; parallelism: number; saltB64: string };
          serverAuthProof: string;
        }, ctx: Context) => {
          requireFullMode();
          enforceRateLimit(ctx.ip, "auth");
          return authResolvers.register(args);
        },
        login: async (_parent: unknown, args: { emailOrUsername: string; serverAuthProof: string }, ctx: Context) => {
          requireFullMode();
          enforceRateLimit(ctx.ip, "auth");
          return authResolvers.login(args.emailOrUsername, args.serverAuthProof);
        },
        changePassword: async (_parent: unknown, args: {
          currentServerAuthProof: string;
          wrappedARKByPassword: string;
          argon2Params: { memoryKB: number; iterations: number; parallelism: number; saltB64: string };
          serverAuthProof: string;
        }, ctx: Context) => {
          requireFullMode();
          enforceRateLimit(ctx.ip, "auth");
          const auth = requireAuth(ctx);
          return authResolvers.changePassword(auth.userId, args.currentServerAuthProof, args.wrappedARKByPassword, args.argon2Params, args.serverAuthProof);
        },
        initUpload: async (_parent: unknown, args: {
          parentFolderId?: string;
          encryptedName?: string;
          encryptedMimeType?: string;
          wrappedFEK: string;
          totalCiphertextBytes: string;
          chunkCount: number;
        }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.initUpload(auth.userId, args);
        },
        commitManifest: async (_parent: unknown, args: {
          fileId: string;
          manifestBlobId: string;
          totalCiphertextBytes: string;
          chunkCount: number;
          blobs: Array<{
            blobId: string;
            storageKind: "LOCAL" | "DISCORD";
            storagePath: string;
            ciphertextSizeBytes: string;
            ciphertextHash?: string;
            discordMessageId?: string;
            discordChannelId?: string;
            webhookId?: string;
          }>;
        }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.commitManifest(auth.userId, args.fileId, args.manifestBlobId, args.totalCiphertextBytes, args.chunkCount, args.blobs);
        },
        deleteFile: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.deleteFile(auth.userId, args.fileId);
        },
        moveFile: async (_parent: unknown, args: { fileId: string; parentFolderId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.moveFile(auth.userId, args.fileId, args.parentFolderId ?? null);
        },
        createFolder: async (_parent: unknown, args: { encryptedBodyB64: string; wrappedFolderKeyB64: string; parentFolderId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.createFolder(auth.userId, args.encryptedBodyB64, args.wrappedFolderKeyB64, args.parentFolderId ?? null);
        },
        renameFolder: async (_parent: unknown, args: { folderId: string; encryptedBodyB64: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.renameFolder(auth.userId, args.folderId, args.encryptedBodyB64);
        },
        moveFolder: async (_parent: unknown, args: { folderId: string; parentFolderId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.moveFolder(auth.userId, args.folderId, args.parentFolderId ?? null);
        },
        deleteFolder: async (_parent: unknown, args: { folderId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return folderResolvers.deleteFolder(auth.userId, args.folderId);
        },
        createShare: async (_parent: unknown, args: {
          fileId: string;
          capabilityToken: string;
          wrappedAKShare: string;
          wrappedFEK?: string;
          allowContent: boolean;
          expiresAt?: string;
          maxViews?: number;
        }, ctx: Context) => {
          const auth = requireAuth(ctx);
          const result = await sharingResolvers.createShare(auth.userId, { ...args, allowMetadata: false, allowPreview: false });
          const shares = await sharingResolvers.getShares(auth.userId, args.fileId);
          return shares.find((share) => share.shareId === result.shareId)!;
        },
        updateChunkHealthBatch: async (_parent: unknown, args: { updates: Array<{ chunkId: string; status: string }> }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.updateChunkHealthBatch(auth.userId, args.updates as Array<{ chunkId: string; status: "HEALTHY" | "MISSING" | "MODIFIED" }>);
        },
        runHealthCheck: async (_parent: unknown, args: { mode: string; samplePercent?: number; fileId?: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return fileResolvers.runHealthCheck(auth.userId, args.mode, args.samplePercent ?? null, args.fileId ?? null);
        },
        revokeShare: async (_parent: unknown, args: { shareId: string }, ctx: Context) => {
          const auth = requireAuth(ctx);
          return sharingResolvers.revokeShare(auth.userId, args.shareId);
        },
      },
    }, ...pluginResolvers),
  });
}

export async function createContext(request: Request): Promise<Context> {
  let auth: AuthPayload | null = null;
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ?? "unknown";

  if (isBackendOnly()) {
    const apiKey = request.headers.get("x-api-key");
    if (!serverConfig.apiKey || apiKey === serverConfig.apiKey) {
      const userId = await getSystemUserId();
      auth = { userId, email: "system@ddv4.local" };
    }
  } else {
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        auth = verifyToken(authHeader.slice(7));
      } catch (error) {
        console.warn(JSON.stringify({
          ts: new Date().toISOString(),
          scope: "graphql-auth-debug",
          type: "jwt_verify_failed",
          hasAuthorizationHeader: Boolean(authHeader),
          bearerPrefixPresent: authHeader.startsWith("Bearer "),
          tokenLength: authHeader.length - 7,
          error: error instanceof Error ? error.message : String(error),
        }));
        auth = null;
      }
    }
  }

  return { auth, ip };
}
