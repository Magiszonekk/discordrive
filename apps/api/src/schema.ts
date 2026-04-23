// DiscorDrive v4 — GraphQL Schema

import { createSchema } from "graphql-yoga";
import { verifyToken, isBackendOnly, getSystemUserId, type AuthPayload } from "./middleware/auth.js";
import { serverConfig } from "@ddv4/config/server";
import * as authResolvers from "./resolvers/auth.js";
import * as fileResolvers from "./resolvers/files.js";
import * as folderResolvers from "./resolvers/folders.js";
import * as sharingResolvers from "./resolvers/sharing.js";
import * as healthResolvers from "./resolvers/health.js";
import { pluginRegistry } from "./plugin-registry.js";

export interface Context {
  auth: AuthPayload | null;
}

function requireAuth(ctx: Context): AuthPayload {
  if (!ctx.auth) throw new Error("Authentication required");
  return ctx.auth;
}

function requireFullMode(): void {
  if (isBackendOnly()) throw new Error("Not available in backend-only mode");
}

/** Deep-merge resolver maps without extra dependencies. */
function mergeResolvers(
  ...maps: Record<string, unknown>[]
): Parameters<typeof createSchema<Context>>[0]["resolvers"] {
  return maps.reduce(
    (acc, cur) => {
      for (const [k, v] of Object.entries(cur)) {
        acc[k] =
          v !== null &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          typeof acc[k] === "object" &&
          acc[k] !== null
            ? { ...(acc[k] as object), ...(v as object) }
            : v;
      }
      return acc;
    },
    {} as Record<string, unknown>,
  ) as Parameters<typeof createSchema<Context>>[0]["resolvers"];
}

/**
 * Build the GraphQL schema, merging in any extensions registered by plugins.
 * Must be called after pluginRegistry.load().
 */
