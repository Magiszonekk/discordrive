// DiscorDrive v4 — Admin healthcheck handler
// POST /api/admin/healthcheck
// Body: { mode: "exists"|"integrity", sample?: number, fileId?: string }

import { authenticateRequestAny } from "../middleware/auth.js";
import { runHealthCheck } from "../resolvers/health.js";

export async function handleHealthCheck(request: Request): Promise<Response> {
  try {
    const auth = await authenticateRequestAny(request);

    const body = await request.json() as {
      mode?: string;
      sample?: number;
      fileId?: string;
    };

    const { mode, sample, fileId } = body;

    if (!mode || (mode !== "exists" && mode !== "integrity")) {
      return Response.json(
        { error: 'mode is required and must be "exists" or "integrity"' },
        { status: 400 },
      );
    }

    const result = await runHealthCheck(auth.userId, mode, sample, fileId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "Health check failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
