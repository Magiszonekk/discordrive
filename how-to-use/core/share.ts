#!/usr/bin/env npx tsx
// DiscorDrive v4 — Create a public share link for a file
//
// Usage:
//   npx tsx how-to-use/core/share.ts <fileId> <encryptedFEK> <fekIv>
//
// The share link embeds a random share key in the URL fragment (#).
// The fragment is never sent to the server — the key stays client-side.
//
// Required env vars (see .env):
//   DISCORDRIVE_URL=http://localhost:3000
//   API_KEY=your-api-key
//   MASTER_KEY=<base64>

import { randomBytes } from "node:crypto";
import { fromBase64, unwrapKey, wrapKey, importKey, toBase64 } from "@discordrive/processing";
import { gql, getMasterKey, BASE } from "./_client.js";

const [fileId, encryptedFEK, fekIv] = process.argv.slice(2);

if (!fileId || !encryptedFEK || !fekIv) {
  console.error(
    "Usage: npx tsx how-to-use/core/share.ts <fileId> <encryptedFEK> <fekIv>",
  );
  process.exit(1);
}

const CREATE_SHARE_LINK = `
  mutation(
    $fileId: ID!, $wrappedFEK: String!, $wrapIv: String!
    $label: String
  ) {
    createShareLink(
      fileId: $fileId, wrappedFEK: $wrappedFEK, wrapIv: $wrapIv
      label: $label
    ) {
      token
    }
  }
`;

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

async function main() {
  const masterKey = await getMasterKey();

  // Unwrap the FEK using the Master Key
  const wrappedBytes = fromBase64(encryptedFEK);
  const wrappedBuf = wrappedBytes.buffer.slice(
    wrappedBytes.byteOffset,
    wrappedBytes.byteOffset + wrappedBytes.byteLength,
  ) as ArrayBuffer;
  const ivBytes = fromBase64(fekIv);

  // Need encrypt+decrypt usages so the FEK can be re-wrapped (it must be extractable)
  const fek = await unwrapKey(wrappedBuf, masterKey, ivBytes, ["encrypt", "decrypt"]);

  // Generate a random 256-bit share key (never stored on the server)
  const shareKeyRaw = randomBytes(32);
  const shareKeyBuf = shareKeyRaw.buffer.slice(
    shareKeyRaw.byteOffset,
    shareKeyRaw.byteOffset + shareKeyRaw.byteLength,
  ) as ArrayBuffer;

  // Import share key as a CryptoKey for wrapping
  const shareKey = await importKey(shareKeyBuf, ["wrapKey"]);

  // Wrap the FEK with the share key
  const rewrapped = await wrapKey(fek, shareKey);
  const wrappedFEK = toBase64(rewrapped.data);
  const wrapIv = toBase64(rewrapped.iv);

  // Create the share link on the server (stores wrappedFEK — NOT the share key)
  const { createShareLink } = await gql<{
    createShareLink: { token: string };
  }>(CREATE_SHARE_LINK, {
    fileId,
    wrappedFEK,
    wrapIv,
    label: `shared via CLI ${new Date().toISOString().slice(0, 10)}`,
  });

  const shareKeyB64 = toBase64(shareKeyRaw);
  const shareUrl = `${FRONTEND_URL}/share/${createShareLink.token}#${shareKeyB64}`;

  console.log(`\n  Share link created.\n`);
  console.log(`  ${shareUrl}\n`);
  console.log("  The #fragment contains the share key — it never reaches the server.");
  console.log("  Anyone with this URL can download and decrypt the file.\n");
}

main().catch((err) => {
  console.error("\nShare failed:", err.message);
  process.exit(1);
});
