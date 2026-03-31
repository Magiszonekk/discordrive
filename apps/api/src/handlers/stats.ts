// DiscorDrive v4 — Admin stats handler
// GET /api/admin/stats

import { authenticateRequestAny } from "../middleware/auth.js";
import { db } from "@discordrive/database";
import { serverConfig } from "@discordrive/config/server";

export async function handleStats(request: Request): Promise<Response> {
  try {
    await authenticateRequestAny(request);

    const [fileAgg, chunkGroups] = await Promise.all([
      db.file.aggregate({
        _count: true,
        _sum: { size: true },
        where: { status: "READY" },
      }),
      db.chunk.groupBy({
        by: ["healthStatus"],
        _count: { _all: true },
      }),
    ]);

    const chunkCounts = { healthy: 0, missing: 0, modified: 0, unchecked: 0 };
    for (const group of chunkGroups) {
      const status = group.healthStatus;
      const count = group._count._all;
      if (status === "HEALTHY") chunkCounts.healthy = count;
      else if (status === "MISSING") chunkCounts.missing = count;
      else if (status === "MODIFIED") chunkCounts.modified = count;
      else chunkCounts.unchecked = count;
    }

    return Response.json({
      files: {
        count: fileAgg._count,
        totalSize: Number(fileAgg._sum.size ?? 0),
      },
      chunks: chunkCounts,
      uptime: Math.floor(process.uptime()),
      mode: serverConfig.appMode,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "Stats failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
