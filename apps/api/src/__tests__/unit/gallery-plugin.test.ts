import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@ddv4/database";
import { createYoga } from "graphql-yoga";
import galleryPlugin from "@ddv4/plugin-gallery";

// buildSchema pulls plugin extensions from the registry — return the real
// gallery plugin so this suite exercises the actual merged schema.
vi.mock("../../plugin-registry.js", () => ({
  pluginRegistry: {
    emitAsync: vi.fn().mockResolvedValue(undefined),
    getGraphqlExtensions: vi.fn(() => ({
      typeDefs: galleryPlugin.graphql?.typeDefs ? [galleryPlugin.graphql.typeDefs] : [],
      resolvers: galleryPlugin.graphql?.resolvers ? [galleryPlugin.graphql.resolvers] : [],
    })),
  },
}));

const { buildSchema } = await import("../../schema.js");
const { setState, getState, listStates, deleteState, MAX_STATE_VALUE_BYTES } = await import(
  "@ddv4/plugin-gallery/src/state.js"
);
const { getDelta } = await import("@ddv4/plugin-gallery/src/delta.js");
const { initUpload, commitManifest, deleteFile } = await import("../../resolvers/files.js");

const ownerUserId = "user_gallery_plugin";
const otherUserId = "user_gallery_plugin_other";

const yoga = createYoga({ schema: buildSchema(), graphqlEndpoint: "/graphql" });

async function execAsUser<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const request = new Request("http://localhost/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const response = await yoga.fetch(request, {
    auth: { userId: ownerUserId, email: `${ownerUserId}@example.com` },
    ip: "test",
  });
  const result = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  expect(result.errors).toBeUndefined();
  return result.data as T;
}

function b64(text: string): string {
  return Buffer.from(text).toString("base64");
}

async function resetFixtures() {
  await db.encryptedState.deleteMany({ where: { userId: { in: [ownerUserId, otherUserId] } } });
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
}

async function createReadyFile(): Promise<string> {
  const { fileId } = await initUpload(ownerUserId, {
    wrappedFEK: b64("wrapped-fek"),
    totalCiphertextBytes: "100",
    chunkCount: 1,
  });
  await commitManifest(ownerUserId, fileId, `${fileId}:manifest`, "100", 1, [
    { blobId: `${fileId}:manifest`, storageKind: "LOCAL", storagePath: `/tmp/${fileId}`, ciphertextSizeBytes: "100" },
  ]);
  return fileId;
}

describe("gallery plugin — encrypted state store", () => {
  beforeEach(async () => {
    await resetFixtures();
  });

  it("stores, reads, lists and deletes encrypted values", async () => {
    await setState(ownerUserId, "bucket-map", b64("encrypted-bucket-map"));
    await setState(ownerUserId, "device:pixel:state", b64("encrypted-cursor"));

    const fetched = await getState(ownerUserId, "bucket-map");
    expect(fetched?.valueB64).toBe(b64("encrypted-bucket-map"));
    expect(fetched?.version).toBe(1);

    const all = await listStates(ownerUserId, null);
    expect(all.map((s) => s.key)).toEqual(["bucket-map", "device:pixel:state"]);

    const devices = await listStates(ownerUserId, "device:");
    expect(devices.map((s) => s.key)).toEqual(["device:pixel:state"]);
    expect(devices[0]!.sizeBytes).toBe("encrypted-cursor".length);

    expect(await deleteState(ownerUserId, "bucket-map")).toBe(true);
    expect(await getState(ownerUserId, "bucket-map")).toBeNull();
    expect(await deleteState(ownerUserId, "bucket-map")).toBe(false);
  });

  it("enforces optimistic locking", async () => {
    const v1 = await setState(ownerUserId, "search-index", b64("v1"), 0);
    expect(v1.version).toBe(1);

    // create-only on an existing key conflicts
    await expect(setState(ownerUserId, "search-index", b64("v1b"), 0)).rejects.toThrow("Version conflict");

    const v2 = await setState(ownerUserId, "search-index", b64("v2"), 1);
    expect(v2.version).toBe(2);
    expect(v2.valueB64).toBe(b64("v2"));

    // stale writer loses
    await expect(setState(ownerUserId, "search-index", b64("stale"), 1)).rejects.toThrow(
      "Version conflict",
    );

    // last-write-wins without expectedVersion still bumps the version
    const v3 = await setState(ownerUserId, "search-index", b64("v3"));
    expect(v3.version).toBe(3);
  });

  it("rejects oversized and empty values", async () => {
    await expect(setState(ownerUserId, "too-big", Buffer.alloc(MAX_STATE_VALUE_BYTES + 1).toString("base64"))).rejects.toThrow("exceeds");
    await expect(setState(ownerUserId, "empty", "")).rejects.toThrow("must not be empty");
  });

  it("isolates state between users", async () => {
    await setState(ownerUserId, "bucket-map", b64("mine"));
    expect(await getState(otherUserId, "bucket-map")).toBeNull();
    expect(await listStates(otherUserId, null)).toEqual([]);
  });
});

