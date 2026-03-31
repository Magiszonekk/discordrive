#!/usr/bin/env npx tsx
// DiscorDrive v4 — Healthcheck script
// Verifies that chunks still exist on Discord and optionally checks integrity.
//
// Usage:
//   npx tsx scripts/healthcheck.ts --mode exists [options]
//   npx tsx scripts/healthcheck.ts --mode integrity [options]
//
// Options:
//   --mode exists|integrity   check mode (required)
//   --sample <pct>            % of files to check, 1–100 (default: 100)
//   --file <fileId>           check a specific file only
//   --concurrency <n>         parallel chunk checks (default: 5)
//   --dry-run                 don't write results to DB
//   --output <path>           save JSON report to file
//
// Auth (one of):
//   API_KEY env var           for backend-only mode
//   API_URL + login prompt    for full mode (not yet implemented, use API_KEY)
//
// Requires:
//   Running API server: npm run dev:api
//   Configured WEBHOOK_* in .env

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  parseWebhookUrls,
  WebhookRateLimiter,
  getChunkUrl,
  downloadChunk,
  type WebhookInfo,
} from "@discordrive/discord-client";
import {
  formatBytes,
  formatDuration,
  runPool,
  startTicker,
} from "./bench-utils.js";

// === Config ===

const apiPort = process.env.API_PORT ?? "3000";
const baseUrl = `http://localhost:${apiPort}`;
const apiKey = process.env.API_KEY ?? "";

// === Arg parsing ===

function parseArgs() {
  const args = process.argv.slice(2);
  let mode: string | null = null;
  let sample: number = 100;
  let fileId: string | undefined;
  let concurrency: number = 5;
  let dryRun = false;
  let outputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--mode":        mode = args[++i]; break;
      case "--sample":      sample = parseFloat(args[++i]); break;
      case "--file":        fileId = args[++i]; break;
      case "--concurrency": concurrency = parseInt(args[++i], 10); break;
      case "--dry-run":     dryRun = true; break;
      case "--output":      outputPath = args[++i]; break;
    }
  }

  if (!mode || (mode !== "exists" && mode !== "integrity")) {
    console.error('  ERROR: --mode is required. Use "exists" or "integrity".');
    process.exit(1);
  }
  if (sample < 1 || sample > 100 || isNaN(sample)) {
    console.error("  ERROR: --sample must be between 1 and 100.");
    process.exit(1);
  }

  return { mode, sample, fileId, concurrency, dryRun, outputPath };
}

// === GraphQL helper ===

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const res = await fetch(`${baseUrl}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}`);

  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors) throw new Error(`GraphQL error: ${json.errors[0].message}`);
  return json.data!;
}

// === GraphQL queries ===

const FILES_FOR_HEALTHCHECK = `
  query FilesForHealthCheck($samplePercent: Float) {
    filesForHealthCheck(samplePercent: $samplePercent) {
      fileId
      fileName
      chunkCount
      chunks {
        id
        index
        messageId
        webhookId
        size
        encryptedHash
        healthStatus
      }
    }
  }
`;

const UPDATE_BATCH = `
  mutation UpdateChunkHealthBatch($updates: [ChunkHealthUpdateInput!]!) {
    updateChunkHealthBatch(updates: $updates)
  }
`;

// === Types ===

type ChunkInfo = {
  id: string;
  index: number;
  messageId: string;
  webhookId: string;
  size: number;
  encryptedHash: string | null;
  healthStatus: string | null;
};

type FileInfo = {
  fileId: string;
  fileName: string;
  chunkCount: number;
  chunks: ChunkInfo[];
};

type CheckResult = {
  chunkId: string;
  fileId: string;
  fileName: string;
  index: number;
  status: "HEALTHY" | "MISSING" | "MODIFIED" | "SKIPPED";
  errorMsg?: string;
};

// === Main ===

