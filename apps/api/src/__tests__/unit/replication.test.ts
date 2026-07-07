import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { db } from "@ddv4/database";
import { writeCiphertextBlob } from "../../storage/local-blobs.js";
import { clearReplicaPools, getConfiguredReplicaKinds, getReplicaPool } from "../../storage/replica-pools.js";
import { getPoolFor, getPrimaryPool } from "../../storage/provider.js";
import { processPlacement, runReplicationSweep, writeThroughReplication } from "../../storage/replication-worker.js";
import { readBlobBytes } from "../../handlers/blob.js";
import { purgeFile } from "../../resolvers/files.js";

const OWNER_EMAIL = "replication-test@ddv4.local";
let ownerUserId: string;
let primaryRoot: string;
let replicaRoot: string;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createBlobWithPrimary(blobId: string, bytes: Uint8Array) {
  const storagePath = await writeCiphertextBlob(ownerUserId, blobId, bytes);
  await db.blobTransport.create({
    data: {
      blobId,
      ownerUserId,
      storageKind: "LOCAL",
      storagePath,
      ciphertextSizeBytes: BigInt(bytes.byteLength),
      ciphertextHash: sha256Hex(bytes),
      placements: {
        create: {
          provider: "LOCAL",
          poolRole: "PRIMARY",
          status: "ACTIVE",
          storagePath,
          activatedAt: new Date(),
        },
      },
    },
  });
  return storagePath;
}

async function queueReplica(blobId: string) {
  return db.blobPlacement.create({
    data: {
      blobId,
      provider: "LOCAL",
      poolRole: "REPLICA",
      status: "PENDING",
      storagePath: "pending://replica",
    },
  });
}

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { email: OWNER_EMAIL },
    create: { email: OWNER_EMAIL },
    update: {},
  });
  ownerUserId = user.id;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: OWNER_EMAIL } });
});

beforeEach(async () => {
  primaryRoot = await mkdtemp(path.join(os.tmpdir(), "ddv4-repl-primary-"));
  replicaRoot = await mkdtemp(path.join(os.tmpdir(), "ddv4-repl-replica-"));
  process.env.DDV4_BLOB_ROOT_DIR = primaryRoot;
  process.env.DDV4_REPLICA_BLOB_ROOT_DIR = replicaRoot;
  process.env.STORAGE_REPLICA_PROVIDERS = "LOCAL";
  clearReplicaPools();
  await db.blobTransport.deleteMany({ where: { ownerUserId } });
});

afterEach(async () => {
  delete process.env.DDV4_BLOB_ROOT_DIR;
  delete process.env.DDV4_REPLICA_BLOB_ROOT_DIR;
  delete process.env.STORAGE_REPLICA_PROVIDERS;
  delete process.env.STORAGE_PRIMARY_PROVIDERS;
  delete process.env.BLOB_STORAGE_KIND;
  clearReplicaPools();
  await db.blobTransport.deleteMany({ where: { ownerUserId } });
  await rm(primaryRoot, { recursive: true, force: true });
  await rm(replicaRoot, { recursive: true, force: true });
});

