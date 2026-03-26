#!/usr/bin/env npx tsx
// DiscorDrive v4 — Delete a file from storage
//
// Usage:
//   npx tsx how-to-use/delete.ts <fileId>
//
// Required env vars (see .env):
//   DISCORDRIVE_URL=http://localhost:3000
//   API_KEY=your-api-key

import "dotenv/config";
import { gql, BASE } from "./_client.js";

const fileId = process.argv[2];
if (!fileId) {
  console.error("Usage: npx tsx how-to-use/delete.ts <fileId>");
  process.exit(1);
}

const DELETE_FILE = `
  mutation($fileId: ID!) {
    deleteFile(fileId: $fileId)
  }
`;

async function main() {
  console.log(`\nDeleting file: ${fileId}`);
  console.log(`  API: ${BASE}\n`);

  const { deleteFile } = await gql<{ deleteFile: boolean }>(DELETE_FILE, { fileId });

  if (deleteFile) {
    console.log("  Done. File deleted from database.");
    console.log("  Discord messages are being removed in the background.\n");
  } else {
    console.error("  Failed — file not found or not authorized.\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nDelete failed:", err.message);
  process.exit(1);
});
