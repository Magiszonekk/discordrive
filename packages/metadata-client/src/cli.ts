#!/usr/bin/env -S npx tsx
// ddn: discordrive-next metadata-only CLI (stage 2, single device).
//
//   ddn [--state DIR] [--webhook-file F]... put <file> [name]
//   ddn [--state DIR] [--webhook-file F]... get <name|nodeId> <out>
//   ddn [--state DIR] ls
//
// State dir (default ~/.local/share/ddn, mode 0700): device.json, log.jsonl.
// Until op encryption and the server exist (PLAN-etap2 steps 3, 6), the
// arbiter runs in-process and the log is a local file. The log holds file keys
// (inside manifestRef), so it is written 0600 and must stay on this device.
// Webhook URLs come from files (default: $DDN_WEBHOOK_FILES, ':'-separated) and
// are never printed.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Sequencer, ROOT_ID, type LogEntry } from "@ddv4/sync-core";
import { LocalArbiter } from "./arbiter.js";
import { MetadataClient, newId, type ByteSink, type ByteSource } from "./client.js";
import { DiscordWebhookTransport, parseWebhookUrl, redactWebhookUrl } from "./discord-transport.js";
import type { WebhookRef, WebhookTransport } from "./types.js";

export interface CliEnv {
  stateDir: string;
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

export function loadWebhooks(files: string[]): WebhookRef[] {
  return files.map((f) => parseWebhookUrl(readFileSync(f, "utf8")));
}

/** Open the local state (creates it on first use) and a client on top of it. */
export async function openClient(env: CliEnv, needWebhooks = true): Promise<MetadataClient> {
  mkdirSync(env.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(env.stateDir, 0o700);
  const devFile = join(env.stateDir, "device.json");
  if (!existsSync(devFile)) writeFileSync(devFile, JSON.stringify({ id: `cli-${newId()}`, name: "cli" }) + "\n", { mode: 0o600 });
  const device = JSON.parse(readFileSync(devFile, "utf8")) as { id: string; name: string };
  const logFile = join(env.stateDir, "log.jsonl");
  const entries: LogEntry[] = existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogEntry)
    : [];
  const arbiter = new LocalArbiter(new Sequencer({ initialLog: entries }), (e) => {
    appendFileSync(logFile, JSON.stringify(e) + "\n", { mode: 0o600 });
  });
  const client = new MetadataClient({
    device,
    arbiter,
    transport: env.transport ?? new DiscordWebhookTransport(),
    // Listing works offline from the local index; only put/get need the vault.
    webhooks: needWebhooks ? loadWebhooks(env.webhookFiles) : [{ id: "0", url: "unset://" }],
  });
  await client.pull();
  return client;
}

function resolveNode(client: MetadataClient, ref: string): string {
  if (client.store.getNode(ref)) return ref;
  const hits = client.list(ROOT_ID).filter((x) => x.name === ref);
  if (hits.length !== 1) throw new Error(hits.length ? `ambiguous name: ${ref}` : `not found: ${ref}`);
  return hits[0]!.id;
}

export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  const out = env.out ?? ((l: string) => console.log(l));
  const [cmd, ...args] = argv;
  if (cmd === "put" || cmd === "get") {
    if (env.webhookFiles.length === 0) throw new Error("no webhook files (--webhook-file or DDN_WEBHOOK_FILES)");
  }
  const client = await openClient(env, cmd === "put" || cmd === "get");
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
      out("usage: ddn [--state DIR] [--webhook-file F]... put <file> [name] | get <name|id> <out> | ls");
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
