// Usage: npx tsx examples/api-client/list.ts [parentFolderId]

import { listFiles } from "./client.js";

const files = await listFiles(process.argv[2] ?? null);

if (files.length === 0) {
  console.log("No files.");
} else {
  for (const f of files) {
    const mb = (f.size / 1024 / 1024).toFixed(1).padStart(8);
    console.log(`${f.id}  ${mb} MB  ${f.status.padEnd(9)}  ${f.name}`);
  }
}