describe("replication worker", () => {
  it("sweep replicates a PENDING placement from the primary copy", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await createBlobWithPrimary("repl-blob-sweep", bytes);
    await queueReplica("repl-blob-sweep");

    const activated = await runReplicationSweep();

    expect(activated).toBe(1);
    const placement = await db.blobPlacement.findFirst({
      where: { blobId: "repl-blob-sweep", poolRole: "REPLICA" },
    });
    expect(placement?.status).toBe("ACTIVE");
    expect(placement?.storagePath.startsWith(replicaRoot)).toBe(true);
    expect(placement?.activatedAt).not.toBeNull();
    const copied = new Uint8Array(await readFile(placement!.storagePath));
    expect(Array.from(copied)).toEqual(Array.from(bytes));
  });

  it("write-through replicates from in-memory bytes without reading the primary", async () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const primaryPath = await createBlobWithPrimary("repl-blob-wt", bytes);
    await queueReplica("repl-blob-wt");
    // Remove the primary copy — write-through must not need it
    await rm(primaryPath);

    await writeThroughReplication("repl-blob-wt", bytes);

    const placement = await db.blobPlacement.findFirst({
      where: { blobId: "repl-blob-wt", poolRole: "REPLICA" },
    });
    expect(placement?.status).toBe("ACTIVE");
    const copied = new Uint8Array(await readFile(placement!.storagePath));
    expect(Array.from(copied)).toEqual(Array.from(bytes));
  });

  it("refuses to replicate bytes whose hash does not match the blob record", async () => {
    const bytes = new Uint8Array([1, 1, 1]);
    await createBlobWithPrimary("repl-blob-hash", bytes);
    const row = await queueReplica("repl-blob-hash");

    const full = await db.blobPlacement.findUniqueOrThrow({
      where: { id: row.id },
      include: { blob: true },
    });
    const ok = await processPlacement(full as never, new Uint8Array([2, 2, 2]));

    expect(ok).toBe(false);
    const after = await db.blobPlacement.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("PENDING");
    expect(after.attemptCount).toBe(1);
    expect(after.lastError).toMatch(/hash mismatch/);
    expect(after.nextAttemptAt).not.toBeNull();
  });

  it("purge deletes replica copies and the queue cannot resurrect them", async () => {
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const fileId = "repl-file-purge";
    await db.file.create({
      data: {
        id: fileId,
        ownerUserId,
        wrappedFEK: Buffer.from([0]),
        status: "READY",
        deletedAt: new Date(),
      },
    });
    await createBlobWithPrimary(`${fileId}:chunk:0`, bytes);
    await queueReplica(`${fileId}:chunk:0`);
    // Replicate first so a physical replica copy exists
    await runReplicationSweep();
    const replicated = await db.blobPlacement.findFirst({
      where: { blobId: `${fileId}:chunk:0`, poolRole: "REPLICA" },
    });
    expect(replicated?.status).toBe("ACTIVE");

    await purgeFile(ownerUserId, fileId);

    // Physical replica copy removed, all rows gone, sweep is a no-op
    await expect(stat(replicated!.storagePath)).rejects.toThrow();
    expect(await db.blobPlacement.count({ where: { blobId: `${fileId}:chunk:0` } })).toBe(0);
    expect(await runReplicationSweep()).toBe(0);
  });
});

describe("read failover + self-heal", () => {
  it("serves from the replica when the primary copy is gone and heals the primary", async () => {
    const bytes = new Uint8Array([3, 1, 4, 1, 5]);
    const primaryPath = await createBlobWithPrimary("repl-blob-failover", bytes);
    await queueReplica("repl-blob-failover");
    await runReplicationSweep();

    // Kill the primary copy
    await rm(primaryPath);

    const blob = await db.blobTransport.findUniqueOrThrow({
      where: { blobId: "repl-blob-failover" },
      include: { placements: true },
    });
    const served = await readBlobBytes(blob as never);
    expect(Array.from(served)).toEqual(Array.from(bytes));

    // The failed PRIMARY placement is parked as MISSING (async, fire-and-forget)
    await new Promise((r) => setTimeout(r, 100));
    const primaryPlacement = await db.blobPlacement.findFirst({
      where: { blobId: "repl-blob-failover", poolRole: "PRIMARY" },
    });
    expect(primaryPlacement?.status).toBe("MISSING");

    // The worker rebuilds the primary copy from the replica
    const healed = await runReplicationSweep();
    expect(healed).toBe(1);
    const healedPlacement = await db.blobPlacement.findFirst({
      where: { blobId: "repl-blob-failover", poolRole: "PRIMARY" },
    });
    expect(healedPlacement?.status).toBe("ACTIVE");
    const restored = new Uint8Array(await readFile(healedPlacement!.storagePath));
    expect(Array.from(restored)).toEqual(Array.from(bytes));
  });
});

describe("pool separation", () => {
  it("replica pools are distinct instances that never serve primary uploads", () => {
    process.env.STORAGE_PRIMARY_PROVIDERS = "LOCAL";
    const primary = getPrimaryPool();
    const replica = getPoolFor("LOCAL", "REPLICA");

    expect(primary.role).toBe("PRIMARY");
    expect(replica.role).toBe("REPLICA");
    expect(replica).not.toBe(primary);
    expect(replica).toBe(getReplicaPool("LOCAL"));
  });

  it("replication is disabled when STORAGE_REPLICA_PROVIDERS is unset", () => {
    delete process.env.STORAGE_REPLICA_PROVIDERS;
    expect(getConfiguredReplicaKinds()).toEqual([]);
  });

  it("writes primary and replica copies into disjoint roots", async () => {
    const bytes = new Uint8Array([8, 8]);
    await createBlobWithPrimary("repl-blob-roots", bytes);
    await queueReplica("repl-blob-roots");
    await runReplicationSweep();

    const placements = await db.blobPlacement.findMany({ where: { blobId: "repl-blob-roots" } });
    const primaryPlacement = placements.find((p) => p.poolRole === "PRIMARY")!;
    const replicaPlacement = placements.find((p) => p.poolRole === "REPLICA")!;
    expect(primaryPlacement.storagePath.startsWith(primaryRoot)).toBe(true);
    expect(replicaPlacement.storagePath.startsWith(replicaRoot)).toBe(true);
  });
});
