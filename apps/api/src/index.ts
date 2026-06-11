// DiscorDrive v4 — API Server (Node.js HTTP + GraphQL Yoga)

import { createServer } from "node:http";
import { createYoga } from "graphql-yoga";
import { buildSchema, createContext } from "./schema.js";
import { handleBlobContent, handleBlobContentForShare, handleBlobMetadata, handleBlobUpload } from "./handlers/blob.js";
import { checkRateLimit } from "./middleware/rate-limit.js";
import { serverConfig } from "@ddv4/config/server";
import { pluginRegistry } from "./plugin-registry.js";
import { matchRoute } from "@ddv4/plugin-sdk/route";

// yoga is initialized after plugins load (see below)
let yoga;

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": serverConfig.frontendUrl,
        "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Upload-Id, X-Chunk-Index, X-Chunk-Count, X-Client-Timestamp, X-Share-Id, X-Capability-Token",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Rate limiting for non-GraphQL endpoints
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ?? "unknown";

  if (pathname.startsWith("/api/blob/") || pathname.startsWith("/api/share/blob/")) {
    const { allowed, retryAfter } = checkRateLimit(ip, "blob");
    if (!allowed) {
      return Response.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfter ?? 60) } },
      );
    }
  }

  // GraphQL — handled by Yoga
  if (pathname === "/graphql") {
    try {
      if (method === "POST") {
        const bodyText = await req.clone().text();
        if (bodyText.includes("initUpload(")) {
          const authHeader = req.headers.get("authorization");
          console.warn(JSON.stringify({
            ts: new Date().toISOString(),
            scope: "graphql-auth-debug",
            type: "init_upload_http_request",
            hasAuthorizationHeader: Boolean(authHeader),
            bearerPrefixPresent: authHeader?.startsWith("Bearer ") ?? false,
            authorizationLength: authHeader?.length ?? 0,
            origin: req.headers.get("origin"),
            referer: req.headers.get("referer"),
          }));
        }
      }
    } catch {
      // non-fatal debug probe
    }
    return yoga!.handleRequest(req, {});
  }

  // HTTP Routes
  let params: Record<string, string> | null;

  // Blob transport by client-presented blobId
  if (method === "GET" && (params = matchRoute(pathname, "/api/blob/:blobId/meta"))) {
    return handleBlobMetadata(req, params as { blobId: string });
  }

  if (method === "GET" && (params = matchRoute(pathname, "/api/blob/:blobId"))) {
    return handleBlobContent(req, params as { blobId: string });
  }

  // Share blob access (no auth token — uses share capability token)
  if (method === "GET" && (params = matchRoute(pathname, "/api/share/blob/:blobId"))) {
    return handleBlobContentForShare(req, params as { blobId: string });
  }

  if (method === "PUT" && (params = matchRoute(pathname, "/api/blob/:blobId"))) {
    return handleBlobUpload(req, params as { blobId: string });
  }

  // Plugin routes: /api/plugin/:pluginName/...
  if (pathname.startsWith("/api/plugin/")) {
    const result = pluginRegistry.dispatch(req, pathname);
    if (result !== null) return result;
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

// Add CORS headers to all responses
function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", serverConfig.frontendUrl);
  headers.set("Access-Control-Allow-Credentials", "true");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const port = serverConfig.apiPort;

await pluginRegistry.load();

// Create Magiszonek user if needed (fire-and-forget)
import { createMagiszonekIfNeeded } from "@ddv4/database/seed/magiszonek";
createMagiszonekIfNeeded().catch(console.error);

// Build schema after plugins are loaded so their GraphQL extensions are included
yoga = createYoga({
  schema: buildSchema(),
  context: ({ request }) => createContext(request),
  graphqlEndpoint: "/graphql",
  maskedErrors: false,
  cors: {
    origin: serverConfig.frontendUrl,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Upload-Id", "X-Chunk-Index", "X-Chunk-Count", "X-Client-Timestamp"],
  },
});

const server = createServer(async (nodeReq, nodeRes) => {
  // Convert Node.js request to Web Request
  const protocol = "http";
  const host = nodeReq.headers.host ?? `localhost:${port}`;
  const url = `${protocol}://${host}${nodeReq.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (value) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }
  const bodyBuffer =
    nodeReq.method !== "GET" && nodeReq.method !== "HEAD"
      ? await new Promise<Buffer>((resolve) => {
          const chunks: Buffer[] = [];
          nodeReq.on("data", (chunk) => chunks.push(chunk));
          nodeReq.on("end", () => {
            resolve(Buffer.concat(chunks));
          });
        })
      : undefined;
  const request = new Request(url, {
    method: nodeReq.method,
    headers,
    body: bodyBuffer,
    // @ts-ignore
    duplex: bodyBuffer ? "half" : undefined,
  });
  try {
    let response = await handleRequest(request);
    response = addCorsHeaders(response);
    nodeRes.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          nodeRes.write(value);
        }
        nodeRes.end();
      };
      await pump();
    } else {
      const text = await response.text();
      nodeRes.end(text);
    }
  } catch (error) {
    console.error("Request error:", error);
    nodeRes.writeHead(500);
    nodeRes.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(port, () => {
  console.log(`DiscorDrive API running on http://localhost:${port}`);
  console.log(`GraphQL endpoint: http://localhost:${port}/graphql`);
  console.log(`Mode: ${serverConfig.appMode}`);
});

process.on("SIGTERM", async () => {
  await pluginRegistry.unload();
  server.close();
});
