// DiscorDrive v4 — API Server (Node.js HTTP + GraphQL Yoga)

import "./env.js"; // Must be first — loads .env before other modules initialize

import { createServer } from "node:http";
import { createYoga } from "graphql-yoga";
import { schema, createContext } from "./schema.js";
import { handleUpload } from "./handlers/upload.js";
import { handleDownload } from "./handlers/download.js";
import {
  handleSharePage,
  handleShareInfo,
  handleShareVerifyPassword,
  handleShareChunk,
} from "./handlers/share.js";
import { handleThumbnail } from "./handlers/thumbnail.js";
import { checkRateLimit } from "./middleware/rate-limit.js";
import { serverConfig } from "@ddv4/config/server";

const yoga = createYoga({
  schema,
  context: ({ request }) => createContext(request),
  graphqlEndpoint: "/graphql",
  maskedErrors: false,
  cors: {
    origin: serverConfig.frontendUrl,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  },
});

// Simple URL pattern matcher
function matchRoute(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

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
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Rate limiting for non-GraphQL endpoints
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  // GraphQL — handled by Yoga
  if (pathname === "/graphql") {
    return yoga.handleRequest(req, {});
  }

  // HTTP Routes
  let params: Record<string, string> | null;

  // Upload chunk
  if (method === "POST" && (params = matchRoute(pathname, "/api/upload/:fileId/chunk/:index"))) {
    const rl = checkRateLimit(ip);
    if (!rl.allowed) {
      return Response.json({ error: "Rate limited" }, {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfter) },
      });
    }
    return handleUpload(req, params as { fileId: string; index: string });
  }

  // Download chunk
  if (method === "GET" && (params = matchRoute(pathname, "/api/download/:fileId/chunk/:index"))) {
    return handleDownload(req, params as { fileId: string; index: string });
  }

  // Share page (HTML + OG tags)
  if (method === "GET" && (params = matchRoute(pathname, "/api/share/:token"))) {
    return handleSharePage(req, params as { token: string });
  }

  // Share info (JSON)
  if (method === "GET" && (params = matchRoute(pathname, "/api/share/:token/info"))) {
    return handleShareInfo(req, params as { token: string });
  }

  // Share verify password
  if (method === "POST" && (params = matchRoute(pathname, "/api/share/:token/verify-password"))) {
    return handleShareVerifyPassword(req, params as { token: string });
  }

  // Share chunk stream
  if (method === "GET" && (params = matchRoute(pathname, "/api/share/:token/chunk/:index"))) {
    return handleShareChunk(req, params as { token: string; index: string });
  }

  // Thumbnail
  if (method === "GET" && (params = matchRoute(pathname, "/api/thumbnail/:fileId"))) {
    return handleThumbnail(req, params as { fileId: string });
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
      ? await new Promise<Uint8Array>((resolve) => {
          const chunks: Buffer[] = [];
          nodeReq.on("data", (chunk: Buffer) => chunks.push(chunk));
          nodeReq.on("end", () => {
            const buf = Buffer.concat(chunks);
            resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
          });
        })
      : undefined;

  const request = new Request(url, {
    method: nodeReq.method,
    headers,
    body: bodyBuffer,
    duplex: bodyBuffer ? "half" : undefined,
  } as RequestInit);

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
  console.log(`Mode: ${serverConfig.appMode}${serverConfig.appMode === "backend-only" ? (serverConfig.apiKey ? " (API key required)" : " (open access — no API key set)") : ""}`);
});
