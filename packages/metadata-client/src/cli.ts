#!/usr/bin/env -S npx tsx
// ddn: discordrive-next metadata-only CLI (stage 2, single device).
//
//   ddn [--state DIR] init
//   ddn [--state DIR] webhook add <url-file>     # URL read from a file, never printed
//   ddn [--state DIR] webhook ls
//   ddn [--state DIR] webhook rm <webhook-id>
//   ddn [--state DIR] put <file> [name]
//   ddn [--state DIR] get <name|nodeId> <out>
//   ddn [--state DIR] ls
//
// State dir (default ~/.local/share/ddn, 0700; files 0600):
//   account.json  account ID + account key (the secret; becomes the rescue kit, §3.5)
//   device.json   this device
//   server/       what the SERVER would hold: log.jsonl (encrypted ops, koncept
//                 §3.3) and vault.json (encrypted webhook vault, §3.2). Until the
//                 HTTP server exists (plan step 6) the server runs in-process.
//   seen.json     highest vault revision seen (rollback guard)
//   index.db      the device's own copy of the tree (SQLite, koncept §4.1); only
//                 the log tail after its headSeq is fetched on start
// --webhook-file / DDN_WEBHOOK_FILES (':'-separated URL files) are added to the
// vault on start (convenience for scripts and tests).

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fromBase64, toBase64 } from "@ddv4/processing";
import { ROOT_ID } from "@ddv4/sync-core";
import { accountKeyFromB64, newAccountKey, type AccountKey } from "./account-key.js";
import { MetadataClient, newId, type ByteSink, type ByteSource } from "./client.js";
import { DiscordWebhookTransport, redactWebhookUrl } from "./discord-transport.js";
import { EncryptedArbiter, InProcessLogServer, OpCodec, type EncryptedEntry } from "./op-crypto.js";
import { SqliteIndexStore } from "./node/sqlite-store.js";
import type { WebhookTransport } from "./types.js";
import {
  WebhookVault,
  inspectForVault,
  toWebhookRefs,
  vaultAdvice,
  type SealedVault,
  type VaultPutResult,
  type VaultStore,
} from "./vault.js";

export interface CliEnv {
  stateDir: string;
  /** URL files to make sure are in the vault. */
  webhookFiles: string[];
  transport?: WebhookTransport;
  out?: (line: string) => void;
}

