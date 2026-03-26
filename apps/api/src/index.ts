// DiscorDrive v4 — API Server (Node.js HTTP/2 + GraphQL Yoga)

import "./env.js"; // Must be first — loads .env before other modules initialize

import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { existsSync, readFileSync } from "node:fs";

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

const debugUpload = process.env.DEBUG_UPLOAD === "1";

// Use HTTP/2 if TLS certs are configured, otherwise fall back to HTTP/1.1
const hasTls =
  serverConfig.tlsKeyPath &&
  serverConfig.tlsCertPath &&
  existsSync(serverConfig.tlsKeyPath) &&
  existsSync(serverConfig.tlsCertPath);

const requestHandler = async (nodeReq: import("node:http").IncomingMessage, nodeRes: import("node:http").ServerResponse) => {
  // Convert Node.js request to Web Request
  const protocol = hasTls ? "https" : "http";
  // HTTP/2 uses :authority pseudo-header instead of Host
  const host = (nodeReq.headers[":authority"] as string | undefined)
    ?? nodeReq.headers.host
    ?? `localhost:${port}`;
  const url = `${protocol}://${host}${nodeReq.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    // Skip HTTP/2 pseudo-headers (:method, :path, :scheme, :authority)
    if (key.startsWith(":") || !value) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const bodyReadStart = performance.now();
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

  if (debugUpload && bodyBuffer && bodyBuffer.byteLength > 1024 && nodeReq.url?.includes("/api/upload/")) {
    console.log(
      `[HTTP] ${nodeReq.method} ${nodeReq.url}: bodyRead=${(performance.now() - bodyReadStart).toFixed(0)}ms bodySize=${bodyBuffer.byteLength}`,
    );
  }

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
};

const tlsOptions = hasTls
  ? {
      key: readFileSync(serverConfig.tlsKeyPath),
      cert: readFileSync(serverConfig.tlsCertPath),
      allowHTTP1: true,
      settings: {
        initialWindowSize: 16 * 1024 * 1024, // 16MB per stream (default 64KB)
        maxFrameSize: 32 * 1024,              // 32KB frames (default 16KB)
      },
      maxSessionMemory: 256,                  // 256MB session memory (default 10MB)
    }
  : null;

function setupSessionWindow(s: import("node:http").Server | import("node:http2").Http2SecureServer) {
  if (hasTls) {
    s.on("session", (session: import("node:http2").ServerHttp2Session) => {
      session.setLocalWindowSize(128 * 1024 * 1024); // 128MB session window
    });
  }
}

const server = tlsOptions
  ? createSecureServer(tlsOptions, requestHandler as unknown as Parameters<typeof createSecureServer>[1])
  : createServer(requestHandler);
setupSessionWindow(server);

const scheme = hasTls ? "https" : "http";
server.listen(port, () => {
  console.log(`DiscorDrive API running on ${scheme}://localhost:${port}${hasTls ? " (HTTP/2)" : " (HTTP/1.1)"}`);
  console.log(`GraphQL endpoint: ${scheme}://localhost:${port}/graphql`);
  console.log(`Mode: ${serverConfig.appMode}${serverConfig.appMode === "backend-only" ? (serverConfig.apiKey ? " (API key required)" : " (open access — no API key set)") : ""}`);
});

// Additional upload ports — each port creates a separate HTTP/2 connection from the browser,
// bypassing the single-TCP-connection bottleneck that limits throughput to ~35 MB/s.
for (const uploadPort of serverConfig.uploadPorts) {
  if (uploadPort === port) continue; // skip if same as main port
  const uploadServer = tlsOptions
    ? createSecureServer(tlsOptions, requestHandler as unknown as Parameters<typeof createSecureServer>[1])
    : createServer(requestHandler);
  setupSessionWindow(uploadServer);
  uploadServer.listen(uploadPort, () => {
    console.log(`Upload port: ${scheme}://localhost:${uploadPort}`);
  });
}
