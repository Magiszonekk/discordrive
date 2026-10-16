#!/usr/bin/env -S npx tsx
// ddn: discordrive-next metadata-only CLI (stage 2, single device).
//
//   ddn [--state DIR] init [--server URL]          # new account (local or on a server)
//   ddn [--state DIR] rescue --server URL <kit-file>  # new device from the rescue kit
//   ddn [--state DIR] pair-offer --server URL        # new device: print code, wait for it
//   ddn [--state DIR] pair-accept <code>             # signed-in device: pair the new one
//   ddn [--state DIR] kit                            # print the rescue kit text (secret)
//   ddn [--state DIR] devices [revoke <id>]
//   ddn [--state DIR] webhook add <url-file>     # URL read from a file, never printed
//   ddn [--state DIR] webhook ls
//   ddn [--state DIR] webhook rm <webhook-id>
//   ddn [--state DIR] put <file> [name]
//   ddn [--state DIR] get <name|nodeId> <out>
//   ddn [--state DIR] ls
//   --transfer-log <file>   append transfer logs (JSON Lines, docs/transfer-log.md) of put/get;
//                           --transfer-log-names: with file names (off by default)
//
// State dir (default ~/.local/share/ddn, 0700; files 0600):
//   account.json  account ID + account key (the secret; the rescue kit),
//                 server URL + instance (server mode)
//   device.json   this device: ID + Ed25519 key (PKCS#8; decision #13)
//   server/       local mode only: what a server would hold (encrypted log,
//                 encrypted vault), served in-process. Server mode keeps nothing here.
//   seen.json     highest vault revision seen (rollback guard)
//   index.db      the device's own copy of the tree (SQLite); only
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
import { EncryptedArbiter, InProcessLogServer, OpCodec, type EncryptedEntry, type EncryptedLogApi } from "./op-crypto.js";
import { HttpApi, HttpPairingMailbox, createAccountHttp, rescueRegisterDevice } from "./http-api.js";
import { exportDeviceKey, generateDeviceKey, importDeviceKey, type DeviceKey } from "./device-key.js";
import { acceptPairing, startPairing } from "./pairing.js";
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
  /** Append transfer logs (JSON Lines) of put/get to this file. */
  transferLog?: string;
  transferLogNames?: boolean;
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
  /** Encrypted log API: in-process (local mode) or HTTP (server mode). */
  log: EncryptedLogApi;
  /** Server mode only. */
  http: HttpApi | null;
  /** Local mode only. */
  server: InProcessLogServer | null;
  vault: WebhookVault;
  saveSeen(): void;
  stateDir: string;
}

interface AccountFile {
  accountId: string;
  key: string;
  server?: { url: string; instanceId: string };
}
interface DeviceFile {
  id: string;
  name: string;
  pkcs8?: string;
  publicKey?: string;
}

function assertLocalUrl(url: string): string {
  // Stage 2: no public domain. The CLI refuses anything but loopback unless explicitly allowed.
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && process.env.DDN_ALLOW_REMOTE !== "1") {
    throw new Error("server must be on 127.0.0.1 in stage 2 (set DDN_ALLOW_REMOTE=1 to override)");
  }
  return u.origin;
}

async function newDeviceFile(stateDir: string, id: string, k: DeviceKey & { privateKey: CryptoKey }, name = "cli"): Promise<void> {
  const ex = await exportDeviceKey(k);
  writeJson(join(stateDir, "device.json"), { id, name, pkcs8: ex.pkcs8, publicKey: ex.publicKey } satisfies DeviceFile);
}

/** New account. Local mode (no server): IDs made here. Server mode: registered on the server (decision #13). */
export async function initState(stateDir: string, serverUrl?: string): Promise<boolean> {
  ensureDir(stateDir);
  const accFile = join(stateDir, "account.json");
  if (existsSync(accFile)) return false;
  const key = newAccountKey();
  const dk = await generateDeviceKey(true);
  if (!serverUrl) {
    await newDeviceFile(stateDir, `cli-${newId()}`, dk);
    writeJson(accFile, { accountId: `acct-${newId()}`, key: key.rawB64 } satisfies AccountFile);
    return true;
  }
  const url = assertLocalUrl(serverUrl);
  const r = await createAccountHttp(url, dk, key);
  await newDeviceFile(stateDir, r.deviceId, dk);
  writeJson(accFile, { accountId: r.accountId, key: key.rawB64, server: { url, instanceId: r.instanceId } } satisfies AccountFile);
  return true;
}

