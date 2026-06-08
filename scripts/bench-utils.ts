// DiscorDrive v4 — Shared benchmark utilities
// Used by both benchmark.ts (Discord-only) and benchmark-e2e.ts (full pipeline).

// === Formatting ===

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}min`;
}

export function throughput(bytes: number, ms: number): string {
  if (ms === 0) return "∞";
  const mbps = (bytes / (1024 * 1024)) / (ms / 1000);
  return `${mbps.toFixed(2)} MB/s`;
}

// === Types ===

export interface TimingResult {
  label: string;
  durationMs: number;
  bytes?: number;
}

export interface DiagStats {
  rateLimitWaits: number;
  http429s: number;
  webhookChunks: Map<string, number>;
  webhook429s: Map<string, number>;
}

export function newDiagStats(): DiagStats {
  return {
    rateLimitWaits: 0,
    http429s: 0,
    webhookChunks: new Map(),
    webhook429s: new Map(),
  };
}

export function printDiagStats(stats: DiagStats, label: string): void {
  console.log(`\n  ${label} diagnostics:`);
  console.log(`    Rate-limit waits:  ${stats.rateLimitWaits}`);
  console.log(`    HTTP 429s:         ${stats.http429s}`);
  if (stats.webhookChunks.size > 0) {
    console.log(`    Per-webhook chunks:`);
    for (const [id, count] of stats.webhookChunks) {
      const short = id.slice(-6);
      const n429 = stats.webhook429s.get(id) ?? 0;
      console.log(`      ...${short}: ${count} chunks${n429 > 0 ? `, ${n429} 429s` : ""}`);
    }
  }
}

// === Worker pool ===

export async function runPool<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const idx = nextIdx;
      if (idx >= tasks.length) break;
      nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

// === Progress ticker ===

export function startTicker(
  label: string,
  totalChunks: number,
  completedRef: { count: number; bytes: number },
  startTime: number,
): NodeJS.Timeout {
  return setInterval(() => {
    const elapsed = performance.now() - startTime;
    const pct = Math.round((completedRef.count / totalChunks) * 100);
    const rate = completedRef.bytes > 0
      ? throughput(completedRef.bytes, elapsed)
      : `${(completedRef.count / (elapsed / 1000)).toFixed(1)} msgs/s`;
    process.stdout.write(`\r  ${label}: ${completedRef.count}/${totalChunks} (${pct}%) — ${rate}    `);
  }, 500);
}

// === Size parser ===

export function parseSize(input: string): number {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/i);
  if (!match) {
    console.error(`  ERROR: Invalid size "${input}". Examples: 100, 100MB, 2GB, 500KB`);
    process.exit(1);
  }
  const value = parseFloat(match[1]);
  const unit = (match[2] ?? "MB").toUpperCase();
  const multipliers: Record<string, number> = {
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return Math.round(value * multipliers[unit]);
}

// === Summary printer ===

export function printSummary(timings: TimingResult[]): void {
  const totalMs = timings.reduce((sum, t) => sum + t.durationMs, 0);

  console.log("═══════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════");
  console.log();

  for (const t of timings) {
    const tp = t.bytes ? ` (${throughput(t.bytes, t.durationMs)})` : "";
    console.log(`  ${t.label.padEnd(22)} ${formatDuration(t.durationMs).padStart(10)}${tp}`);
  }

  console.log(`  ${"─".repeat(42)}`);
  console.log(`  ${"Total".padEnd(22)} ${formatDuration(totalMs).padStart(10)}`);
  console.log();
}

export function printChunkStats(
  label: string,
  times: number[],
): void {
  const valid = times.filter((t) => t !== undefined);
  if (valid.length === 0) return;

  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const min = Math.min(...valid);
  const max = Math.max(...valid);

  console.log(`  Per-chunk ${label.padEnd(10)}` +
    `avg=${formatDuration(avg)}, min=${formatDuration(min)}, max=${formatDuration(max)}`);
}
