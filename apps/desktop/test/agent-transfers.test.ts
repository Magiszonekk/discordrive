// The agent's transfers, end to end on one machine: the real instance server, a fake Discord over HTTPS +
// HTTP/2, the agent's own connections (h2Fetch), uploads read from disk and downloads written to disk at
// offsets. Then the hard case: the agent process is killed (SIGKILL) in the middle of a download and a new
// one continues from the stored resume point, fetching only the rest, and the file still checks out.
import { execFileSync, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DdnServer, FakeDiscord, h2Fetch } from "@ddv4/metadata-client/node";
import { sha256Hex } from "@ddv4/metadata-client";
import { AppCore } from "../../web-mo/src/app-core.js";
import { nodePlatform } from "../src/agent/node-platform.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-agent-"));
const fake = new FakeDiscord();
let srv: DdnServer;
let url = "";
let origin = "";
let ca = "";

beforeAll(async () => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(tmp, "k"), "-out", join(tmp, "c"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  ca = readFileSync(join(tmp, "c"), "utf8");
  origin = await fake.listen({ tls: { key: readFileSync(join(tmp, "k")), cert: ca } });
  srv = new DdnServer({ rateLimits: false, signup: "open" });
  url = (await srv.listen(0)).url;
});
afterAll(async () => {
  await srv.close().catch(() => {});
  await fake.close();
}, 60_000);

const platformFor = (dataDir: string, downloadsDir: string) => {
  const f = h2Fetch({ tls: { ca } });
  return { f, p: nodePlatform({ dataDir, downloadsDir, discordFetch: f }) };
};

