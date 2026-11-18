// ddn against real instances (metadata only, e2ee, plain) with a fake Discord: an account made by the app's
// core, an API key from it, then the command line as a script would use it: login, whoami, mkdir, put of a
// file and a folder tree, ls, stat, get (SHA-256 equal), conflicts, mv, rm, find, a key from the environment,
// a damaged key, and a revoked key (exit 5).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { ChannelPacer, DiscordWebhookTransport, HttpApi, createApiKey, createAccountHttp, generateDeviceKey, newAccountKey, getChallenge, type AccountKey } from "@ddv4/metadata-client";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { main, type CliIo } from "../src/cli.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => {});
});
const tmp = (p: string) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), p));
const sha = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex");

type Mode = "metadata-only" | "e2ee" | "plain";

async function instance(mode: Mode) {
  const fake = new FakeDiscord();
  const origin = await fake.listen();
  cleanups.push(() => fake.close());
  const dir = tmp(`ddn-cli-${mode}-`);
  let extensions: ConstructorParameters<typeof DdnServer>[0] extends infer O ? (O extends { extensions?: infer X } ? X : never) : never = [];
  let pool: (() => Promise<void>) | null = null;
  if (mode !== "metadata-only") {
    const { serverBlobsMode, POOL } = await import("@ddv4/server-discord");
    const m = serverBlobsMode({ dataDir: dir, discordApiOrigin: origin, cleanupTickMs: 0, snapshotTickMs: 0, pacer: new ChannelPacer({ perMin: 6000, maxPerMin: 6000, burst: 50 }) });
    extensions = m.extensions;
    if (mode === "plain") {
      const { PlainExtension } = await import("@ddv4/server-discord/plain");
      extensions = [...m.extensions, new PlainExtension({ dataDir: dir, blobs: m.blobs })];
    }
    pool = async () => {
      for (const c of ["1550000000000000501", "1550000000000000502"]) await m.hooks().add(POOL, fake.addWebhook(c).url, new DiscordWebhookTransport({ apiOrigin: origin }));
    };
  }
  const srv = new DdnServer({ dbPath: join(dir, "ddn.db"), mode, rateLimits: false, signup: "open", extensions });
  const { url } = await srv.listen(0);
  cleanups.push(() => srv.close());
  await pool?.();
  return { fake, origin, url, srv };
}

/** An account with one device (as the app makes it) and, in metadata only, one channel in its vault. */
async function account(I: Awaited<ReturnType<typeof instance>>, mode: Mode): Promise<{ key: AccountKey; api: HttpApi; accountId: string; instanceId: string }> {
  const key = newAccountKey();
  const dk = await generateDeviceKey();
  const a = await createAccountHttp(I.url, dk, key);
  const api = new HttpApi({ baseUrl: I.url, accountId: a.accountId, deviceId: a.deviceId, key: dk, instanceId: a.instanceId });
  if (mode === "metadata-only") {
    const { WebhookVault, inspectForVault } = await import("@ddv4/metadata-client");
    const v = new WebhookVault(api, key, a.accountId);
    for (const c of ["1550000000000000601", "1550000000000000602"]) await v.addWebhook(await inspectForVault(new DiscordWebhookTransport({ apiOrigin: I.origin }), I.fake.addWebhook(c).url));
  }
  return { key, api, accountId: a.accountId, instanceId: a.instanceId };
}

function io(I: { origin: string }, configDir: string, extraEnv: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const chunks: Buffer[] = [];
  const x: CliIo & { lines: () => Record<string, unknown>[]; out: (l: string) => void; outs: string[]; errs: string[]; bytes: () => Buffer } = {
    outs: out,
    errs: err,
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    env: { DDN_CONFIG_DIR: configDir, ...extraEnv },
    discordApiOrigin: I.origin,
    stdout: new Writable({ write: (c, _e, cb) => (chunks.push(Buffer.from(c)), cb()) }) as unknown as NodeJS.WritableStream,
    lines: () => out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>),
    bytes: () => Buffer.concat(chunks),
  };
  return x;
}

async function run(x: ReturnType<typeof io>, ...argv: string[]): Promise<number> {
  x.outs.length = 0;
  x.errs.length = 0;
  return main(argv, x);
}

