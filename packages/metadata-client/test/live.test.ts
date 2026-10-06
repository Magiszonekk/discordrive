// Live slice on the TEST server a test Discord server only (koncept §7 environment).
// Runs only with DDN_LIVE=1 and DDN_LIVE_WEBHOOK_FILE pointing at a webhook URL
// file created by tools/testbot.py. Never prints the URL.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openClient, openState, runCli } from "../src/cli.js";
import { DiscordWebhookTransport, decodeManifestRef, sha256Hex, toWebhookRefs } from "../src/index.js";

const live = process.env.DDN_LIVE === "1" && !!process.env.DDN_LIVE_WEBHOOK_FILE;

describe.skipIf(!live)("live: CLI put/get through a real test webhook", () => {
  it("uploads a multi-fragment file and downloads it with matching SHA-256", async () => {
    const hookFile = process.env.DDN_LIVE_WEBHOOK_FILE!;
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-live-"));
    const size = Number(process.env.DDN_LIVE_BYTES ?? 25 * 1024 * 1024);
    const data = crypto.getRandomValues(new Uint8Array(65536));
    const big = new Uint8Array(size);
    for (let o = 0; o < size; o += data.byteLength) big.set(data.subarray(0, Math.min(data.byteLength, size - o)), o);
    big[0] = 1; big[size - 1] = 2;
    const src = join(dir, "in.bin");
    writeFileSync(src, big);
    const lines: string[] = [];
    const env = { stateDir: join(dir, "state"), webhookFiles: [] as string[], out: (l: string) => (lines.push(l), console.log(l)) };
    expect(await runCli(["init"], env)).toBe(0);
    expect(await runCli(["webhook", "add", hookFile], env)).toBe(0); // GET webhook on Discord, then sealed vault
    expect(await runCli(["put", src, "live.bin"], env)).toBe(0);
    const dst = join(dir, "out.bin");
    expect(await runCli(["get", "live.bin", dst], env)).toBe(0);
    expect(await sha256Hex(readFileSync(dst))).toBe(await sha256Hex(big));

    // Clean up: delete every message this upload made (fragments + manifest).
    const c = await openClient((await openState(env.stateDir)), new DiscordWebhookTransport());
    const node = c.list().find((x) => x.name === "live.bin")!;
    const ref = c.store.getNode(node.id)!.content!.manifestRef;
    const { manifest } = await c.loadManifest(ref);
    const t = new DiscordWebhookTransport();
    const [hook] = toWebhookRefs(await (await openState(env.stateDir)).vault.load());
    for (const id of [...manifest.chunks.map((ch) => ch.placements![0]!.messageId!), decodeManifestRef(ref).at.messageId]) {
      await t.deleteMessage(hook!, id);
      await new Promise((r) => setTimeout(r, 400));
    }
  });
});

describe.skipIf(!live)("live: snapshot + pointer message, restore from Discord only", () => {
  it("writes segment + base, edits the pointer (PATCH), restores the same tree, cleans up", async () => {
    const { accountKeyFromB64 } = await import("../src/account-key.js");
    const { canonicalState, ROOT_ID } = await import("@ddv4/sync-core");
    const { clientBlobIO, createPointerMessage, rescueBlobIO, restoreFromDiscord, writeSnapshot } = await import("../src/index.js");
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-live-snap-"));
    const env = { stateDir: join(dir, "state"), webhookFiles: [] as string[], out: () => {} };
    expect(await runCli(["init"], env)).toBe(0);
    expect(await runCli(["webhook", "add", process.env.DDN_LIVE_WEBHOOK_FILE!], env)).toBe(0);
    const st = (await openState(env.stateDir));
    const t = new DiscordWebhookTransport();
    const c = await openClient(st, t);
    const [hook] = c.webhooks;
    const io = clientBlobIO(c, t, 64 * 1024);
    const posted: string[] = [];
    const ioTracked = { ...io, post: async (d: Uint8Array, f: string) => { const p = await io.post(d, f); posted.push(p.messageId); return p; } };
    const loc = await createPointerMessage(io, st.key, st.accountId, hook!);
    posted.push(loc.messageId);
    try {
      for (let i = 0; i < 5; i++) await c.commitOp({ type: "create", kind: "folder", nodeId: `live-fold-${i}000`, parentId: ROOT_ID, name: `Folder ${i}` }, "mkdir");
      const deps = { io: ioTracked, key: st.key, accountId: st.accountId, pointer: loc, log: st.log, store: c.store, now: () => Date.now() };
      expect((await writeSnapshot(deps, "segment")).written).toBe("written");
      expect((await writeSnapshot(deps, "base")).kind).toBe("base");
      await c.commitOp({ type: "rename", nodeId: "live-fold-0000", name: "Po zmianie" }, "rename");
      expect((await writeSnapshot(deps, "segment")).written).toBe("written");

      const key2 = accountKeyFromB64(st.key.rawB64);
      const r = await restoreFromDiscord(rescueBlobIO(new DiscordWebhookTransport(), hook!), key2, st.accountId, loc);
      expect(canonicalState(r.store)).toBe(canonicalState(c.store));
      console.log(`live snapshot: toSeq ${r.pointer.toSeq}, base at ${r.baseHeadSeq}, tail ${r.tail.length}, objects ${posted.length}`);
    } finally {
      for (const id of posted) {
        await t.deleteMessage(hook!, id).catch(() => {});
        await new Promise((res) => setTimeout(res, 400));
      }
    }
  });
});