export async function openState(stateDir: string): Promise<CliState> {
  ensureDir(stateDir);
  const accFile = join(stateDir, "account.json");
  if (!existsSync(accFile)) throw new Error("no account here: run `ddn init` first");
  const acc = readJson<AccountFile>(accFile);
  const key = accountKeyFromB64(acc.key);
  const devFile = join(stateDir, "device.json");
  if (!existsSync(devFile)) writeJson(devFile, { id: `cli-${newId()}`, name: "cli" });
  const dev = readJson<DeviceFile>(devFile);
  const device = { id: dev.id, name: dev.name };
  const seenFile = join(stateDir, "seen.json");
  const seen = existsSync(seenFile) ? readJson<{ vaultRevision: number }>(seenFile).vaultRevision : 0;
  if (acc.server) {
    if (!dev.pkcs8 || !dev.publicKey) throw new Error("device.json has no signing key");
    const http = new HttpApi({ baseUrl: acc.server.url, accountId: acc.accountId, deviceId: dev.id, key: await importDeviceKey({ pkcs8: dev.pkcs8, publicKey: dev.publicKey }), instanceId: acc.server.instanceId });
    const vault = new WebhookVault(http, key, acc.accountId, seen);
    return { accountId: acc.accountId, key, device, log: http, http, server: null, vault, stateDir, saveSeen: () => writeJson(seenFile, { vaultRevision: vault.revision }) };
  }
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
  const vault = new WebhookVault(new FileVaultStore(join(serverDir, "vault.json")), key, acc.accountId, seen);
  return {
    accountId: acc.accountId,
    key,
    device,
    log: server.session(device.id),
    http: null,
    server,
    vault,
    stateDir,
    saveSeen: () => writeJson(seenFile, { vaultRevision: vault.revision }),
  };
}

