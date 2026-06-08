// DiscorDrive v4 — Seed script to create default user "Magiszonek" after reset
// This script runs automatically when the API server starts.

import { db } from "@ddv4/database";
import { createHash } from "node:crypto";
import {
  generateARK,
  generateDomainKey,
  generateRootFEK,
  deriveLoginMaterial,
  wrapDomainKey,
  wrapKey,
  generateSalt,
  toBase64,
} from "@ddv4/processing";

interface CryptoData {
  wrappedARKByPassword: string;
  wrappedARKByRecovery: string;
  argon2Params: {
    memoryKB: number;
    iterations: number;
    parallelism: number;
    saltB64: string;
  };
  serverAuthProofHash: string;
  ark: CryptoKey;
  filesKey: CryptoKey;
  wrappedFilesKey: string;
  wrappedFilesKeyIv: string;
  rootFek: CryptoKey;
  wrappedFEK: string;
  wrappedFEKIv: string;
}

async function generateCryptoData(): Promise<CryptoData> {
  // Generate random salt and parameters similar to frontend registration
  const salt = generateSalt();
  const params = {
    memoryKB: 19456,
    iterations: 2,
    parallelism: 1,
    saltB64: toBase64(salt),
  };

  const password = "Magiszonek_dev_2025!";

  // Generate keys
  const ark = await generateARK();
  const filesKey = await generateDomainKey();
  const rootFek = await generateRootFEK();

  // Single Argon2 run — derives ARK-wrapping key and server auth proof
  const { arkWrapKey, serverAuthProof } = await deriveLoginMaterial(password, params);

  const wrappedArkData = await wrapKey(ark, arkWrapKey);
  const wrappedFilesKey = await wrapDomainKey(filesKey, ark);
  const wrappedRootFek = await wrapKey(rootFek, filesKey);

  function packWithIv(data: ArrayBuffer, iv: Uint8Array): Uint8Array {
    const packed = new Uint8Array(iv.byteLength + data.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(data), iv.byteLength);
    return packed;
  }

  const serverAuthProofHash = createHash("sha256")
    .update(Buffer.from(toBase64(serverAuthProof), "base64"))
    .digest("hex");

  return {
    wrappedARKByPassword: toBase64(packWithIv(wrappedArkData.data, wrappedArkData.iv)),
    wrappedARKByRecovery: toBase64(packWithIv(wrappedArkData.data, wrappedArkData.iv)),
    argon2Params: params,
    serverAuthProofHash,
    ark,
    filesKey,
    wrappedFilesKey: toBase64(wrappedFilesKey.data),
    wrappedFilesKeyIv: toBase64(wrappedFilesKey.iv),
    rootFek,
    wrappedFEK: toBase64(wrappedRootFek.data),
    wrappedFEKIv: toBase64(wrappedRootFek.iv),
  };
}

// Helper for random bytes
function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function createMagiszonekIfNeeded(): Promise<void> {
  // Check if user with username "Magiszonek" exists
  const existingUser = await db.user.findUnique({
    where: { username: "Magiszonek" },
  });

  if (existingUser) {
    console.log("User Magiszonek already exists, skipping creation.");
    return;
  }

  console.log("Creating user Magiszonek...");

  // Generate crypto data
  const cryptoData = await generateCryptoData();

  // Generate random email to avoid uniqueness conflicts
  const randomPart = Math.random().toString(36).substring(2, 15);
  const email = `magiszonek-${randomPart}@example.com`;

  // Create user with crypto
  await db.user.create({
    data: {
      email,
      username: "Magiszonek",
      crypto: {
        create: {
          wrappedARKByPassword: cryptoData.wrappedARKByPassword,
          wrappedARKByRecovery: cryptoData.wrappedARKByRecovery,
          argon2MemoryKB: cryptoData.argon2Params.memoryKB,
          argon2Iterations: cryptoData.argon2Params.iterations,
          argon2Parallelism: cryptoData.argon2Params.parallelism,
          argon2SaltB64: cryptoData.argon2Params.saltB64,
          serverAuthProofHash: cryptoData.serverAuthProofHash,
        },
      },
    },
    include: { crypto: true },
  });

  console.log(`Created user Magiszonek with email: ${email}, password: Magiszonek_dev_2025!`);
}
