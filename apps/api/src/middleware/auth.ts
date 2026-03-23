// DiscorDrive v4 — JWT authentication middleware

import jwt from "jsonwebtoken";
import { serverConfig } from "@ddv4/config/server";

export interface AuthPayload {
  userId: string;
  email: string;
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, serverConfig.jwtSecret, {
    expiresIn: serverConfig.jwtExpiresIn,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, serverConfig.jwtSecret) as AuthPayload;
}

export function extractToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

export function authenticateRequest(request: Request): AuthPayload {
  const token = extractToken(request);
  if (!token) {
    throw new Error("Authentication required");
  }
  return verifyToken(token);
}

// === Backend-only mode helpers ===

const SYSTEM_USER_EMAIL = "system@ddv4.local";
let cachedSystemUserId: string | null = null;

/**
 * Get or create the system user for backend-only mode.
 * Cached after first call.
 */
export async function getSystemUserId(): Promise<string> {
  if (cachedSystemUserId) return cachedSystemUserId;

  const { db } = await import("@ddv4/database");
  let user = await db.user.findUnique({ where: { email: SYSTEM_USER_EMAIL } });

  if (!user) {
    user = await db.user.create({
      data: {
        email: SYSTEM_USER_EMAIL,
        passwordHash: "backend-only-no-password",
        kekSalt: "",
        wrapIv: "",
        encryptedMasterKey: "",
      },
    });
  }

  cachedSystemUserId = user.id;
  return cachedSystemUserId;
}

function validateApiKey(request: Request): boolean {
  if (!serverConfig.apiKey) return true; // No API key configured = open access
  const key = request.headers.get("x-api-key");
  return key === serverConfig.apiKey;
}

/**
 * Authenticate request — works in both modes:
 * - full: JWT Bearer token (existing behavior)
 * - backend-only: X-API-Key header → system user
 */
export async function authenticateRequestAny(request: Request): Promise<AuthPayload> {
  if (serverConfig.appMode === "backend-only") {
    if (!validateApiKey(request)) {
      throw new Error("Invalid API key");
    }
    const userId = await getSystemUserId();
    return { userId, email: SYSTEM_USER_EMAIL };
  }
  return authenticateRequest(request);
}

export function isBackendOnly(): boolean {
  return serverConfig.appMode === "backend-only";
}