export async function openClient(st: CliState, transport: WebhookTransport): Promise<MetadataClient> {
  const v = await st.vault.load();
  st.saveSeen();
  const hooks = toWebhookRefs(v);
  const client = new MetadataClient({
    device: st.device,
    arbiter: new EncryptedArbiter(new OpCodec(st.key, st.accountId), st.log),
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
  const [cmd, ...rawArgs] = argv;
  const flag = (name: string): string | undefined => {
    const i = rawArgs.indexOf(name);
    if (i < 0) return undefined;
    const v = rawArgs[i + 1];
    rawArgs.splice(i, 2);
    return v;
  };
  const serverUrl = flag("--server");
  const args = rawArgs;
  if (cmd === "init") {
    out((await initState(env.stateDir, serverUrl)) ? "account created (keep account.json safe: it holds the account key)" : "account already exists");
    return 0;
  }
  if (cmd === "rescue") {
    // Rescue kit file: "ddn-kit3:..." or the older "ddn-kit1:..." (snapshots.openRescueKit). Registers THIS device with the rescue key.
    const [kitFile] = args;
    if (!serverUrl || !kitFile) throw new Error("usage: rescue --server URL <kit-file>");
    if (existsSync(join(env.stateDir, "account.json"))) throw new Error("state dir already has an account");
    const { openRescueKit } = await import("./snapshots.js");
    const kit = openRescueKit(readFileSync(kitFile, "utf8"));
    const url = assertLocalUrl(serverUrl);
    ensureDir(env.stateDir);
    const key = accountKeyFromB64(kit.key);
    const dk = await generateDeviceKey(true);
    const { deviceId } = await rescueRegisterDevice(url, key, kit.accountId, dk);
    const { getChallenge } = await import("./http-api.js");
    const instanceId = (await getChallenge(url)).instanceId;
    await newDeviceFile(env.stateDir, deviceId, dk);
    writeJson(join(env.stateDir, "account.json"), { accountId: kit.accountId, key: kit.key, server: { url, instanceId } } satisfies AccountFile);
    out(`device ${deviceId} registered with the rescue key`);
    return 0;
  }
  if (cmd === "pair-offer") {
    if (!serverUrl) throw new Error("usage: pair-offer --server URL");
    if (existsSync(join(env.stateDir, "account.json"))) throw new Error("state dir already has an account");
    const url = assertLocalUrl(serverUrl);
    ensureDir(env.stateDir);
    const dk = await generateDeviceKey(true);
    const pending = await startPairing(dk.publicKey);
    out(`pairing code: ${pending.offer}`);
    const deadline = Date.now() + Number(process.env.DDN_PAIR_WAIT_MS ?? 10 * 60_000);
    const mb = new HttpPairingMailbox(url, null);
    for (;;) {
      const got = await pending.complete(mb);
      if (got) {
        const { getChallenge } = await import("./http-api.js");
        const instanceId = (await getChallenge(url)).instanceId;
        await newDeviceFile(env.stateDir, got.bundle.deviceCredential.deviceId, dk);
        writeJson(join(env.stateDir, "account.json"), { accountId: got.bundle.accountId, key: got.bundle.accountKey, server: { url, instanceId } } satisfies AccountFile);
        out(`paired by ${got.bundle.fromDevice}; check the code on both devices: ${got.sas}`);
        return 0;
      }
      if (Date.now() > deadline) throw new Error("pairing timed out");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const st = await openState(env.stateDir);
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

  if (cmd === "pair-accept") {
    const [code] = args;
    if (!code || !st.http) throw new Error("usage: pair-accept <code> (server mode)");
    const http = st.http;
    const { sas, deviceId } = await acceptPairing(code, { accountId: st.accountId, accountKey: st.key.rawB64, fromDevice: st.device.name }, (pub) => http.addDevice(pub), http.pairingMailbox());
    out(`paired device ${deviceId}; check the code on both devices: ${sas}`);
    return 0;
  }
  if (cmd === "devices") {
    if (!st.http) throw new Error("devices: server mode only");
    if (args[0] === "revoke" && args[1]) {
      await st.http.revokeDevice(args[1]);
      out(`revoked ${args[1]}`);
      return 0;
    }
    for (const d of await st.http.listDevices()) out(`${d.deviceId}${d.deviceId === st.device.id ? " (this device)" : ""} ${d.publicKey}`);
    return 0;
  }
  if (cmd === "kit") {
    // Rescue kit (format 3): the pointer's backend and slot when the account has a pointer, plus every backend.
    const { encodeRescueKit3 } = await import("./snapshots.js");
    const { backendDescriptors } = await import("./vault.js");
    const v = await st.vault.load();
    const list = backendDescriptors(v);
    const own = list.find((b) => b.id === v.pointer?.webhookId) ?? list[0];
    if (!own) throw new Error("vault has no webhooks: `ddn webhook add <url-file>`");
    out(encodeRescueKit3({ v: 3, accountId: st.accountId, key: st.key.rawB64, backend: own, slot: v.pointer?.messageId ?? "-", backends: list.filter((b) => b.id !== own.id) }));
    return 0;
  }

  if ((cmd === "put" || cmd === "get") && (await st.vault.load()).webhooks.length === 0) {
    throw new Error("vault has no webhooks: `ddn webhook add <url-file>`");
  }
  const client = await openClient(st, transport);
  if (env.transferLog) {
    const { TransferLog } = await import("./transfer-log.js");
    const file = env.transferLog;
    client.setTransferLog(new TransferLog((line) => appendFileSync(file, line, { mode: 0o600 }), { src: "cli", names: env.transferLogNames, mode: "metadata-only" }));
  }
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
      out("usage: ddn [--state DIR] init [--server URL] | rescue --server URL <kit> | pair-offer --server URL | pair-accept <code> | devices [revoke <id>] | kit | webhook add <url-file>|ls|rm <id> | put <file> [name] | get <name|id> <out> | ls");
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
    else if (a === "--transfer-log") env.transferLog = argv[++i]!;
    else if (a === "--transfer-log-names") env.transferLogNames = true;
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