async function main() {
  const { mode, sample, fileId, concurrency, dryRun, outputPath } = parseArgs();

  console.log();
  console.log("  DiscorDrive v4 — Healthcheck");
  console.log(`  Mode: ${mode.toUpperCase()}`);
  console.log(`  Sample: ${sample === 100 ? "all files" : `${sample}% of files`}`);
  if (fileId) console.log(`  File: ${fileId}`);
  console.log(`  Concurrency: ${concurrency}`);
  if (dryRun) console.log("  Dry-run: results will NOT be saved to DB");
  console.log();

  // Load webhooks from env
  const webhookUrls = Object.entries(process.env)
    .filter(([k]) => /^WEBHOOK_\d+$/.test(k))
    .map(([, v]) => v as string)
    .filter(Boolean);

  if (webhookUrls.length === 0) {
    console.error("  ERROR: No WEBHOOK_* env vars found. Check your .env file.");
    process.exit(1);
  }

  const whs = parseWebhookUrls(webhookUrls);
  const webhookMap = new Map<string, WebhookInfo>(whs.map((w) => [w.id, w]));
  const rateLimiter = new WebhookRateLimiter();

  // Fetch files from API
  console.log("  Fetching file/chunk metadata...");
  let files: FileInfo[];

  if (fileId) {
    const data = await gql<{ filesForHealthCheck: FileInfo[] }>(FILES_FOR_HEALTHCHECK, {});
    const found = data.filesForHealthCheck.find((f) => f.fileId === fileId);
    if (!found) {
      console.error(`  ERROR: File "${fileId}" not found or not accessible.`);
      process.exit(1);
    }
    files = [found];
  } else {
    const data = await gql<{ filesForHealthCheck: FileInfo[] }>(FILES_FOR_HEALTHCHECK, {
      samplePercent: sample < 100 ? sample : undefined,
    });
    files = data.filesForHealthCheck;
  }

  const allChunks = files.flatMap((f) =>
    f.chunks.map((c) => ({ ...c, fileId: f.fileId, fileName: f.fileName })),
  );

  const totalChunks = allChunks.length;
  const totalFiles = files.length;
  const totalBytes = allChunks.reduce((s, c) => s + c.size, 0);

  console.log(`  Files to check:  ${totalFiles}`);
  console.log(`  Chunks to check: ${totalChunks}`);
  console.log(`  Estimated data:  ${formatBytes(totalBytes)} (integrity mode only)`);
  console.log();

  if (totalChunks === 0) {
    console.log("  Nothing to check.");
    return;
  }

  // Run health checks
  const results: CheckResult[] = [];
  const completed = { count: 0, bytes: 0 };
  const startTime = performance.now();

  const ticker = startTicker(
    `${mode} check`,
    totalChunks,
    completed,
    startTime,
  );

  const tasks = allChunks.map((chunk) => async (): Promise<CheckResult> => {
    const webhook = webhookMap.get(chunk.webhookId);

    if (!webhook) {
      completed.count++;
      return {
        chunkId: chunk.id,
        fileId: chunk.fileId,
        fileName: chunk.fileName,
        index: chunk.index,
        status: "SKIPPED",
        errorMsg: `Webhook ${chunk.webhookId} not found in env`,
      };
    }

    let status: "HEALTHY" | "MISSING" | "MODIFIED" | "SKIPPED";
    let errorMsg: string | undefined;

    try {
      if (mode === "exists") {
        await getChunkUrl(webhook, chunk.messageId, rateLimiter);
        status = "HEALTHY";
      } else {
        // integrity
        if (!chunk.encryptedHash) {
          completed.count++;
          return {
            chunkId: chunk.id,
            fileId: chunk.fileId,
            fileName: chunk.fileName,
            index: chunk.index,
            status: "SKIPPED",
            errorMsg: "No encryptedHash stored (uploaded before healthcheck was enabled)",
          };
        }
        const stream = await downloadChunk(webhook, chunk.messageId, rateLimiter);
        const reader = stream.getReader();
        const hasher = createHash("sha256");
        let downloadedBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          hasher.update(value);
          downloadedBytes += value.byteLength;
        }
        const hash = hasher.digest("hex");
        status = hash === chunk.encryptedHash ? "HEALTHY" : "MODIFIED";
        completed.bytes += downloadedBytes;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status = "MISSING";
      errorMsg = msg;
    }

    completed.count++;
    return {
      chunkId: chunk.id,
      fileId: chunk.fileId,
      fileName: chunk.fileName,
      index: chunk.index,
      status,
      errorMsg,
    };
  });

  const checkResults = await runPool(tasks, concurrency);
  results.push(...checkResults);

  clearInterval(ticker);
  process.stdout.write("\r" + " ".repeat(80) + "\r");

  // Aggregate
  const healthy  = results.filter((r) => r.status === "HEALTHY").length;
  const missing  = results.filter((r) => r.status === "MISSING").length;
  const modified = results.filter((r) => r.status === "MODIFIED").length;
  const skipped  = results.filter((r) => r.status === "SKIPPED").length;
  const elapsed  = performance.now() - startTime;

  // Print results
  console.log("═══════════════════════════════════════════");
  console.log("  HEALTHCHECK RESULTS");
  console.log("═══════════════════════════════════════════");
  console.log();
  console.log(`  Files checked:   ${totalFiles}`);
  console.log(`  Chunks checked:  ${healthy + missing + modified}`);
  console.log(`  ✓ Healthy:       ${healthy}`);
  console.log(`  ✗ Missing:       ${missing}`);
  if (mode === "integrity") {
    console.log(`  ⚠ Modified:      ${modified}`);
  }
  if (skipped > 0) {
    console.log(`  - Skipped:       ${skipped}`);
  }
  console.log(`  Duration:        ${formatDuration(elapsed)}`);
  if (mode === "integrity" && completed.bytes > 0) {
    const mbps = (completed.bytes / (1024 * 1024)) / (elapsed / 1000);
    console.log(`  Download speed:  ${mbps.toFixed(2)} MB/s`);
  }
  console.log();

  // Show problem chunks
  const problems = results.filter((r) => r.status !== "HEALTHY" && r.status !== "SKIPPED");
  if (problems.length > 0) {
    console.log("  Problem chunks:");
    for (const p of problems) {
      console.log(`    [${p.status}] ${p.fileName} — chunk #${p.index} (${p.chunkId})`);
      if (p.errorMsg) console.log(`           ${p.errorMsg}`);
    }
    console.log();
  }

  // Persist results to DB
  if (!dryRun) {
    const updates = results
      .filter((r) => r.status !== "SKIPPED")
      .map((r) => ({ chunkId: r.chunkId, status: r.status }));

    if (updates.length > 0) {
      console.log("  Saving results to DB...");
      await gql(UPDATE_BATCH, { updates });
      console.log(`  Saved ${updates.length} chunk statuses.`);
    }
  } else {
    console.log("  Dry-run — results NOT saved to DB.");
  }

  // Save JSON report
  if (outputPath) {
    const report = {
      timestamp: new Date().toISOString(),
      mode,
      sample,
      fileId,
      summary: { totalFiles, totalChunks, healthy, missing, modified, skipped, durationMs: Math.round(elapsed) },
      problems: problems.map((p) => ({
        chunkId: p.chunkId,
        fileId: p.fileId,
        fileName: p.fileName,
        chunkIndex: p.index,
        status: p.status,
        error: p.errorMsg,
      })),
    };
    writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(`  Report saved to: ${outputPath}`);
  }

  console.log();
  process.exit(problems.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n  FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