export function buildSchema() {
  const { typeDefs: pluginTypeDefs, resolvers: pluginResolvers } =
    pluginRegistry.getGraphqlExtensions();

  return createSchema<Context>({
  typeDefs: [/* GraphQL */ `
    scalar BigInt
    scalar DateTime

    type User {
      id: ID!
      email: String!
      username: String
      kekSalt: String!
      wrapIv: String!
      encryptedMasterKey: String!
    }

    type AuthResponse {
      token: String!
      user: User!
    }

    type File {
      id: ID!
      name: String!
      mimeType: String!
      size: String!
      chunkSize: Int!
      chunkCount: Int!
      encryptedFEK: String!
      fekIv: String!
      sha256: String
      thumbnailUrl: String
      status: String!
      createdAt: DateTime!
      folderId: ID
    }

    type Folder {
      id: ID!
      name: String!
      parentId: ID
      createdAt: DateTime!
      subfolderCount: Int!
      fileCount: Int!
    }

    type ShareLink {
      token: String!
      fileId: ID!
      wrappedFEK: String!
      wrapIv: String!
      isPasswordProtected: Boolean!
      expiresAt: DateTime
      label: String
      downloads: Int!
      maxDownloads: Int
      createdAt: DateTime!
    }

    type InitUploadResult {
      fileId: ID!
    }

    type FinalizeUploadResult {
      success: Boolean!
      missingChunks: [Int!]
    }

    type StorageUsage {
      totalBytes: String!
      fileCount: Int!
    }

    type ChunkHealthInfo {
      id: ID!
      index: Int!
      messageId: String!
      webhookId: String!
      size: Int!
      encryptedHash: String
      healthStatus: String
      healthCheckedAt: DateTime
    }

    type FileHealthInfo {
      fileId: ID!
      fileName: String!
      chunkCount: Int!
      chunks: [ChunkHealthInfo!]!
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

    type Query {
      me: User
      files(folderId: ID): [File!]!
      folders(parentId: ID): [Folder!]!
      file(fileId: ID!): File
      shareLinks(fileId: ID!): [ShareLink!]!
      storageUsage: StorageUsage!
      filesForHealthCheck(samplePercent: Float): [FileHealthInfo!]!
    }

    input ReWrappedFEK {
      fileId: ID!
      encryptedFEK: String!
      fekIv: String!
    }

    type Mutation {
      register(
        email: String!
        username: String!
        password: String!
        kekSalt: String!
        wrapIv: String!
        encryptedMasterKey: String!
      ): AuthResponse!

      login(emailOrUsername: String!, password: String!): AuthResponse!

      changePassword(
        currentPassword: String!
        newPassword: String!
        newKekSalt: String!
        newWrapIv: String!
        newEncryptedMasterKey: String!
        reWrappedFEKs: [ReWrappedFEK!]!
      ): Boolean!

      initUpload(
        name: String!
        mimeType: String!
        size: String!
        chunkSize: Int!
        chunkCount: Int!
        encryptedFEK: String!
        fekIv: String!
        folderId: ID
      ): InitUploadResult!

      finalizeUpload(fileId: ID!, sha256: String!): FinalizeUploadResult!
      deleteFile(fileId: ID!): Boolean!
      moveFile(fileId: ID!, folderId: ID): Boolean!
      renameFile(fileId: ID!, name: String!): Boolean!

      createFolder(name: String!, parentId: ID): Folder!
      deleteFolder(folderId: ID!): Boolean!
      renameFolder(folderId: ID!, name: String!): Boolean!

      createShareLink(
        fileId: ID!
        wrappedFEK: String!
        wrapIv: String!
        password: String
        expiresAt: String
        label: String
        maxDownloads: Int
      ): ShareLink!

      deleteShareLink(token: String!): Boolean!
      updateShareLink(
        token: String!
        label: String
        maxDownloads: Int
        expiresAt: String
      ): Boolean!

      updateChunkHealthBatch(updates: [ChunkHealthUpdateInput!]!): Int!
      runHealthCheck(mode: String!, samplePercent: Float, fileId: ID): HealthCheckSummary!
    }
  `, ...pluginTypeDefs],

  resolvers: mergeResolvers({
    DateTime: {
      serialize: (value: unknown) => (value instanceof Date ? value.toISOString() : value),
      parseValue: (value: unknown) => new Date(value as string),
    },

    ShareLink: {
      isPasswordProtected: (parent: { passwordHash?: string | null }) =>
        parent.passwordHash !== null && parent.passwordHash !== undefined,
    },

    File: {
      size: (parent: { size: bigint | string }) => parent.size.toString(),
    },

    Query: {
      me: async (_parent: unknown, _args: unknown, ctx: Context) => {
        requireFullMode();
        const auth = requireAuth(ctx);
        const { db } = await import("@ddv4/database");
        const user = await db.user.findUnique({ where: { id: auth.userId } });
        if (!user) return null;
        return {
          id: user.id,
          email: user.email,
          kekSalt: user.kekSalt,
          wrapIv: user.wrapIv,
          encryptedMasterKey: user.encryptedMasterKey,
        };
      },

      files: async (_parent: unknown, args: { folderId?: string }, ctx: Context) => {
        const auth = requireAuth(ctx);
        return fileResolvers.getFiles(auth.userId, args.folderId ?? null);
      },

      folders: async (_parent: unknown, args: { parentId?: string }, ctx: Context) => {
        requireFullMode();
        const auth = requireAuth(ctx);
        return folderResolvers.getFolders(auth.userId, args.parentId ?? null);
      },

      file: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
        const auth = requireAuth(ctx);
        return fileResolvers.getFile(auth.userId, args.fileId);
      },

      shareLinks: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
        const auth = requireAuth(ctx);
        return sharingResolvers.getShareLinks(auth.userId, args.fileId);
      },

      storageUsage: async (_parent: unknown, _args: unknown, ctx: Context) => {
        const auth = requireAuth(ctx);
        return fileResolvers.getStorageUsage(auth.userId);
      },

      filesForHealthCheck: async (
        _parent: unknown,
        args: { samplePercent?: number },
        ctx: Context,
      ) => {
        const auth = requireAuth(ctx);
        return healthResolvers.getFilesForHealthCheck(auth.userId, args.samplePercent);
      },
    },

    Mutation: {
      register: async (
        _parent: unknown,
        args: {
          email: string;
          username: string;
          password: string;
          kekSalt: string;
          wrapIv: string;
          encryptedMasterKey: string;
        },
      ) => {
        requireFullMode();
        return authResolvers.register(args);
      },

      login: async (_parent: unknown, args: { emailOrUsername: string; password: string }) => {
        requireFullMode();
        return authResolvers.login(args.emailOrUsername, args.password);
      },

      changePassword: async (
        _parent: unknown,
        args: {
          currentPassword: string;
          newPassword: string;
          newKekSalt: string;
          newWrapIv: string;
          newEncryptedMasterKey: string;
          reWrappedFEKs: Array<{ fileId: string; encryptedFEK: string; fekIv: string }>;
        },
        ctx: Context,
      ) => {
        requireFullMode();
        const auth = requireAuth(ctx);
        return authResolvers.changePassword(
          auth.userId,
          args.currentPassword,
          args.newPassword,
          args.newKekSalt,
          args.newWrapIv,
          args.newEncryptedMasterKey,
          args.reWrappedFEKs,
        );
      },

      initUpload: async (
        _parent: unknown,
        args: {
          name: string;
          mimeType: string;
          size: string;
          chunkSize: number;
          chunkCount: number;
          encryptedFEK: string;
          fekIv: string;
          folderId?: string;
        },
        ctx: Context,
      ) => {
        const auth = requireAuth(ctx);
        return fileResolvers.initUpload(auth.userId, args);
      },

      finalizeUpload: async (
        _parent: unknown,
        args: { fileId: string; sha256: string },
        ctx: Context,
      ) => {
        const auth = requireAuth(ctx);
        return fileResolvers.finalizeUpload(auth.userId, args.fileId, args.sha256);
      },

      deleteFile: async (_parent: unknown, args: { fileId: string }, ctx: Context) => {
        const auth = requireAuth(ctx);
        return fileResolvers.deleteFile(auth.userId, args.fileId);
      },

      moveFile: async (
        _parent: unknown,
        args: { fileId: string; folderId?: string },
        ctx: Context,
      ) => {
        const auth = requireAuth(ctx);
        return fileResolvers.moveFile(auth.userId, args.fileId, args.folderId ?? null);
      },

      renameFile: async (
        _parent: unknown,
        args: { fileId: string; name: string },
        ctx: Context,
      ) => {
        const auth = requireAuth(ctx);
        return fileResolvers.renameFile(auth.userId, args.fileId, args.name);
      },

      createFolder: async (
        _parent: unknown,
        args: { name: string; parentId?: string },
        ctx: Context,
      ) => {
        requireFullMode();
        const auth = requireAuth(ctx);
        const result = await folderResolvers.createFolder(
          auth.userId,
          args.name,
          args.parentId ?? null,
        );
        const folders = await folderResolvers.getFolders(auth.userId, args.parentId ?? null);
        return folders.find((f) => f.id === result.id)!;
      },

      deleteFolder: async (_parent: unknown, args: { folderId: string }, ctx: Context) => {
        requireFullMode();
        const auth = requireAuth(ctx);
        return folderResolvers.deleteFolder(auth.userId, args.folderId);
      },

      renameFolder: async (
        _parent: unknown,
        args: { folderId: string; name: string },
        ctx: Context,
      ) => {
        requireFullMode();
        const auth = requireAuth(ctx);
        return folderResolvers.renameFolder(auth.userId, args.folderId, args.name);
      },

      createShareLink: async (
        _parent: unknown,
        args: {
          fileId: string;
          wrappedFEK: string;
          wrapIv: string;
          password?: string;
          expiresAt?: string;
          label?: string;
          maxDownloads?: number;
        },
        ctx: Context,
      ) => {
        const auth = requireAuth(ctx);
        const result = await sharingResolvers.createShareLink(auth.userId, args);
        const links = await sharingResolvers.getShareLinks(auth.userId, args.fileId);
        return links.find((l) => l.token === result.token)!;
      },

      deleteShareLink: async (_parent: unknown, args: { token: string }, ctx: Context) => {
        const auth = requireAuth(ctx);
        return sharingResolvers.deleteShareLink(auth.userId, args.token);
      },

      updateShareLink: async (
        _parent: unknown,
        args: { token: string; label?: string; maxDownloads?: number; expiresAt?: string },
        ctx: Context,
      ) => {
        const auth = requireAuth(ctx);
        return sharingResolvers.updateShareLink(auth.userId, args.token, args);
      },

      updateChunkHealthBatch: async (
        _parent: unknown,
        args: { updates: Array<{ chunkId: string; status: string }> },
        ctx: Context,
      ) => {
        requireAuth(ctx);
        return healthResolvers.updateChunkHealthBatch(args.updates);
      },

      runHealthCheck: async (
        _parent: unknown,
        args: { mode: string; samplePercent?: number; fileId?: string },
        ctx: Context,
      ) => {
        const auth = requireAuth(ctx);
        return healthResolvers.runHealthCheck(auth.userId, args.mode, args.samplePercent, args.fileId);
      },
    },
  }, ...pluginResolvers),
});
}

export async function createContext(request: Request): Promise<Context> {
  let auth: AuthPayload | null = null;

  if (isBackendOnly()) {
    // In backend-only mode, validate API key and use system user
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
      } catch {
        // Invalid token — proceed as unauthenticated
      }
    }
  }

  return { auth };
}