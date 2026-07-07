// DiscorDrive v4 — Discord vs Telegram transport throughput benchmark
//
// Uploads then downloads N ciphertext-sized chunks through each provider's
// real client and reports per-chunk transfer speed plus sustained wall-clock
// throughput (which includes each provider's rate-limit pacing).
//
// Usage (reads senders from env / .env):
//   WEBHOOK_1=… TG_BOT_1=… TG_BOT_1_CHAT=… npx tsx scripts/provider-benchmark.ts
//   CHUNKS=4 npx tsx scripts/provider-benchmark.ts

import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import {
  WebhookRateLimiter,
  deleteChunk,
  downloadChunk,
  parseWebhookUrls,
  uploadChunk,
} from "@ddv4/discord-client";
import {
  TelegramRateLimiter,
  deleteMessage,
  downloadDocument,
  uploadDocument,
} from "@ddv4/telegram-client";

const CHUNK = 10 * 1024 * 1024 - 28; // production chunk size
const N = Number(process.env.CHUNKS ?? "4");

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};
const mbps = (bytes: number, ms: number) => (bytes / 1e6 / (ms / 1000));
const fmt = (n: number) => n.toFixed(1);

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type Row = { upMs: number[]; downMs: number[]; wallUp: number; wallDown: number; ok: number };

async function benchDiscord(): Promise<Row | string> {
  const webhooks = parseWebhookUrls(
    Array.from({ length: 50 }, (_, i) => process.env[`WEBHOOK_${i + 1}`]).filter(Boolean) as string[],
  );
  if (!webhooks.length) return "no WEBHOOK_* configured";
  const rl = new WebhookRateLimiter();
  const row: Row = { upMs: [], downMs: [], wallUp: 0, wallDown: 0, ok: 0 };
  const stored: Array<{ webhook: (typeof webhooks)[number]; messageId: string; hash: string }> = [];

  const wu = performance.now();
  for (let i = 0; i < N; i++) {
    const wh = webhooks[i % webhooks.length]!;
    const data = randomBytes(CHUNK);
    const hash = createHash("sha256").update(data).digest("hex");
    const up = await uploadChunk(wh, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), `bench-${i}.bin`, rl, {});
    row.upMs.push(up.elapsedMs);
    stored.push({ webhook: wh, messageId: up.messageId, hash });
  }
  row.wallUp = performance.now() - wu;

  const wd = performance.now();
  for (const s of stored) {
    const t = performance.now();
    const bytes = await streamBytes(await downloadChunk(s.webhook, s.messageId, rl));
    row.downMs.push(performance.now() - t);
    if (createHash("sha256").update(bytes).digest("hex") === s.hash) row.ok++;
  }
  row.wallDown = performance.now() - wd;

  for (const s of stored) await deleteChunk(s.webhook, s.messageId, rl).catch(() => {});
  return row;
}

async function benchTelegram(): Promise<Row | string> {
  const token = process.env.TG_BOT_1?.trim();
  const chatId = process.env.TG_BOT_1_CHAT?.trim();
  if (!token || !chatId) return "no TG_BOT_1 / TG_BOT_1_CHAT configured";
  const bot = { id: "TG_BOT_1", token, chatId };
  const rl = new TelegramRateLimiter();
  const row: Row = { upMs: [], downMs: [], wallUp: 0, wallDown: 0, ok: 0 };
  const stored: Array<{ messageId: string; fileId: string; hash: string }> = [];

  const wu = performance.now();
  for (let i = 0; i < N; i++) {
    const data = randomBytes(CHUNK);
    const hash = createHash("sha256").update(data).digest("hex");
    const up = await uploadDocument(bot, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), `bench-${i}.bin`, rl);
    row.upMs.push(up.elapsedMs);
    stored.push({ messageId: up.messageId, fileId: up.fileId, hash });
  }
  row.wallUp = performance.now() - wu;

  const wd = performance.now();
  for (const s of stored) {
    const t = performance.now();
    const bytes = await streamBytes(await downloadDocument(bot, s.fileId, rl));
    row.downMs.push(performance.now() - t);
    if (createHash("sha256").update(bytes).digest("hex") === s.hash) row.ok++;
  }
  row.wallDown = performance.now() - wd;

  for (const s of stored) await deleteMessage(bot, chatId, s.messageId, rl).catch(() => {});
  return row;
}

function report(name: string, r: Row | string) {
  console.log(`\n=== ${name} ===`);
  if (typeof r === "string") { console.log(`  skipped: ${r}`); return; }
  const upMed = median(r.upMs), downMed = median(r.downMs);
  console.log(`  integrity:        ${r.ok}/${N} chunks round-tripped, hash OK`);
  console.log(`  per-chunk upload: ${fmt(mbps(CHUNK, upMed))} MB/s  (median ${fmt(upMed)} ms/chunk)`);
  console.log(`  per-chunk down:   ${fmt(mbps(CHUNK, downMed))} MB/s  (median ${fmt(downMed)} ms/chunk)`);
  console.log(`  sustained upload: ${fmt(mbps(CHUNK * N, r.wallUp))} MB/s  (${N} chunks in ${fmt(r.wallUp)} ms, incl. rate-limit pacing)`);
  console.log(`  sustained down:   ${fmt(mbps(CHUNK * N, r.wallDown))} MB/s  (${N} chunks in ${fmt(r.wallDown)} ms)`);
}

async function main() {
  console.log(`Benchmark: ${N} × ${(CHUNK / 1024 / 1024).toFixed(2)} MiB chunks per provider`);
  report("Discord", await benchDiscord());
  report("Telegram", await benchTelegram());
}

main().catch((e) => { console.error(e); process.exit(1); });
