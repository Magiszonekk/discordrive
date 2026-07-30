// Usage: npx tsx examples/api-client/download.ts <fileId> <outputPath>

import { createWriteStream } from "node:fs";
import { downloadFile } from "./client.js";

const [fileId, outputPath] = process.argv.slice(2);

if (!fileId || !outputPath) {
  console.error("Usage: npx tsx examples/api-client/download.ts <fileId> <outputPath>");
  process.exit(1);
}

const out = createWriteStream(outputPath);
console.log(`Downloading ${fileId} → ${outputPath}`);
await downloadFile(fileId, (chunk) => out.write(chunk));
await new Promise<void>((resolve) => out.end(resolve));
console.log("Done.");
