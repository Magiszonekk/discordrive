// Gallery plugin — encrypted key-value state store (zero-knowledge)
//
// Holds small client-encrypted blobs the mobile gallery needs to sync across
// devices: bucket↔folder mapping manifests, thumbnail-pack indexes, search
// index pointers, per-device cursors. The server only sees ciphertext.

import { db } from "@ddv4/database";

export const GALLERY_DOMAIN = "gallery";

// Keep states small — large payloads (thumbnail packs, search index snapshots)
// belong in the blob transport, with only their pointers stored here.
export const MAX_STATE_VALUE_BYTES = 4 * 1024 * 1024;

export interface GalleryStateDto {
  key: string;
  valueB64: string;
  version: number;
  updatedAt: Date;
}

export interface GalleryStateMetaDto {
  key: string;
  version: number;
  sizeBytes: number;
  updatedAt: Date;
}

export async function getState(userId: string, key: string): Promise<GalleryStateDto | null> {
  const record = await db.encryptedState.findUnique({
    where: { userId_domain_key: { userId, domain: GALLERY_DOMAIN, key } },
  });
  if (!record) return null;
  return {
    key: record.key,
    valueB64: Buffer.from(record.value).toString("base64"),
    version: record.version,
    updatedAt: record.updatedAt,
  };
}

export async function listStates(userId: string, prefix?: string | null): Promise<GalleryStateMetaDto[]> {
  const records = await db.encryptedState.findMany({
    where: {
      userId,
      domain: GALLERY_DOMAIN,
      ...(prefix ? { key: { startsWith: prefix } } : {}),
    },
    orderBy: { key: "asc" },
  });
  return records.map((record) => ({
    key: record.key,
    version: record.version,
    sizeBytes: record.value.byteLength,
    updatedAt: record.updatedAt,
  }));
}

// Optimistic concurrency: when expectedVersion is given, the write succeeds
// only if the stored version still matches (stale writers get a conflict and
// must re-read + merge). Without expectedVersion the write is last-write-wins.
export async function setState(
  userId: string,
  key: string,
  valueB64: string,
  expectedVersion?: number | null,
): Promise<GalleryStateDto> {
  const value = Buffer.from(valueB64, "base64");
  if (value.byteLength === 0) throw new Error("State value must not be empty");
  if (value.byteLength > MAX_STATE_VALUE_BYTES) {
    throw new Error(`State value exceeds ${MAX_STATE_VALUE_BYTES} bytes — store large payloads as blobs`);
  }

  if (expectedVersion != null) {
    if (expectedVersion === 0) {
      // Caller asserts the key must not exist yet
      try {
        const created = await db.encryptedState.create({
          data: { userId, domain: GALLERY_DOMAIN, key, value },
        });
        return toDto(created);
      } catch {
        throw new Error(`Version conflict on "${key}": state already exists`);
      }
    }

    const result = await db.encryptedState.updateMany({
      where: { userId, domain: GALLERY_DOMAIN, key, version: expectedVersion },
      data: { value, version: { increment: 1 } },
    });
    if (result.count === 0) {
      throw new Error(`Version conflict on "${key}": expected version ${expectedVersion}`);
    }
  } else {
    await db.encryptedState.upsert({
      where: { userId_domain_key: { userId, domain: GALLERY_DOMAIN, key } },
      create: { userId, domain: GALLERY_DOMAIN, key, value },
      update: { value, version: { increment: 1 } },
    });
  }

  const saved = await db.encryptedState.findUniqueOrThrow({
    where: { userId_domain_key: { userId, domain: GALLERY_DOMAIN, key } },
  });
  return toDto(saved);
}

export async function deleteState(userId: string, key: string): Promise<boolean> {
  const result = await db.encryptedState.deleteMany({
    where: { userId, domain: GALLERY_DOMAIN, key },
  });
  return result.count > 0;
}

function toDto(record: { key: string; value: Uint8Array; version: number; updatedAt: Date }): GalleryStateDto {
  return {
    key: record.key,
    valueB64: Buffer.from(record.value).toString("base64"),
    version: record.version,
    updatedAt: record.updatedAt,
  };
}