for (const mode of ["metadata-only", "e2ee", "plain"] as Mode[]) {
  describe(`ddn on a ${mode} instance`, () => {
    it("login with an API key, put/get/ls/stat/mv/rm/find, key from the environment, revoked key", async () => {
      const I = await instance(mode);
      const A = await account(I, mode);
      const made = await createApiKey(A.api, { server: I.url, instanceId: A.instanceId, accountId: A.accountId, key: A.key }, "cli test");
      const cfg = tmp("ddn-cli-cfg-");
      const keyFile = join(cfg, "key.txt");
      // As the app's "Download file" writes it: title, server, date, the key, how to use.
      writeFileSync(keyFile, `discordrive-next: API key\nServer: ${I.url}\n\n${made.text}\n\nHow to use: …\n`);
      const x = io(I, join(cfg, "conf"));

      // Not signed in yet.
      expect(await run(x, "whoami")).toBe(5);
      expect(await run(x, "login", "--key-file", keyFile, "--json")).toBe(0);
      expect(x.lines()[0]).toMatchObject({ ok: true, mode, accountId: A.accountId, deviceId: made.deviceId });
      if (process.platform !== "win32") expect(statSync(join(cfg, "conf", "default", "keys.bin")).mode & 0o777).toBe(0o600);
      expect(await run(x, "whoami", "--json")).toBe(0);
      expect(x.lines()[0]).toMatchObject({ mode, accountId: A.accountId, deviceId: made.deviceId, canUpload: true });

      // Files on this computer: one big-ish file (several pieces), a tree.
      const local = tmp("ddn-cli-local-");
      const big = new Uint8Array(randomBytes(23 * 1024 * 1024 + 123));
      writeFileSync(join(local, "big.bin"), big);
      mkdirSync(join(local, "tree", "sub", "deeper"), { recursive: true });
      writeFileSync(join(local, "tree", "a.txt"), "alpha");
      writeFileSync(join(local, "tree", "sub", "b.txt"), "beta");
      writeFileSync(join(local, "tree", "sub", "deeper", "c.txt"), "gamma");
      mkdirSync(join(local, "tree", "empty", "inner"), { recursive: true });

      expect(await run(x, "mkdir", "-p", "/Backup/2026", "--json")).toBe(0);
      expect(await run(x, "put", join(local, "big.bin"), "/Backup/2026/", "--json")).toBe(0);
      const up = x.lines().find((l) => l.event === "uploaded")!;
      expect(up).toMatchObject({ path: "/Backup/2026/big.bin", size: big.byteLength, sha256: sha(big), skipped: false });
      expect(await run(x, "put", join(local, "tree"), "/Backup/", "--json")).toBe(0);
      expect(x.lines().filter((l) => l.event === "uploaded").map((l) => l.path).sort()).toEqual(["/Backup/tree/a.txt", "/Backup/tree/sub/b.txt", "/Backup/tree/sub/deeper/c.txt"]);
      expect(x.lines().filter((l) => l.event === "folder").map((l) => l.path)).toEqual(["/Backup/tree/empty/inner"]);

      // Listing: stable JSON lines; names for people.
      expect(await run(x, "ls", "/Backup", "--json")).toBe(0);
      expect(x.lines().map((l) => [l.name, l.kind])).toEqual([["2026", "folder"], ["tree", "folder"]]);
      expect(await run(x, "ls", "/Backup/tree")).toBe(0);
      expect(x.outs).toEqual(["empty/", "sub/", "a.txt"]);
      expect(await run(x, "stat", "/Backup/2026/big.bin", "--json")).toBe(0);
      expect(x.lines()[0]).toMatchObject({ kind: "file", size: big.byteLength, sha256: sha(big) });
      // A file's ID from --json works where a path does.
      expect(await run(x, "stat", String(up.id), "--json")).toBe(0);
      expect(x.lines()[0]).toMatchObject({ path: "/Backup/2026/big.bin", kind: "file" });

      // Conflicts: rename (default) adds " (1)", skip leaves it, replace makes a new version.
      writeFileSync(join(local, "a.txt"), "second alpha");
      expect(await run(x, "put", join(local, "a.txt"), "/Backup/tree/", "--json")).toBe(0);
      expect(x.lines()[0]).toMatchObject({ path: "/Backup/tree/a (2).txt" });
      expect(await run(x, "put", join(local, "a.txt"), "/Backup/tree/", "--on-conflict", "skip", "--json")).toBe(0);
      expect(x.lines()[0]).toMatchObject({ path: "/Backup/tree/a.txt", skipped: true });
      expect(await run(x, "put", join(local, "a.txt"), "/Backup/tree/", "--on-conflict", "replace", "--json")).toBe(0);
      expect(x.lines()[0]).toMatchObject({ path: "/Backup/tree/a.txt", replaced: true });

      // Download: a file into a folder, to stdout, a folder with -r.
      const dl = tmp("ddn-cli-dl-");
      expect(await run(x, "get", "/Backup/2026/big.bin", dl, "--json")).toBe(0);
      expect(sha(readFileSync(join(dl, "big.bin")))).toBe(sha(big));
      expect(existsSync(join(dl, "big.bin.ddnpart"))).toBe(false);
      expect(await run(x, "get", "/Backup/tree/a.txt", "-")).toBe(0);
      expect(x.bytes().toString()).toBe("second alpha");
      expect(await run(x, "stat", "/Backup/tree/a.txt", "--json")).toBe(0);
      const aId = String(x.lines()[0]!.id);
      expect(await run(x, "get", aId, "-")).toBe(0);
      expect(x.bytes().toString()).toBe("second alphasecond alpha");
      expect(await run(x, "get", "/Backup/tree", dl)).toBe(2);
      expect(await run(x, "get", "-r", "/Backup/tree", dl)).toBe(0);
      expect(readFileSync(join(dl, "tree", "sub", "deeper", "c.txt"), "utf8")).toBe("gamma");
      // Empty folders come back too.
      expect(statSync(join(dl, "tree", "empty", "inner")).isDirectory()).toBe(true);

      // Not found: exit 3.
      expect(await run(x, "get", "/nope.bin", dl)).toBe(3);
      expect(await run(x, "ls", "/Backup/nope")).toBe(3);

      // Move into a folder, rename, trash, find.
      expect(await run(x, "mv", "/Backup/tree/a (2).txt", "/Backup/2026")).toBe(0);
      expect(await run(x, "mv", "/Backup/2026/a (2).txt", "/Backup/2026/notes.txt")).toBe(0);
      expect(await run(x, "ls", "/Backup/2026")).toBe(0);
      expect(x.outs.sort()).toEqual(["big.bin", "notes.txt"]);
      expect(await run(x, "find", "notes", "--json")).toBe(0);
      expect(x.lines().map((l) => l.path)).toEqual(["/Backup/2026/notes.txt"]);
      expect(await run(x, "rm", "/Backup/2026/notes.txt")).toBe(0);
      expect(await run(x, "ls", "/Backup/2026")).toBe(0);
      expect(x.outs).toEqual(["big.bin"]);
      expect(await run(x, "rm", "--permanent", "/Backup/tree/sub")).toBe(2);
      expect(await run(x, "rm", "--permanent", "--yes", "/Backup/tree/sub")).toBe(0);

      // The same key from the environment (scripts, containers): nothing stored about the key itself.
      const envCfg = join(cfg, "env-conf");
      const y = io(I, envCfg, { DDN_API_KEY_FILE: keyFile });
      expect(await run(y, "ls", "/Backup/2026", "--json")).toBe(0);
      expect(y.lines().map((l) => l.name)).toEqual(["big.bin"]);
      const envDirs = existsSync(envCfg) ? (await import("node:fs")).readdirSync(envCfg) : [];
      expect(envDirs.every((d) => d.startsWith("env-"))).toBe(true);
      for (const d of envDirs) expect(existsSync(join(envCfg, d, "keys.bin"))).toBe(false);

      // A damaged key: a readable message, exit 5.
      const z = io(I, join(cfg, "bad-conf"), { DDN_API_KEY: made.text.slice(0, -3) + "xyz" });
      expect(await run(z, "whoami")).toBe(5);
      expect(z.errs.join(" ")).toMatch(/damaged|incomplete/);
      expect(z.errs.join(" ")).not.toMatch(/JSON|Unexpected/);

      // Revoked in the app: refused with exit 5 and a message saying so.
      await A.api.revokeDevice(made.deviceId);
      expect(await run(x, "ls", "/")).toBe(5);
      expect(x.errs.join(" ")).toMatch(/refused this API key/);

      // Logout forgets it here.
      expect(await run(x, "logout")).toBe(0);
      expect(existsSync(join(cfg, "conf", "default"))).toBe(false);
      void getChallenge;
    });
  });
}

describe("ddn usage", () => {
  it("help, unknown command and option, version", async () => {
    const x = io({ origin: "http://127.0.0.1:9" }, tmp("ddn-cli-u-"));
    expect(await run(x)).toBe(2);
    expect(x.outs.join("\n")).toMatch(/ddn login/);
    expect(await run(x, "help")).toBe(0);
    expect(await run(x, "--bogus")).toBe(2);
    // An unknown command is a usage error before any key is looked at.
    expect(await run(x, "frob")).toBe(2);
    expect(await run(x, "version", "--json")).toBe(0);
    expect(x.lines()[0]).toHaveProperty("version");
  });
});
