// DiscorDrive v4 — Auth resolvers (register, login, changePassword)

import argon2 from "argon2";
import { db } from "@ddv4/database";
import { signToken } from "../middleware/auth.js";
import type { RegisterRequest, LoginResponse } from "@ddv4/types/api";

export async function register(input: RegisterRequest): Promise<LoginResponse> {
  const existing = await db.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new Error("Email already registered");
  }

  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

  const user = await db.user.create({
    data: {
      email: input.email,
      passwordHash,
      kekSalt: input.kekSalt,
      wrapIv: input.wrapIv,
      encryptedMasterKey: input.encryptedMasterKey,
    },
  });

  const token = signToken({ userId: user.id, email: user.email });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      kekSalt: user.kekSalt,
      wrapIv: user.wrapIv,
      encryptedMasterKey: user.encryptedMasterKey,
    },
  };
}

export async function login(
  email: string,
  password: string,
): Promise<LoginResponse> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error("Invalid email or password");
  }

  const valid = await argon2.verify(user.passwordHash, password);
  if (!valid) {
    throw new Error("Invalid email or password");
  }

  const token = signToken({ userId: user.id, email: user.email });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      kekSalt: user.kekSalt,
      wrapIv: user.wrapIv,
      encryptedMasterKey: user.encryptedMasterKey,
    },
  };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  newKekSalt: string,
  newWrapIv: string,
  newEncryptedMasterKey: string,
  reWrappedFEKs: Array<{ fileId: string; encryptedFEK: string; fekIv: string }>,
): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");

  const valid = await argon2.verify(user.passwordHash, currentPassword);
  if (!valid) throw new Error("Current password is incorrect");

  const newPasswordHash = await argon2.hash(newPassword, { type: argon2.argon2id });

  // Transaction: update user + re-wrap all FEKs
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash: newPasswordHash,
        kekSalt: newKekSalt,
        wrapIv: newWrapIv,
        encryptedMasterKey: newEncryptedMasterKey,
      },
    });

    // Batch update re-wrapped FEKs
    for (const fek of reWrappedFEKs) {
      await tx.file.update({
        where: { id: fek.fileId },
        data: {
          encryptedFEK: fek.encryptedFEK,
          fekIv: fek.fekIv,
        },
      });
    }
  });

  return true;
}
