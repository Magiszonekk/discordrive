// DiscorDrive v4 — one-shot backfill: BlobTransport legacy columns → BlobPlacement
//
// Idempotent and safe to re-run (createMany + skipDuplicates on the
// blobId+provider+poolRole unique key). Run AFTER `prisma db push` added the
// BlobPlacement table and AFTER the new API code is deployed; reads fall back
// to legacy columns until this completes, so timing is not critical.
//
// Usage: npx tsx scripts/backfill-blob-placements.ts [--dry-run]

import "dotenv/config";
import { db } from "@ddv4/database";

const BATCH_SIZE = 500;
const dryRun = process.argv.includes("--dry-run");

async function main() {
  let cursor: string | null = null;
  let scanned = 0;
  let created = 0;

  while (true) {
    const blobs: Array<{
      blobId: string;
      storageKind: "LOCAL" | "DISCORD" | "TELEGRAM";
      storagePath: string;
      discordMessageId: string | null;
      discordChannelId: string | null;
      webhookId: string | null;
      createdAt: Date;
      placements: Array<{ id: string }>;
    }> = await db.blobTransport.findMany({
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { blobId: cursor } } : {}),
      orderBy: { blobId: "asc" },
      include: { placements: { select: { id: true } } },
    });
    if (blobs.length === 0) break;

    scanned += blobs.length;
    cursor = blobs[blobs.length - 1]!.blobId;

    const missing = blobs.filter((b) => b.placements.length === 0);
    if (missing.length > 0 && !dryRun) {
      const result = await db.blobPlacement.createMany({
        skipDuplicates: true,
        data: missing.map((b) => ({
          blobId: b.blobId,
          provider: b.storageKind,
          poolRole: "PRIMARY" as const,
          status: "ACTIVE" as const,
          storagePath: b.storagePath,
          messageId: b.discordMessageId,
          locationId: b.discordChannelId,
          senderId: b.webhookId,
          activatedAt: b.createdAt,
        })),
      });
      created += result.count;
    } else {
      created += dryRun ? missing.length : 0;
    }

    console.log(`scanned=${scanned} ${dryRun ? "would-create" : "created"}=${created}`);
  }

  console.log(`Done. ${scanned} blobs scanned, ${created} placements ${dryRun ? "would be " : ""}created.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
