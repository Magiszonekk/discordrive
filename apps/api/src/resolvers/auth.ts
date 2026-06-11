// DiscorDrive v4 — Auth resolvers (secure files v2)

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@ddv4/database";
import { signToken, invalidateSessionCache } from "../middleware/auth.js";
import type { RegisterRequest, LoginResponse } from "@ddv4/types/api";
import { pluginRegistry } from "../plugin-registry.js";

function hashProof(proofBase64: string): Buffer {
  return createHash("sha256").update(Buffer.from(proofBase64, "base64")).digest();
}

// === Device sessions ===
// A login with a deviceName creates a revocable session: the client receives a
// long-lived opaque refresh token (stored hashed) plus a short-lived JWT bound
// to the session via the `sid` claim. Revoking the session kills both.

const SESSION_REFRESH_TTL_DAYS = 180;
const SESSION_ACCESS_TOKEN_TTL = "1h";

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function createDeviceSession(
  userId: string,
  email: string,
  deviceName: string,
): Promise<{ token: string; refreshToken: string }> {
  const refreshToken = randomBytes(32).toString("base64url");
  const session = await db.deviceSession.create({
    data: {
      userId,
      deviceName,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + SESSION_REFRESH_TTL_DAYS * 86_400_000),
    },
  });

  const token = signToken({ userId, email, sid: session.id }, SESSION_ACCESS_TOKEN_TTL);
  return { token, refreshToken };
}

export async function refreshSession(refreshToken: string): Promise<{ token: string }> {
  const session = await db.deviceSession.findUnique({
    where: { refreshTokenHash: hashRefreshToken(refreshToken) },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw new Error("Invalid or expired session");
  }

  await db.deviceSession.update({
    where: { id: session.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    token: signToken({ userId: session.userId, email: session.user.email, sid: session.id }, SESSION_ACCESS_TOKEN_TTL),
  };
}

export async function listSessions(userId: string) {
  return db.deviceSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
  });
}

export async function revokeSession(userId: string, sessionId: string): Promise<boolean> {
  const session = await db.deviceSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new Error("Session not found");

  await db.deviceSession.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
  invalidateSessionCache(sessionId);
  return true;
}

export async function getLoginChallenge(emailOrUsername: string) {
  const user = await db.user.findFirst({
    where: { OR: [{ email: emailOrUsername }, { username: emailOrUsername }] },
    include: { crypto: true },
  });
  if (!user?.crypto) return null;
  return {
    argon2Params: {
      memoryKB: user.crypto.argon2MemoryKB,
      iterations: user.crypto.argon2Iterations,
      parallelism: user.crypto.argon2Parallelism,
      saltB64: user.crypto.argon2SaltB64,
    },
  };
}

export async function register(input: RegisterRequest): Promise<LoginResponse> {
  const existingEmail = await db.user.findUnique({ where: { email: input.email } });
  if (existingEmail) throw new Error("Email already registered");

  const existingUsername = await db.user.findUnique({ where: { username: input.username } });
  if (existingUsername) throw new Error("Username already taken");

  const user = await db.user.create({
    data: {
      email: input.email,
      username: input.username,
      crypto: {
        create: {
          wrappedARKByPassword: Buffer.from(input.wrappedARKByPassword, "base64"),
          wrappedARKByRecovery: Buffer.from(input.wrappedARKByRecovery, "base64"),
          argon2MemoryKB: input.argon2Params.memoryKB,
          argon2Iterations: input.argon2Params.iterations,
          argon2Parallelism: input.argon2Params.parallelism,
          argon2SaltB64: input.argon2Params.saltB64,
          serverAuthProofHash: hashProof(input.serverAuthProof).toString("hex"),
        },
      },
    },
    include: { crypto: true },
  });

  const token = signToken({ userId: user.id, email: user.email });
  await pluginRegistry.emitAsync("user:registered", { userId: user.id, email: user.email });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      crypto: {
        wrappedARKByPassword: Buffer.from(user.crypto!.wrappedARKByPassword).toString("base64"),
        wrappedARKByRecovery: Buffer.from(user.crypto!.wrappedARKByRecovery).toString("base64"),
        argon2Params: {
          memoryKB: user.crypto!.argon2MemoryKB,
          iterations: user.crypto!.argon2Iterations,
          parallelism: user.crypto!.argon2Parallelism,
          saltB64: user.crypto!.argon2SaltB64,
        },
        lastPasswordChangeAt: user.crypto!.lastPasswordChangeAt.toISOString(),
      },
    },
  };
}

export async function login(
  emailOrUsername: string,
  serverAuthProof: string,
  deviceName?: string | null,
): Promise<LoginResponse> {
  const user = await db.user.findFirst({
    where: { OR: [{ email: emailOrUsername }, { username: emailOrUsername }] },
    include: { crypto: true },
  });

  if (!user?.crypto?.serverAuthProofHash) throw new Error("Invalid credentials");

  const presented = hashProof(serverAuthProof);
  const stored = Buffer.from(user.crypto.serverAuthProofHash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    throw new Error("Invalid credentials");
  }

  // Named device → revocable session with refresh token; otherwise a plain JWT
  let token: string;
  let refreshToken: string | undefined;
  if (deviceName?.trim()) {
    ({ token, refreshToken } = await createDeviceSession(user.id, user.email, deviceName.trim()));
  } else {
    token = signToken({ userId: user.id, email: user.email });
  }

  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      crypto: {
        wrappedARKByPassword: Buffer.from(user.crypto.wrappedARKByPassword).toString("base64"),
        wrappedARKByRecovery: Buffer.from(user.crypto.wrappedARKByRecovery).toString("base64"),
        argon2Params: {
          memoryKB: user.crypto.argon2MemoryKB,
          iterations: user.crypto.argon2Iterations,
          parallelism: user.crypto.argon2Parallelism,
          saltB64: user.crypto.argon2SaltB64,
        },
        lastPasswordChangeAt: user.crypto.lastPasswordChangeAt.toISOString(),
      },
    },
  };
}

export async function changePassword(
  userId: string,
  currentServerAuthProof: string,
  wrappedARKByPassword: string,
  argon2Params: { memoryKB: number; iterations: number; parallelism: number; saltB64: string },
  serverAuthProof: string,
): Promise<boolean> {
  // Require proof of the current password — a stolen JWT alone must not be able
  // to overwrite the wrapped ARK (would lock the real user out of their data).
  const existing = await db.userCrypto.findUnique({ where: { userId } });
  if (!existing?.serverAuthProofHash) throw new Error("Invalid credentials");

  const presented = hashProof(currentServerAuthProof);
  const stored = Buffer.from(existing.serverAuthProofHash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    throw new Error("Current password is incorrect");
  }

  await db.userCrypto.update({
    where: { userId },
    data: {
      wrappedARKByPassword: Buffer.from(wrappedARKByPassword, "base64"),
      argon2MemoryKB: argon2Params.memoryKB,
      argon2Iterations: argon2Params.iterations,
      argon2Parallelism: argon2Params.parallelism,
      argon2SaltB64: argon2Params.saltB64,
      serverAuthProofHash: hashProof(serverAuthProof).toString("hex"),
      lastPasswordChangeAt: new Date(),
    },
  });

  return true;
}