describe.skipIf(!live)("live: CLI through the HTTP server (Ed25519 sign-in) + range read", () => {
  it("init --server, webhook add, put, second device by pairing, get + range read, clean up", async () => {
    const { DdnServer } = await import("../src/node/index.js");
    const srv = new DdnServer();
    const { url } = await srv.listen(0);
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-live-srv-"));
    const lines: string[] = [];
    const envA = { stateDir: join(dir, "A"), webhookFiles: [] as string[], out: (l: string) => lines.push(l) };
    const envB = { ...envA, stateDir: join(dir, "B") };
    const t = new DiscordWebhookTransport();
    const posted: string[] = [];
    let hookRef: { id: string; url: string } | undefined;
    try {
      expect(await runCli(["init", "--server", url], envA)).toBe(0);
      expect(await runCli(["webhook", "add", process.env.DDN_LIVE_WEBHOOK_FILE!], envA)).toBe(0);
      const size = 12 * 1024 * 1024 + 12345;
      const data = new Uint8Array(size);
      for (let o = 0; o < size; o += 65536) crypto.getRandomValues(data.subarray(o, Math.min(size, o + 65536)));
      const src = join(dir, "in.bin");
      writeFileSync(src, data);
      expect(await runCli(["put", src, "srv.bin"], envA)).toBe(0);
      process.env.DDN_PAIR_WAIT_MS = "30000";
      const offer = runCli(["pair-offer", "--server", url], envB);
      let code: string | undefined;
      for (let i = 0; i < 200 && !code; i++) {
        await new Promise((r) => setTimeout(r, 50));
        code = lines.find((l) => l.startsWith("pairing code: "))?.slice(14);
      }
      expect(await runCli(["pair-accept", code!], envA)).toBe(0);
      expect(await offer).toBe(0);
      const dst = join(dir, "out.bin");
      expect(await runCli(["get", "srv.bin", dst], envB)).toBe(0);
      expect(await sha256Hex(readFileSync(dst))).toBe(await sha256Hex(data));
      const stB = await openState(envB.stateDir);
      const cB = await openClient(stB, t);
      const node = cB.list().find((x) => x.name === "srv.bin")!;
      const r = await cB.readRange(node.id, 10 * 1024 * 1024 - 100, 10 * 1024 * 1024 + 100);
      expect(r.data).toEqual(data.subarray(10 * 1024 * 1024 - 100, 10 * 1024 * 1024 + 101));
      const ref = cB.store.getNode(node.id)!.content!.manifestRef;
      const { manifest } = await cB.loadManifest(ref);
      posted.push(...manifest.chunks.map((ch) => ch.placements![0]!.messageId!), decodeManifestRef(ref).at.messageId);
      hookRef = cB.webhooks[0];
      console.log(`live server: ${size} B, ${manifest.chunks.length} fragments, paired + range read OK, devices ${(await stB.http!.listDevices()).length}`);
    } finally {
      delete process.env.DDN_PAIR_WAIT_MS;
      for (const id of posted) {
        await t.deleteMessage(hookRef!, id).catch(() => {});
        await new Promise((res) => setTimeout(res, 400));
      }
      await srv.close();
    }
  });
});
