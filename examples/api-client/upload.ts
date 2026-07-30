// Usage: npx tsx examples/api-client/upload.ts <path> [parentFolderId]

import { uploadFile } from "./client.js";

const [path, parentFolderId] = process.argv.slice(2);

if (!path) {
  console.error("Usage: npx tsx examples/api-client/upload.ts <path> [parentFolderId]");
  process.exit(1);
}

console.log(`Uploading ${path}`);
const fileId = await uploadFile(path, parentFolderId ?? null);
console.log(`Done. File id: ${fileId}`);
console.log("It is now visible in the web app under the same account.");
