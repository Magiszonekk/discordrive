// DiscorDrive v4 — Auth resolvers (secure files v2)

import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@ddv4/database";
import { signToken } from "../middleware/auth.js";
import type { RegisterRequest, LoginResponse } from "@ddv4/types/api";
import { pluginRegistry } from "../plugin-registry.js";

function hashProof(proofBase64: string): Buffer {
  return createHash("sha256").update(Buffer.from(proofBase64, "base64")).digest();
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

export async function login(emailOrUsername: string, serverAuthProof: string): Promise<LoginResponse> {
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

  const token = signToken({ userId: user.id, email: user.email });

  return {
    token,
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
  wrappedARKByPassword: string,
  argon2Params: { memoryKB: number; iterations: number; parallelism: number; saltB64: string },
  serverAuthProof: string,
): Promise<boolean> {
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
