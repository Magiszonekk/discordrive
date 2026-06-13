// Gallery plugin — AI enrichment blob deletion
//
// The mobile app stores each file's AI analysis (tags/description) as a
// client-encrypted blob `{fileId}:enrichment` via the normal blob transport.
// There is no generic client-facing blob delete (by design), so this provides
// a narrow, ownership-checked way to remove enrichment blobs only:
//   - per file (fileIds given)
//   - whole library (fileIds null/empty)
// The `:enrichment` suffix constraint guarantees file chunk/manifest blobs are
// never touched. LOCAL blobs are also unlinked from disk (best-effort); DISCORD
// messages are left orphaned but unreachable once their transport row is gone.

import { db } from "@ddv4/database";
import { unlink } from "node:fs/promises";

const ENRICHMENT_SUFFIX = ":enrichment";

export async function deleteEnrichments(userId: string, fileIds: string[] | null): Promise<number> {
  const where =
    fileIds && fileIds.length > 0
      ? { ownerUserId: userId, blobId: { in: fileIds.map((id) => `${id}${ENRICHMENT_SUFFIX}`) } }
      : { ownerUserId: userId, blobId: { endsWith: ENRICHMENT_SUFFIX } };

  const blobs = await db.blobTransport.findMany({
    where,
    select: { blobId: true, storageKind: true, storagePath: true },
  });
  if (blobs.length === 0) return 0;

  await Promise.all(
    blobs
      .filter((b) => b.storageKind === "LOCAL" && b.storagePath)
      .map((b) => unlink(b.storagePath).catch(() => undefined)),
  );

  const result = await db.blobTransport.deleteMany({
    where: { ownerUserId: userId, blobId: { in: blobs.map((b) => b.blobId) } },
  });
  return result.count;
}
