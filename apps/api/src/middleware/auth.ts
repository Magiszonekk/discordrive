// DiscorDrive v4 — JWT authentication middleware

import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { serverConfig } from "@ddv4/config/server";

export interface AuthPayload {
  userId: string;
  email: string;
  // Device session id. Present only on tokens issued for a named device;
  // such tokens stay valid only while the session is active (revocable).
  sid?: string;
}

/** How a request proved its identity. Kept off AuthPayload so it is never signed into a JWT. */
export type AuthVia = "jwt" | "apikey" | "system";

export interface ResolvedAuth extends AuthPayload {
  via: AuthVia;
  /**
   * The presented authPart, kept only in memory for the life of the request so
   * apiKeyMaterial can find its own row. Never accept this as a query argument —
   * that would put the secret into GraphQL bodies and any log that captures them.
   */
  apiKeyAuthPart?: string;
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

export function isBackendOnly(): boolean {
  return serverConfig.appMode === "backend-only";
}

// --- Per-user API keys ---
// The operator's secret is `ddv4_<authPart>.<cryptoPart>`. Only `ddv4_<authPart>`
// is ever sent, as X-API-Key; cryptoPart stays client-side and unwraps the ARK.
// See the ApiKey model for why the split matters.
//
// The halves are base64url and joined with a dot: base64url's alphabet includes
// `_` but never `.`, so splitting the secret is unambiguous.

export const API_KEY_PREFIX = "ddv4_";

export class LeakedApiKeyError extends Error {
  constructor() {
    super(
      "This looks like a full API key including its cryptoPart. Send only the ddv4_<authPart> half. " +
        "Treat the key as compromised and issue a new one.",
    );
    this.name = "LeakedApiKeyError";
  }
}

/**
 * Pulls the authPart out of a presented X-API-Key value.
 * Throws if the caller sent the crypto half too — that secret is now in our
 * logs and request history, so failing loudly beats quietly accepting it.
 */
export function parseApiKeyHeader(raw: string): string | null {
  if (!raw.startsWith(API_KEY_PREFIX)) return null;
  const body = raw.slice(API_KEY_PREFIX.length);
  if (!body) return null;
  if (body.includes(".")) throw new LeakedApiKeyError();
  return body;
}

export function hashApiKeyAuthPart(authPart: string): string {
  return createHash("sha256").update(authPart).digest("hex");
}

// Chunk uploads hit this on every request, so a validated key is cached briefly
// and lastUsedAt is written at most once per window rather than per request.
const API_KEY_CACHE_MS = 60_000;
const apiKeyCache = new Map<string, { validUntil: number; auth: AuthPayload | null }>();

export function invalidateApiKeyCache(keyHash?: string): void {
  if (keyHash) apiKeyCache.delete(keyHash);
  else apiKeyCache.clear();
}

async function authFromApiKey(rawHeader: string): Promise<AuthPayload | null> {
  const authPart = parseApiKeyHeader(rawHeader);
  if (!authPart) return null;

  const keyHash = hashApiKeyAuthPart(authPart);
  const now = Date.now();
  const cached = apiKeyCache.get(keyHash);
  if (cached && now < cached.validUntil) return cached.auth;

  const { db } = await import("@ddv4/database");
  const record = await db.apiKey.findUnique({
    where: { keyHash },
    include: { user: true },
  });

  const usable =
    record && !record.revokedAt && (!record.expiresAt || record.expiresAt > new Date());
  const auth: AuthPayload | null = usable
    ? { userId: record.userId, email: record.user.email }
    : null;

  apiKeyCache.set(keyHash, { validUntil: now + API_KEY_CACHE_MS, auth });

  if (usable) {
    void db.apiKey
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }

  return auth;
}

/**
 * The single place any request turns into an identity, shared by GraphQL and
 * the blob endpoints so the two can never disagree about who is calling.
 *
 * Bearer JWT and X-API-Key are accepted side by side: the web UI and a script
 * can talk to the same instance at the same time, each as its own user.
 */
export async function resolveRequestAuth(request: Request): Promise<ResolvedAuth | null> {
  const bearer = extractToken(request);
  if (bearer) {
    try {
      return { ...(await verifySessionToken(bearer)), via: "jwt" };
    } catch {
      return null;
    }
  }

  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader) {
    // A per-user key wins whenever the value carries our prefix. Anything else
    // falls through to the legacy single-tenant key below.
    if (apiKeyHeader.startsWith(API_KEY_PREFIX)) {
      const auth = await authFromApiKey(apiKeyHeader);
      if (!auth) return null;
      return { ...auth, via: "apikey", apiKeyAuthPart: parseApiKeyHeader(apiKeyHeader) ?? undefined };
    }

    // Legacy backend-only mode: one shared key mapping to the system user.
    if (isBackendOnly() && serverConfig.apiKey && apiKeyHeader === serverConfig.apiKey) {
      return { userId: await getSystemUserId(), email: SYSTEM_USER_EMAIL, via: "system" };
    }
  }

  return null;
}
