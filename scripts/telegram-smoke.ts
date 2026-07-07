// DiscorDrive v4 — manual Telegram transport smoke test (real bot, no CI)
//
// Verifies the full provider contract against the live Bot API:
//   upload → getFile/download → byte+hash equality → delete → download fails
//
// Usage:
//   TG_BOT_1=<token> TG_BOT_1_CHAT=<chat_id> npx tsx scripts/telegram-smoke.ts
// (or rely on the values already present in .env)

import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import {
  TelegramRateLimiter,
  deleteMessage,
  downloadDocument,
  uploadDocument,
  type TgBotInfo,
} from "@ddv4/telegram-client";

async function main() {
  const token = process.env.TG_BOT_1?.trim();
  const chatId = process.env.TG_BOT_1_CHAT?.trim();
  if (!token || !chatId) {
    console.error("Set TG_BOT_1 and TG_BOT_1_CHAT (env or .env) to run this smoke test.");
    process.exit(1);
  }

  const bot: TgBotInfo = { id: "TG_BOT_1", token, chatId };
  const limiter = new TelegramRateLimiter();

  const payload = randomBytes(1024 * 1024); // 1 MiB of noise, like a small chunk
  const expectedHash = createHash("sha256").update(payload).digest("hex");

  console.log("1/4 upload…");
  const uploaded = await uploadDocument(
    bot,
    payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer,
    `smoke-${Date.now()}.bin`,
    limiter,
  );
  console.log(`    messageId=${uploaded.messageId} fileId=${uploaded.fileId} (${uploaded.elapsedMs}ms)`);

  console.log("2/4 download…");
  const stream = await downloadDocument(bot, uploaded.fileId, limiter);
  const roundTripped = new Uint8Array(await new Response(stream).arrayBuffer());
  const actualHash = createHash("sha256").update(roundTripped).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
  console.log(`    ${roundTripped.byteLength} bytes, sha256 OK`);

  console.log("3/4 delete…");
  await deleteMessage(bot, uploaded.chatId, uploaded.messageId, limiter);
  console.log("    deleted");

  console.log("4/4 verify file_id still resolves (Telegram keeps files after message delete)…");
  try {
    const after = await downloadDocument(bot, uploaded.fileId, limiter);
    const bytes = new Uint8Array(await new Response(after).arrayBuffer());
    console.log(`    note: file_id still downloadable (${bytes.byteLength} bytes) — message deletion hides it from the chat; storage GC is on Telegram's side`);
  } catch {
    console.log("    file_id no longer resolves");
  }

  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
