// DiscorDrive v4 — JWT authentication middleware

import jwt from "jsonwebtoken";
import { serverConfig } from "@ddv4/config/server";

export interface AuthPayload {
  userId: string;
  email: string;
  // Device session id. Present only on tokens issued for a named device;
  // such tokens stay valid only while the session is active (revocable).
  sid?: string;
}

export function signToken(payload: AuthPayload, expiresIn?: string): string {
  return jwt.sign(payload, serverConfig.jwtSecret, {
    expiresIn: expiresIn ?? serverConfig.jwtExpiresIn,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, serverConfig.jwtSecret) as AuthPayload;
}

// --- Device session validation ---
// Session-bound tokens are checked against the DB so revocation takes effect
// before JWT expiry. A short cache keeps this off the hot path (chunk uploads).

const SESSION_CACHE_MS = 60_000;
const sessionCache = new Map<string, { validUntil: number; ok: boolean }>();

export function invalidateSessionCache(sid: string): void {
  sessionCache.delete(sid);
}

export async function isSessionActive(sid: string): Promise<boolean> {
  const now = Date.now();
  const cached = sessionCache.get(sid);
  if (cached && now < cached.validUntil) return cached.ok;

  const { db } = await import("@ddv4/database");
  const session = await db.deviceSession.findUnique({ where: { id: sid } });
  const ok = Boolean(session && !session.revokedAt && session.expiresAt > new Date());
  sessionCache.set(sid, { validUntil: now + SESSION_CACHE_MS, ok });
  return ok;
}

export async function verifySessionToken(token: string): Promise<AuthPayload> {
  const payload = verifyToken(token);
  if (payload.sid && !(await isSessionActive(payload.sid))) {
    throw new Error("Session revoked or expired");
  }
  return payload;
}

export function extractToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

export async function authenticateRequest(request: Request): Promise<AuthPayload> {
  const token = extractToken(request);
  if (!token) {
    throw new Error("Authentication required");
  }
  return verifySessionToken(token);
}

const SYSTEM_USER_EMAIL = "system@ddv4.local";
let cachedSystemUserId: string | null = null;

export async function getSystemUserId(): Promise<string> {
  if (cachedSystemUserId) return cachedSystemUserId;

  const { db } = await import("@ddv4/database");
  let user = await db.user.findUnique({ where: { email: SYSTEM_USER_EMAIL } });

  if (!user) {
    user = await db.user.create({
      data: {
        email: SYSTEM_USER_EMAIL,
      },
    });

    await db.userCrypto.create({
      data: {
        userId: user.id,
        wrappedARKByPassword: new Uint8Array(),
        wrappedARKByRecovery: new Uint8Array(),
        argon2MemoryKB: 0,
        argon2Iterations: 0,
        argon2Parallelism: 0,
        argon2SaltB64: "",
      },
    });
  }

  cachedSystemUserId = user.id;
  return cachedSystemUserId;
}

function validateApiKey(request: Request): boolean {
  if (!serverConfig.apiKey) return true;
  const key = request.headers.get("x-api-key");
  return key === serverConfig.apiKey;
}

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
