// DiscorDrive v4 — Server-only configuration (reads process.env)
// NEVER import this from browser/frontend code.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppMode } from "@ddv4/types";

const __configDir = dirname(fileURLToPath(import.meta.url));

/** Resolve a path relative to the project root (3 levels up from this file). */
function resolveFromRoot(p: string): string {
  if (!p) return "";
  // Absolute paths stay as-is; relative paths resolve from project root
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return p;
  // This file lives at packages/config/src/server.ts → root is ../../../
  return resolve(__configDir, "../../..", p);
}

/**
 * Collect webhook URLs from env vars: WEBHOOK_1, WEBHOOK_2, ...
 * Supports up to 50 webhooks.
 */
function collectWebhooks(): string[] {
  const webhooks: string[] = [];
  for (let i = 1; i <= 50; i++) {
    const url = process.env[`WEBHOOK_${i}`];
    if (url?.trim()) {
      webhooks.push(url.trim());
    }
  }
  return webhooks;
}

export const serverConfig = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  webhooks: collectWebhooks(),
  jwtSecret: process.env.JWT_SECRET ?? "change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  appMode: (process.env.APP_MODE ?? "full") as AppMode,
  apiPort: parseInt(process.env.API_PORT ?? "3000", 10),
  frontendPort: parseInt(process.env.FRONTEND_PORT ?? "5173", 10),
  apiUrl: process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? "3000"}`,
  frontendUrl: process.env.FRONTEND_URL ?? `http://localhost:${process.env.FRONTEND_PORT ?? "5173"}`,
  apiKey: process.env.API_KEY ?? "",
  tlsKeyPath: resolveFromRoot(process.env.TLS_KEY_PATH ?? ""),
  tlsCertPath: resolveFromRoot(process.env.TLS_CERT_PATH ?? ""),
  uploadPorts: (process.env.UPLOAD_PORTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n) && n > 0),
};
