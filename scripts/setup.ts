// DiscorDrive v4 — interactive setup wizard (prototype)
//
// Builds a working .env by asking about mode, database, storage strategy and
// senders — validating webhooks/bot tokens live so misconfiguration is caught
// here, not at first upload. Re-runnable: an existing .env pre-fills answers
// and unmanaged keys are preserved.
//
//   npm run setup            # or: npx tsx scripts/setup.ts
//   npx tsx scripts/setup.ts --advanced   # also prompt tuning knobs
//
// Zero extra deps: uses node:readline/promises. Secrets are masked on input
// and never echoed back.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ENV_PATH = resolve(process.cwd(), ".env");
const ADVANCED = process.argv.includes("--advanced");

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

// Own line queue on top of readline. readline/promises' question() drops lines
// when a non-TTY pipe delivers all input in one chunk (events fire between
// awaits with no listener attached); buffering every 'line' fixes that and
// keeps interactive use identical.
let muted = false;
const rl = createInterface({ input: stdin, output: stdout }) as ReturnType<typeof createInterface> & {
  _writeToOutput?: (s: string) => void;
};
const originalWrite = rl._writeToOutput?.bind(rl);
if (originalWrite) {
  rl._writeToOutput = (str: string) => {
    if (muted && str !== "\r\n" && str !== "\n") return; // swallow secret keystrokes
    originalWrite(str);
  };
}

const lineBuffer: string[] = [];
const lineWaiters: Array<(line: string | null) => void> = [];
let inputClosed = false;
rl.on("line", (line) => {
  const waiter = lineWaiters.shift();
  if (waiter) waiter(line);
  else lineBuffer.push(line);
});
rl.on("close", () => {
  inputClosed = true;
  while (lineWaiters.length) lineWaiters.shift()!(null);
});

// EOF (Ctrl-D or exhausted piped input) aborts the wizard cleanly instead of
// letting default-valued prompts spin forever. Pressing Enter sends "" (a
// line), not EOF, so defaults still work interactively.
class AbortInput extends Error {}

function readLine(): Promise<string | null> {
  if (lineBuffer.length) return Promise.resolve(lineBuffer.shift()!);
  if (inputClosed) return Promise.resolve(null);
  return new Promise((res) => lineWaiters.push(res));
}

async function readLineOrAbort(): Promise<string> {
  const line = await readLine();
  if (line === null) throw new AbortInput("no more input");
  return line;
}

async function ask(question: string, def?: string): Promise<string> {
  const suffix = def ? c.dim(` (${def})`) : "";
  stdout.write(`${question}${suffix}: `);
  const answer = (await readLineOrAbort()).trim();
  return answer || def || "";
}

async function askSecret(question: string): Promise<string> {
  stdout.write(`${question}: `);
  muted = true;
  try {
    const answer = (await readLineOrAbort()).trim();
    return answer;
  } finally {
    muted = false;
    stdout.write("\n");
  }
}

async function confirm(question: string, def = true): Promise<boolean> {
  const hint = def ? "Y/n" : "y/N";
  const a = (await ask(`${question} ${c.dim(`[${hint}]`)}`)).toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}

async function choose(question: string, options: Array<{ value: string; label: string }>): Promise<string> {
  console.log(`\n${c.bold(question)}`);
  options.forEach((o, i) => console.log(`  ${c.cyan(String(i + 1))}. ${o.label}`));
  while (true) {
    const raw = await ask("Choose", "1");
    const idx = Number(raw) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) return options[idx]!.value;
    console.log(c.red("  Pick a number from the list."));
  }
}

// ---------------------------------------------------------------------------
// .env read / merge / write
// ---------------------------------------------------------------------------

type EnvMap = Map<string, string>;

function parseEnv(text: string): EnvMap {
  const map: EnvMap = new Map();
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) map.set(m[1]!, m[2]!);
  }
  return map;
}

const existing: EnvMap = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, "utf8")) : new Map();

// Keys this wizard manages; everything else in an existing .env is preserved.
const MANAGED = new Set<string>();
const result: EnvMap = new Map();
function set(key: string, value: string) {
  MANAGED.add(key);
  result.set(key, value);
}

// ---------------------------------------------------------------------------
// Live validation
// ---------------------------------------------------------------------------