describe("gallery plugin — delta sync", () => {
  beforeEach(async () => {
    await resetFixtures();
  });

  it("returns the full library when since is null and only changes afterwards", async () => {
    const fileId = await createReadyFile();
    const folder = await db.folder.create({
      data: { ownerUserId, encryptedBody: Buffer.from("body"), wrappedFolderKey: Buffer.from("key") },
    });

    const initial = await getDelta(ownerUserId, null);
    expect(initial.files.map((f) => f.id)).toContain(fileId);
    expect(initial.folders.map((f) => f.id)).toContain(folder.id);
    expect(initial.cursor.getTime()).toBeGreaterThan(0);

    // nothing changed → empty delta, cursor stays
    const idle = await getDelta(ownerUserId, initial.cursor);
    expect(idle.files).toEqual([]);
    expect(idle.folders).toEqual([]);
    expect(idle.cursor.getTime()).toBe(initial.cursor.getTime());

    // soft-delete shows up as a change with deletedAt set
    await deleteFile(ownerUserId, fileId);
    const afterDelete = await getDelta(ownerUserId, initial.cursor);
    expect(afterDelete.files.map((f) => f.id)).toEqual([fileId]);
    expect(afterDelete.files[0]!.deletedAt).not.toBeNull();
    expect(afterDelete.cursor.getTime()).toBeGreaterThan(initial.cursor.getTime());
  });

  it("does not leak other users' rows", async () => {
    await createReadyFile();
    const delta = await getDelta(otherUserId, null);
    expect(delta.files).toEqual([]);
    expect(delta.folders).toEqual([]);
  });
});

describe("gallery plugin — GraphQL surface", () => {
  beforeEach(async () => {
    await resetFixtures();
  });

  it("merges into the core schema and round-trips state through GraphQL", async () => {
    const set = await execAsUser<{ setGalleryState: { key: string; version: number; valueB64: string } }>(
      /* GraphQL */ `
        mutation Set($key: String!, $valueB64: String!) {
          setGalleryState(key: $key, valueB64: $valueB64) {
            key
            version
            valueB64
          }
        }
      `,
      { key: "bucket-map", valueB64: b64("via-graphql") },
    );
    expect(set.setGalleryState).toMatchObject({ key: "bucket-map", version: 1, valueB64: b64("via-graphql") });

    const read = await execAsUser<{
      galleryState: { valueB64: string; version: number } | null;
      galleryStates: Array<{ key: string; sizeBytes: number }>;
    }>(/* GraphQL */ `
      query {
        galleryState(key: "bucket-map") {
          valueB64
          version
        }
        galleryStates {
          key
          sizeBytes
        }
      }
    `);
    expect(read.galleryState?.valueB64).toBe(b64("via-graphql"));
    expect(read.galleryStates).toEqual([{ key: "bucket-map", sizeBytes: "via-graphql".length }]);
  });

  it("serves galleryDelta with core File fields through the merged schema", async () => {
    const fileId = await createReadyFile();

    const delta = await execAsUser<{
      galleryDelta: {
        cursor: string;
        files: Array<{ id: string; status: string; wrappedFEK: string; deletedAt: string | null }>;
        folders: unknown[];
      };
    }>(/* GraphQL */ `
      query {
        galleryDelta {
          cursor
          files {
            id
            status
            wrappedFEK
            deletedAt
          }
          folders {
            id
          }
        }
      }
    `);

    expect(delta.galleryDelta.files).toEqual([
      { id: fileId, status: "READY", wrappedFEK: b64("wrapped-fek"), deletedAt: null },
    ]);
    expect(delta.galleryDelta.cursor).toBeTruthy();
  });
});
