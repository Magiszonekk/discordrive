#!/usr/bin/env npx tsx
// DiscorDrive v4 — List all files in storage
//
// Usage:
//   npx tsx how-to-use/list.ts
//
// Required env vars (see .env):
//   DISCORDRIVE_URL=http://localhost:3000
//   API_KEY=your-api-key

import "dotenv/config";
import { gql, BASE } from "./_client.js";

const LIST_FILES = `
  query {
    files {
      id
      name
      size
      mimeType
      chunkCount
      status
      createdAt
    }
  }
`;

interface FileRecord {
  id: string;
  name: string;
  size: string;
  mimeType: string;
  chunkCount: number;
  status: string;
  createdAt: string;
}

async function main() {
  console.log(`\nListing files — ${BASE}\n`);

  const { files } = await gql<{ files: FileRecord[] }>(LIST_FILES);

  if (files.length === 0) {
    console.log("  (no files)\n");
    return;
  }

  // Print a simple table
  const idW = 28;
  const nameW = 30;
  const sizeW = 10;
  const statusW = 10;

  const pad = (s: string, w: number) => s.slice(0, w).padEnd(w);
  const hr = "-".repeat(idW + nameW + sizeW + statusW + 20);

  console.log(
    `  ${pad("ID", idW)}  ${pad("Name", nameW)}  ${pad("Size", sizeW)}  ${pad("Status", statusW)}  Created`,
  );
  console.log(`  ${hr}`);

  for (const f of files) {
    const sizeMB = `${(Number(f.size) / 1024 / 1024).toFixed(1)} MB`;
    const date = new Date(f.createdAt).toLocaleDateString();
    console.log(
      `  ${pad(f.id, idW)}  ${pad(f.name, nameW)}  ${pad(sizeMB, sizeW)}  ${pad(f.status, statusW)}  ${date}`,
    );
  }

  console.log(`\n  Total: ${files.length} file${files.length !== 1 ? "s" : ""}\n`);
}

main().catch((err) => {
  console.error("\nList failed:", err.message);
  process.exit(1);
});