async function validateDiscordWebhook(url: string): Promise<{ ok: boolean; id?: string; channelId?: string; detail: string }> {
  const m = /discord(?:app)?\.com\/api\/webhooks\/(\d+)\/([\w-]+)/.exec(url);
  if (!m) return { ok: false, detail: "not a Discord webhook URL" };
  try {
    const res = await fetch(`https://discord.com/api/webhooks/${m[1]}/${m[2]}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, id: m[1], detail: `Discord returned ${res.status}` };
    const json = (await res.json()) as { channel_id?: string; name?: string };
    return { ok: true, id: m[1], channelId: json.channel_id, detail: `channel ${json.channel_id}` };
  } catch (e) {
    return { ok: false, id: m[1], detail: `unreachable (${(e as Error).message})` };
  }
}

async function validateDiscordBot(token: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, detail: `token rejected (${res.status})` };
    const json = (await res.json()) as { username?: string };
    return { ok: true, detail: `bot @${json.username}` };
  } catch (e) {
    return { ok: false, detail: `unreachable (${(e as Error).message})` };
  }
}

async function validateTelegramBot(token: string, chatId: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const me = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const meJson = (await me.json()) as { ok: boolean; result?: { username?: string } };
    if (!meJson.ok) return { ok: false, detail: "token rejected" };
    const chat = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const chatJson = (await chat.json()) as { ok: boolean; description?: string };
    if (!chatJson.ok) return { ok: false, detail: `bot @${meJson.result?.username} can't see chat ${chatId} (add it as admin?)` };
    return { ok: true, detail: `bot @${meJson.result?.username} → chat OK` };
  } catch (e) {
    return { ok: false, detail: `unreachable (${(e as Error).message})` };
  }
}

/** Prompt-validate-retry wrapper. Returns null if the user skips. */
async function withValidation<T>(
  gather: () => Promise<T>,
  validate: (v: T) => Promise<{ ok: boolean; detail: string }>,
): Promise<T | null> {
  while (true) {
    const value = await gather();
    process.stdout.write(c.dim("  checking… "));
    const { ok, detail } = await validate(value);
    if (ok) {
      console.log(c.green(`ok — ${detail}`));
      return value;
    }
    console.log(c.red(`failed — ${detail}`));
    const next = await choose("What now?", [
      { value: "retry", label: "Re-enter" },
      { value: "keep", label: "Keep anyway (I'll fix it later)" },
      { value: "skip", label: "Skip this sender" },
    ]);
    if (next === "keep") return value;
    if (next === "skip") return null;
  }
}

// ---------------------------------------------------------------------------
// Sender collection
// ---------------------------------------------------------------------------

// Identity keys already used by PRIMARY senders — REPLICA must not reuse them.
const usedSenderIdentities = new Set<string>();

async function collectDiscordSenders(prefix: "" | "REPLICA_", role: "primary" | "replica") {
  let webhookN = 0;
  let botN = 0;
  console.log(c.bold(`\nDiscord ${role} senders`));
  console.log(c.dim("  Each webhook should live on its own channel (rate limits are per-channel)."));

  while (await confirm(`Add a Discord ${role} webhook?`, webhookN === 0)) {
    const gathered = await withValidation(
      () => ask("  Webhook URL"),
      async (url) => {
        const v = await validateDiscordWebhook(url);
        if (v.ok && role === "replica" && v.id && usedSenderIdentities.has(`wh:${v.id}`)) {
          return { ok: false, detail: "this webhook is already a PRIMARY sender — replicas must be physically separate" };
        }
        return v;
      },
    );
    if (gathered) {
      const info = await validateDiscordWebhook(gathered);
      if (role === "primary" && info.id) usedSenderIdentities.add(`wh:${info.id}`);
      set(`${prefix}WEBHOOK_${++webhookN}`, gathered);
    }
  }

  while (await confirm(`Add a Discord ${role} bot sender?`, false)) {
    const token = await withValidation(() => askSecret("  Bot token"), (t) => {
      if (role === "replica" && usedSenderIdentities.has(`bot:${t}`)) {
        return Promise.resolve({ ok: false, detail: "this bot is already a PRIMARY sender — replicas must be separate" });
      }
      return validateDiscordBot(t);
    });
    if (!token) continue;
    const channel = await ask("  Channel ID the bot posts to");
    botN++;
    if (role === "primary") usedSenderIdentities.add(`bot:${token}`);
    set(`${prefix}BOT_${botN}`, token);
    set(`${prefix}BOT_${botN}_CHANNEL`, channel);
    if (role === "primary") set("BOT_UPLOADS_ENABLED", "1");
  }
  return webhookN + botN;
}

async function collectTelegramSenders(prefix: "" | "REPLICA_", role: "primary" | "replica") {
  let n = 0;
  console.log(c.bold(`\nTelegram ${role} senders`));
  console.log(c.dim("  One bot = one private channel/group. The bot must be an admin of the chat."));
  const tokenKey = prefix === "REPLICA_" ? "REPLICA_TG_BOT" : "TG_BOT";

  while (await confirm(`Add a Telegram ${role} bot?`, n === 0)) {
    let token = "";
    const validated = await withValidation(
      async () => {
        token = await askSecret("  Bot token");
        const chatId = await ask("  Chat ID (e.g. -1001234567890)");
        return { token, chatId };
      },
      async ({ token: t, chatId }) => {
        if (role === "replica" && usedSenderIdentities.has(`tg:${t}:${chatId}`)) {
          return { ok: false, detail: "this bot+chat is already a PRIMARY sender — replicas must be separate" };
        }
        return validateTelegramBot(t, chatId);
      },
    );
    if (!validated) continue;
    n++;
    if (role === "primary") usedSenderIdentities.add(`tg:${validated.token}:${validated.chatId}`);
    set(`${tokenKey}_${n}`, validated.token);
    set(`${tokenKey}_${n}_CHAT`, validated.chatId);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main() {
  console.log(c.bold("\n🗄️  DiscorDrive setup wizard\n"));
  if (existing.size > 0) {
    console.log(c.yellow(`Found an existing .env — its values pre-fill the prompts, unmanaged keys are kept.\n`));
  }

  // 1. Mode
  const mode = await choose("App mode", [
    { value: "full", label: "full — users, auth, frontend, folders (self-hosted app)" },
    { value: "backend-only", label: "backend-only — API only, single API_KEY, no users/frontend" },
  ]);
  set("APP_MODE", mode);
  if (mode === "backend-only") {
    const key = existing.get("API_KEY") || randomBytes(24).toString("hex");
    set("API_KEY", key);
    console.log(c.dim(`  Generated API_KEY (kept in .env).`));
  }

  // 2. Database
  const dbChoice = await choose("Database", [
    { value: "docker", label: "Spin up the bundled Postgres (infra/docker-compose.yml)" },
    { value: "existing", label: "Use an existing PostgreSQL I already have" },
  ]);
  if (dbChoice === "docker") {
    const port = await ask("Postgres port", existing.get("POSTGRES_PORT") || "5432");
    const pass = existing.get("POSTGRES_PASSWORD") || randomBytes(9).toString("base64url");
    set("POSTGRES_PORT", port);
    set("POSTGRES_USER", "ddv4");
    set("POSTGRES_PASSWORD", pass);
    set("POSTGRES_DB", "ddv4");
    set("DATABASE_URL", `postgresql://ddv4:${pass}@localhost:${port}/ddv4`);
    set("REDIS_PORT", existing.get("REDIS_PORT") || "6379");
    console.log(c.dim(`  DATABASE_URL generated; start it later with: npm run infra:up`));
  } else {
    const url = await ask("DATABASE_URL", existing.get("DATABASE_URL"));
    set("DATABASE_URL", url);
  }

  // 3. Ports & URLs (full mode)
  if (mode === "full") {
    set("API_PORT", await ask("API port", existing.get("API_PORT") || "3000"));
    set("FRONTEND_PORT", await ask("Frontend port", existing.get("FRONTEND_PORT") || "5173"));
  } else {
    set("API_PORT", await ask("API port", existing.get("API_PORT") || "3000"));
  }

  // 4. Storage strategy
  console.log(c.bold("\n📦 Storage strategy"));
  const providerPick = await choose("Which providers store your files?", [
    { value: "DISCORD", label: "Discord only" },
    { value: "TELEGRAM", label: "Telegram only" },
    { value: "DISCORD,TELEGRAM", label: "Both — stripe chunks across them for throughput" },
    { value: "LOCAL", label: "Local disk only (testing/dev)" },
  ]);
  set("STORAGE_PRIMARY_PROVIDERS", providerPick);
  set("BLOB_STORAGE_KIND", providerPick.split(",")[0]!); // fallback stays consistent

  const primaryProviders = providerPick.split(",");
  if (primaryProviders.includes("DISCORD")) await collectDiscordSenders("", "primary");
  if (primaryProviders.includes("TELEGRAM")) await collectTelegramSenders("", "primary");

  // 5. Replication
  console.log(c.bold("\n🔁 Replication (keep a second copy in case a provider account is lost)"));
  const wantReplica = await confirm("Enable replication onto a separate backup provider?", false);
  if (wantReplica) {
    console.log(c.yellow("  Replica senders must be PHYSICALLY SEPARATE (different server/account/bot)\n  than your primary senders — otherwise losing one account loses both copies."));
    const replicaPick = await choose("Replica provider", [
      { value: "DISCORD", label: "Discord (a different server/account)" },
      { value: "TELEGRAM", label: "Telegram (a different bot)" },
      { value: "LOCAL", label: "Local disk (weak — same machine)" },
    ]);
    set("STORAGE_REPLICA_PROVIDERS", replicaPick);
    if (replicaPick === "DISCORD") await collectDiscordSenders("REPLICA_", "replica");
    if (replicaPick === "TELEGRAM") await collectTelegramSenders("REPLICA_", "replica");
    if (ADVANCED) set("REPLICATION_CONCURRENCY", await ask("Replication worker concurrency", "2"));
  } else {
    set("STORAGE_REPLICA_PROVIDERS", "");
  }

  // 6. Plugins (full mode only)
  if (mode === "full" && (await confirm("Enable the mobile gallery plugin?", (existing.get("DDV_PLUGINS") ?? "").includes("gallery")))) {
    set("DDV_PLUGINS", "@ddv4/plugin-gallery");
  }

  // 7. Secrets
  set("JWT_SECRET", existing.get("JWT_SECRET") && existing.get("JWT_SECRET") !== "change-me-to-random-string"
    ? existing.get("JWT_SECRET")!
    : randomBytes(32).toString("hex"));
  set("JWT_EXPIRES_IN", existing.get("JWT_EXPIRES_IN") || "7d");
  console.log(c.dim("\n  JWT_SECRET generated (or kept if you already had a real one)."));

  // 8. Write
  writeEnv();

  console.log(c.green(`\n✓ Wrote ${ENV_PATH} (chmod 600)`));
  const senderCount = usedSenderIdentities.size;
  console.log(`  ${c.bold(String(senderCount))} primary sender(s) configured, replication ${wantReplica ? c.green("ON") : c.dim("off")}.`);

  if (await confirm("\nApply the database schema now (prisma db push)?", false)) {
    const { spawnSync } = await import("node:child_process");
    console.log(c.dim("  running prisma db push…"));
    const r = spawnSync("npm", ["run", "db:push"], { stdio: "inherit", env: { ...process.env, ...Object.fromEntries(result) } });
    if (r.status !== 0) console.log(c.red("  db push failed — check DATABASE_URL and that Postgres is running."));
  }

  console.log(c.bold("\nNext:"));
  if (result.get("DATABASE_URL")?.includes("localhost") && existing.get("POSTGRES_PASSWORD") === undefined) {
    console.log("  • npm run infra:up      " + c.dim("# start bundled Postgres/Redis"));
  }
  console.log("  • npm run dev           " + c.dim("# start API + frontend"));
  console.log("");
}

function writeEnv() {
  const lines: string[] = ["# Generated by scripts/setup.ts — safe to edit by hand.", ""];
  for (const [k, v] of result) lines.push(`${k}=${v}`);

  // Preserve any pre-existing keys the wizard doesn't manage
  const preserved = [...existing.entries()].filter(([k]) => !MANAGED.has(k));
  if (preserved.length > 0) {
    lines.push("", "# === Preserved from your previous .env ===");
    for (const [k, v] of preserved) lines.push(`${k}=${v}`);
  }

  writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
}

main()
  .catch((e) => {
    if (e instanceof AbortInput) {
      console.error(c.yellow("\nSetup cancelled (input ended) — nothing was written."));
    } else {
      console.error(c.red(`\nSetup aborted: ${e instanceof Error ? e.message : String(e)}`));
    }
    process.exitCode = 1;
  })
  .finally(() => rl.close());
