// DiscorDrive plugin: gallery
//
// Server-side support for the mobile gallery app. Everything stored here is
// client-encrypted — the plugin adds sync plumbing, not data access:
//   - encrypted KV state store (bucket maps, thumb-pack index, search index
//     pointers, per-device cursors) with optimistic locking
//   - incremental delta sync over the core File/Folder tables
//
// Enable with: DDV_PLUGINS=@ddv4/plugin-gallery

import type { DdvPlugin } from "@ddv4/plugin-sdk";
import { getState, listStates, setState, deleteState } from "./state.js";
import { getDelta } from "./delta.js";
import { deleteEnrichments } from "./enrichment.js";

// Matches the API server's GraphQL context (apps/api/src/schema.ts)
interface Ctx {
  auth: { userId: string; email: string } | null;
}

function requireAuth(ctx: Ctx): { userId: string; email: string } {
  if (!ctx.auth) throw new Error("Authentication required");
  return ctx.auth;
}

const typeDefs = /* GraphQL */ `
  type GalleryState {
    key: String!
    valueB64: String!
    version: Int!
    updatedAt: DateTime!
  }

  type GalleryStateMeta {
    key: String!
    version: Int!
    sizeBytes: Int!
    updatedAt: DateTime!
  }

  type GalleryDelta {
    files: [File!]!
    folders: [Folder!]!
    cursor: DateTime!
  }

  extend type Query {
    galleryState(key: String!): GalleryState
    galleryStates(prefix: String): [GalleryStateMeta!]!
    galleryDelta(since: DateTime): GalleryDelta!
  }

  extend type Mutation {
    setGalleryState(key: String!, valueB64: String!, expectedVersion: Int): GalleryState!
    deleteGalleryState(key: String!): Boolean!
    """
    Deletes AI enrichment blobs (\`{fileId}:enrichment\`). Pass specific fileIds,
    or null/empty to clear the whole library. Returns the number deleted.
    """
    deleteEnrichments(fileIds: [String!]): Int!
  }
`;

const resolvers = {
  Query: {
    galleryState: async (_parent: unknown, args: { key: string }, ctx: Ctx) => {
      const auth = requireAuth(ctx);
      return getState(auth.userId, args.key);
    },
    galleryStates: async (_parent: unknown, args: { prefix?: string }, ctx: Ctx) => {
      const auth = requireAuth(ctx);
      return listStates(auth.userId, args.prefix ?? null);
    },
    galleryDelta: async (_parent: unknown, args: { since?: string }, ctx: Ctx) => {
      const auth = requireAuth(ctx);
      return getDelta(auth.userId, args.since ? new Date(args.since) : null);
    },
  },
  Mutation: {
    setGalleryState: async (
      _parent: unknown,
      args: { key: string; valueB64: string; expectedVersion?: number },
      ctx: Ctx,
    ) => {
      const auth = requireAuth(ctx);
      return setState(auth.userId, args.key, args.valueB64, args.expectedVersion ?? null);
    },
    deleteGalleryState: async (_parent: unknown, args: { key: string }, ctx: Ctx) => {
      const auth = requireAuth(ctx);
      return deleteState(auth.userId, args.key);
    },
    deleteEnrichments: async (_parent: unknown, args: { fileIds?: string[] | null }, ctx: Ctx) => {
      const auth = requireAuth(ctx);
      return deleteEnrichments(auth.userId, args.fileIds ?? null);
    },
  },
};

const galleryPlugin: DdvPlugin = {
  name: "gallery",
  version: "0.1.0",
  graphql: { typeDefs, resolvers },
};

export default galleryPlugin;
export { GALLERY_DOMAIN, MAX_STATE_VALUE_BYTES } from "./state.js";