describe("desktop agent transfers (Node, HTTP/2 to a fake Discord)", () => {
  it("uploads a file and a folder from disk, downloads to disk at offsets, over separate h2 sessions", async () => {
    const dataDir = join(tmp, "a-data");
    const dl = join(tmp, "a-dl");
    const { f, p } = platformFor(dataDir, dl);
    const core = new AppCore({ discordApiOrigin: origin }, p);
    await core.createAccount(url, "agent test");
    await core.open();
    for (const ch of ["1550000000000000401", "1550000000000000402", "1550000000000000403"]) await core.addWebhook(fake.addWebhook(ch).url);

    const src = join(tmp, "src");
    execFileSync("mkdir", ["-p", join(src, "album", "inner")]);
    const big = randomBytes(25 * 1024 * 1024 + 123);
    writeFileSync(join(src, "big.bin"), big);
    writeFileSync(join(src, "album", "a.txt"), "hello");
    writeFileSync(join(src, "album", "inner", "b.txt"), "world");
    const r = await core.uploadPaths([join(src, "big.bin"), join(src, "album")]);
    expect(r).toMatchObject({ files: 3, failed: [] });
    // Uploads went over more than one HTTP/2 session.
    expect(f.stats().filter((s) => s.role === "up").length).toBeGreaterThan(1);

    const rows = core.list().rows;
    const bigNode = rows.find((x) => x.name === "big.bin")!;
    const album = rows.find((x) => x.name === "album")!;
    expect(album.kind).toBe("folder");
    expect(core.list(album.id).rows.map((x) => x.name).sort()).toEqual(["a.txt", "inner"]);

    const d = await core.downloadToDisk(bigNode.id);
    expect(d.path).toBe(join(dl, "big.bin"));
    expect(await sha256Hex(readFileSync(d.path))).toBe(await sha256Hex(big));
    // A second download of the same file gets a free name; no partial files are left behind.
    const d2 = await core.downloadToDisk(bigNode.id);
    expect(d2.path).toBe(join(dl, "big (1).bin"));
    expect(readdirSync(dl).filter((x) => x.endsWith(".ddnpart"))).toEqual([]);
    // Downloads shared one session.
    expect(f.stats().filter((s) => s.role === "down" && s.alive).length).toBe(1);
    expect(await core.unfinishedDownloads()).toEqual([]);
    core.close();
    f.close();
  });

  it("killed mid-download (SIGKILL): the next agent continues from the resume point, fetches only the rest", { timeout: 240_000 }, async () => {
    const dataDir = join(tmp, "k-data");
    const dl = join(tmp, "k-dl");
    const { f, p } = platformFor(dataDir, dl);
    const core = new AppCore({ discordApiOrigin: origin }, p);
    await core.createAccount(url, "kill test");
    await core.open();
    await core.addWebhook(fake.addWebhook("1550000000000000411").url);
    const data = randomBytes(60 * 1024 * 1024 + 7);
    writeFileSync(join(tmp, "k.bin"), data);
    await core.uploadPaths([join(tmp, "k.bin")]);
    const nodeId = core.list().rows.find((x) => x.name === "k.bin")!.id;
    core.close();
    f.close();

    // A separate agent process downloads slowly and is killed once a resume point with fragments is stored.
    fake.cdnBytesPerSec = 12 * 1024 * 1024;
    const gets0 = fake.cdnGets;
    const child = fork(join(here, "agent-child.ts"), [], {
      execArgv: ["--import", "tsx", "--import", pathToFileURL(join(here, "mode-hook.mjs")).href],
      env: { ...process.env, DDN_T_DATA: dataDir, DDN_T_DL: dl, DDN_T_ORIGIN: origin, DDN_T_CA: ca, DDN_T_NODE: nodeId },
      stdio: ["ignore", "inherit", "pipe", "ipc"],
    });
    let childLog = "";
    child.stderr!.on("data", (d: Buffer) => (childLog += d.toString()));
    const resumeDir = join(dataDir, "resume");
    const deadline = Date.now() + 90_000;
    let next = 0;
    let exited: number | null = null;
    child.once("exit", (c) => (exited = c ?? -1));
    while (Date.now() < deadline && exited === null) {
      await new Promise((r) => setTimeout(r, 200));
      next = 0;
      for (const acct of existsSync(resumeDir) ? readdirSync(resumeDir) : [])
        for (const fname of readdirSync(join(resumeDir, acct))) {
          const e = JSON.parse(readFileSync(join(resumeDir, acct, fname), "utf8")) as { k: string; v: { next?: number; hash?: string } };
          if (e.k.startsWith("dl:") && e.v.hash) next = Math.max(next, e.v.next ?? 0);
        }
      if (next >= 2) break;
    }
    if (next < 2 || exited !== null) console.error(`child agent (exit ${exited}):\n${childLog.slice(-4000)}`);
    expect(exited).toBeNull(); // the child must still be downloading (it failed to start otherwise)
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once("exit", r));
    expect(next).toBeGreaterThanOrEqual(2);
    const part = readdirSync(dl).find((x) => x.endsWith(".ddnpart"));
    expect(part).toBeDefined();
    const fetchedBefore = fake.cdnGets - gets0;
    fake.cdnBytesPerSec = 0;

    // New agent: it finds the unfinished download and continues it by itself.
    const again = platformFor(dataDir, dl);
    const core2 = new AppCore({ discordApiOrigin: origin }, again.p);
    await core2.open();
    const un = await core2.unfinishedDownloads();
    expect(un).toHaveLength(1);
    const g1 = fake.cdnGets;
    expect(await core2.resumeDownloads()).toBe(1);
    const fetchedAfter = fake.cdnGets - g1;
    const out = join(dl, "k.bin");
    expect(statSync(out).size).toBe(data.byteLength);
    expect(await sha256Hex(readFileSync(out))).toBe(await sha256Hex(data));
    // Only the fragments past the resume point were fetched again (+1: the manifest).
    const n = (core2 as unknown as { c(): { store: { getNode(id: string): { content: { chunkCount: number } } } } }).c().store.getNode(nodeId).content.chunkCount;
    expect(fetchedAfter).toBe(n - un[0]!.next + 1);
    expect(readdirSync(dl).filter((x) => x.endsWith(".ddnpart"))).toEqual([]);
    expect(await core2.unfinishedDownloads()).toEqual([]);
    console.log(`kill test: resume point ${un[0]!.next}/${n}, fetched before kill ${fetchedBefore}, after ${fetchedAfter}`);
    core2.close();
    again.f.close();
  });
});
