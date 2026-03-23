// DiscorDrive v4 — Share handlers
// GET /api/share/:token — HTML page with OG meta tags
// GET /api/share/:token/info — JSON share info
// POST /api/share/:token/verify-password — Password verification
// GET /api/share/:token/chunk/:index — Stream chunk (no auth required)

import { db } from "@ddv4/database";
import {
  parseWebhookUrls,
  WebhookRateLimiter,
  getChunkUrl,
  streamChunk,
} from "@ddv4/discord-client";
import { serverConfig } from "@ddv4/config/server";
import {
  getShareInfo,
  verifySharePassword,
  incrementShareDownloads,
} from "../resolvers/sharing.js";

const rateLimiter = new WebhookRateLimiter();

let webhooks: ReturnType<typeof parseWebhookUrls> | null = null;
function getWebhooks() {
  if (!webhooks) {
    webhooks = parseWebhookUrls(serverConfig.webhooks);
  }
  return webhooks;
}

function formatFileSize(bytes: string): string {
  const size = Number(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function handleSharePage(
  _request: Request,
  params: { token: string },
): Promise<Response> {
  const info = await getShareInfo(params.token);

  if (!info) {
    return new Response("Share link not found or expired", { status: 404 });
  }

  // HTML with OG meta tags for crawlers + redirect to React app for users
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta property="og:title" content="${escapeHtml(info.fileName)}">
  <meta property="og:description" content="${formatFileSize(info.fileSize)} | ${escapeHtml(info.mimeType)}">
  <meta property="og:type" content="website">
  <title>${escapeHtml(info.fileName)} — DiscorDrive</title>
  <script>window.location.href = '${serverConfig.frontendUrl}/share/${params.token}' + window.location.hash;</script>
</head>
<body>
  <p>Redirecting to <a href="${serverConfig.frontendUrl}/share/${params.token}">download page</a>...</p>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function handleShareInfo(
  _request: Request,
  params: { token: string },
): Promise<Response> {
  const info = await getShareInfo(params.token);
  if (!info) {
    return Response.json({ error: "Share link not found or expired" }, { status: 404 });
  }
  return Response.json(info);
}

export async function handleShareVerifyPassword(
  request: Request,
  params: { token: string },
): Promise<Response> {
  const body = (await request.json()) as { password: string };
  if (!body.password) {
    return Response.json({ error: "Password required" }, { status: 400 });
  }

  const valid = await verifySharePassword(params.token, body.password);
  return Response.json({ valid });
}

export async function handleShareChunk(
  _request: Request,
  params: { token: string; index: string },
): Promise<Response> {
  const chunkIndex = parseInt(params.index, 10);

  const link = await db.shareLink.findUnique({
    where: { token: params.token },
    include: { file: true },
  });

  if (!link) {
    return Response.json({ error: "Share link not found" }, { status: 404 });
  }

  // Check expiry/limits
  if (link.expiresAt && link.expiresAt < new Date()) {
    return Response.json({ error: "Share link expired" }, { status: 410 });
  }
  if (link.maxDownloads !== null && link.downloads >= link.maxDownloads) {
    return Response.json({ error: "Download limit reached" }, { status: 410 });
  }

  // Get chunk
  const chunk = await db.chunk.findUnique({
    where: { fileId_index: { fileId: link.fileId, index: chunkIndex } },
  });

  if (!chunk) {
    return Response.json({ error: "Chunk not found" }, { status: 404 });
  }

  const whs = getWebhooks();
  const webhook = whs.find((w) => w.id === chunk.webhookId);
  if (!webhook) {
    return Response.json({ error: "Webhook not available" }, { status: 503 });
  }

  const cdnUrl = await getChunkUrl(webhook, chunk.messageId, rateLimiter);
  const stream = await streamChunk(cdnUrl);

  // Increment download count on first chunk
  if (chunkIndex === 0) {
    await incrementShareDownloads(params.token);
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": chunk.size.toString(),
    },
  });
}
