// DiscorDrive v4 — Thumbnail proxy handler
// GET /api/thumbnail/:fileId

import { db } from "@discordrive/database";
import { authenticateRequestAny } from "../middleware/auth.js";

export async function handleThumbnail(
  request: Request,
  params: { fileId: string },
): Promise<Response> {
  try {
    const auth = await authenticateRequestAny(request);

    const file = await db.file.findFirst({
      where: { id: params.fileId, userId: auth.userId },
      select: { thumbnailUrl: true },
    });

    if (!file?.thumbnailUrl) {
      return Response.json({ error: "Thumbnail not found" }, { status: 404 });
    }

    // Proxy the thumbnail
    const response = await fetch(file.thumbnailUrl);
    if (!response.ok) {
      return Response.json({ error: "Failed to fetch thumbnail" }, { status: 502 });
    }

    return new Response(response.body, {
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
