// CI helper: a fake Discord (no network) with N webhooks for an e2ee instance pool.
// Writes <dir>/fake.origin and <dir>/pool.txt, then runs until killed.
//   tsx apps/ddn-server/scripts/fake-discord.ts <dir> [webhooks=2]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeDiscord } from "@ddv4/metadata-client/node";

const dir = process.argv[2] ?? ".";
const n = Number(process.argv[3] ?? 2);
const f = new FakeDiscord();
const origin = await f.listen();
const urls = Array.from({ length: n }, (_, i) => f.addWebhook(String(1550000000000000900n + BigInt(i))).url);
writeFileSync(join(dir, "pool.txt"), urls.join("\n") + "\n", { mode: 0o600 });
writeFileSync(join(dir, "fake.origin"), origin);
console.log(`fake Discord at ${origin}, ${n} webhook(s)`);
setInterval(() => {}, 60_000);