export async function fileSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const fh = await open(path, "r");
  const { size } = await fh.stat();
  return {
    size,
    async read(offset, length) {
      const buf = new Uint8Array(Math.min(length, Math.max(0, size - offset)));
      let got = 0;
      while (got < buf.byteLength) {
        const { bytesRead } = await fh.read(buf, got, buf.byteLength - got, offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    },
    close: () => fh.close(),
  };
}

export async function fileSink(path: string): Promise<ByteSink & { close(): Promise<void> }> {
  const fh = await open(path, "w");
  return { write: async (d) => void (await fh.write(d)), close: () => fh.close() };
}

function writeJson(path: string, v: unknown): void {
  writeFileSync(path, JSON.stringify(v) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
}

/** Vault blob kept in a file (the server's copy, in-process for now). */
class FileVaultStore implements VaultStore {
  constructor(private readonly path: string) {}
  async get(): Promise<SealedVault | null> {
    if (!existsSync(this.path)) return null;
    const j = readJson<{ revision: number; blob: string }>(this.path);
    return { revision: j.revision, blob: fromBase64(j.blob) };
  }
  async put(_acct: string, expected: number, next: SealedVault): Promise<VaultPutResult> {
    const cur = await this.get();
    if ((cur?.revision ?? 0) !== expected || next.revision !== expected + 1) return { status: "conflict", current: cur };
    writeJson(this.path, { revision: next.revision, blob: toBase64(next.blob) });
    return { status: "ok" };
  }
}

export interface CliState {
  accountId: string;
  key: AccountKey;
  device: { id: string; name: string };
  server: InProcessLogServer;
  vault: WebhookVault;
  saveSeen(): void;
  stateDir: string;
}

export function initState(stateDir: string): boolean {
  ensureDir(stateDir);
  const accFile = join(stateDir, "account.json");
  if (existsSync(accFile)) return false;
  writeJson(accFile, { accountId: `acct-${newId()}`, key: newAccountKey().rawB64 });
  return true;
}

export function openState(stateDir: string): CliState {
  ensureDir(stateDir);
  const accFile = join(stateDir, "account.json");
  if (!existsSync(accFile)) throw new Error("no account here: run `ddn init` first");
  const acc = readJson<{ accountId: string; key: string }>(accFile);
  const key = accountKeyFromB64(acc.key);
  const devFile = join(stateDir, "device.json");
  if (!existsSync(devFile)) writeJson(devFile, { id: `cli-${newId()}`, name: "cli" });
  const device = readJson<{ id: string; name: string }>(devFile);
  const serverDir = join(stateDir, "server");
  ensureDir(serverDir);
  const logFile = join(serverDir, "log.jsonl");
  const initialLog: EncryptedEntry[] = existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as EncryptedEntry)
    : [];
  const server = new InProcessLogServer({
    initialLog,
    onAppend: (e) => appendFileSync(logFile, JSON.stringify(e) + "\n", { mode: 0o600 }),
  });
  const seenFile = join(stateDir, "seen.json");
  const seen = existsSync(seenFile) ? readJson<{ vaultRevision: number }>(seenFile).vaultRevision : 0;
  const vault = new WebhookVault(new FileVaultStore(join(serverDir, "vault.json")), key, acc.accountId, seen);
  return { accountId: acc.accountId, key, device, server, vault, stateDir, saveSeen: () => writeJson(seenFile, { vaultRevision: vault.revision }) };
}

export async function openClient(st: CliState, transport: WebhookTransport): Promise<MetadataClient> {
  const v = await st.vault.load();
  st.saveSeen();
  const hooks = toWebhookRefs(v);
  const client = new MetadataClient({
    device: st.device,
    arbiter: new EncryptedArbiter(new OpCodec(st.key, st.accountId), st.server.session(st.device.id)),
    transport,
    // Listing works without webhooks; put/get check in runCli.
    webhooks: hooks.length ? hooks : [{ id: "0", url: "unset://" }],
    store: openIndex(st.stateDir),
  });
  await client.pull();
  return client;
}

function openIndex(stateDir: string): SqliteIndexStore {
  const path = join(stateDir, "index.db");
  const s = new SqliteIndexStore(path);
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  return s;
}

function resolveNode(client: MetadataClient, ref: string): string {
  if (client.store.getNode(ref)) return ref;
  const hits = client.list(ROOT_ID).filter((x) => x.name === ref);
  if (hits.length !== 1) throw new Error(hits.length ? `ambiguous name: ${ref}` : `not found: ${ref}`);
  return hits[0]!.id;
}

async function addWebhookFile(st: CliState, transport: WebhookTransport, file: string): Promise<string> {
  const w = await inspectForVault(transport, readFileSync(file, "utf8"));
  const v = await st.vault.load();
  if (!v.webhooks.some((x) => x.id === w.id)) await st.vault.addWebhook(w);
  st.saveSeen();
  return w.id;
}

export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  const out = env.out ?? ((l: string) => console.log(l));
  const transport = env.transport ?? new DiscordWebhookTransport();
  const [cmd, ...args] = argv;
  if (cmd === "init") {
    out(initState(env.stateDir) ? "account created (keep account.json safe: it holds the account key)" : "account already exists");
    return 0;
  }
  const st = openState(env.stateDir);
  for (const f of env.webhookFiles) await addWebhookFile(st, transport, f);

  if (cmd === "webhook") {
    const [sub, arg] = args;
    if (sub === "add" && arg) {
      out(`added webhook ${await addWebhookFile(st, transport, arg)}`);
      out(vaultAdvice(await st.vault.load()).message);
      return 0;
    }
    if (sub === "rm" && arg) {
      await st.vault.removeWebhook(arg);
      st.saveSeen();
      out(`removed webhook ${arg}`);
      return 0;
    }
    if (sub === "ls") {
      const v = await st.vault.load();
      for (const w of v.webhooks) out(`${w.id} channel ${w.channelId} ${w.label}`);
      out(vaultAdvice(v).message);
      return 0;
    }
    out("usage: webhook add <url-file> | ls | rm <id>");
    return 2;
  }

  if ((cmd === "put" || cmd === "get") && (await st.vault.load()).webhooks.length === 0) {
    throw new Error("vault has no webhooks: `ddn webhook add <url-file>`");
  }
  const client = await openClient(st, transport);
  switch (cmd) {
    case "put": {
      const [path, name] = args;
      if (!path) throw new Error("usage: put <file> [name]");
      const src = await fileSource(path);
      try {
        const t0 = Date.now();
        const r = await client.upload(src, name ?? basename(path));
        const s = (Date.now() - t0) / 1000;
        out(`put ${r.nodeId} ${src.size} B in ${r.chunks} fragment(s), ${r.posts} post(s), ${s.toFixed(1)} s, sha256 ${r.version.plaintextSha256}`);
      } finally {
        await src.close();
      }
      return 0;
    }
    case "get": {
      const [ref, dest] = args;
      if (!ref || !dest) throw new Error("usage: get <name|nodeId> <out>");
      const id = resolveNode(client, ref);
      const sink = await fileSink(dest);
      try {
        const v = await client.download(id, sink);
        out(`get ${id} ${v.sizeBytes} B sha256 ${v.plaintextSha256} OK`);
      } finally {
        await sink.close();
      }
      return 0;
    }
    case "ls": {
      for (const x of client.list(ROOT_ID)) out(`${x.kind === "folder" ? "d" : "-"} ${String(x.size ?? "").padStart(12)} ${x.id} ${x.name}`);
      return 0;
    }
    default:
      out("usage: ddn [--state DIR] init | webhook add <url-file>|ls|rm <id> | put <file> [name] | get <name|id> <out> | ls");
      return 2;
  }
}

function parseArgs(argv: string[]): { env: CliEnv; rest: string[] } {
  const env: CliEnv = {
    stateDir: process.env.DDN_STATE ?? join(homedir(), ".local/share/ddn"),
    webhookFiles: (process.env.DDN_WEBHOOK_FILES ?? "").split(":").filter(Boolean),
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--state") env.stateDir = argv[++i]!;
    else if (a === "--webhook-file") env.webhookFiles.push(argv[++i]!);
    else rest.push(a);
  }
  return { env, rest };
}

const isMain = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const { env, rest } = parseArgs(process.argv.slice(2));
  runCli(rest, env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`ddn: ${redactWebhookUrl(String((e as Error)?.message ?? e))}`);
      process.exit(1);
    },
  );
}
