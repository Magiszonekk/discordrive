// Background snapshots of the e2ee instance: segments without any client, ≤ 5 min loss, and
// rebuilding an account's log from Discord after the server database is lost.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryIndexStore, Sequencer, applyEntries, canonicalState, initIndex } from "@ddv4/sync-core";
import { ChannelPacer, DiscordWebhookTransport, DriveClient, EncryptedArbiter, HttpApi, OpCodec, createAccountHttp, generateDeviceKey, memorySource, newAccountKey } from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { BlobsExtension, DiscordSender, InstanceHooks, POOL, SnapshotsExtension, loadInstanceKey, rebuildAccountLog } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

describe("e2ee: server-written snapshots (§6.2) with no client open", () => {
  it("segment after 1 min of silence / at the latest 5 min; the chain rebuilds the log after the database is gone", async () => {
    let t = Date.UTC(2026, 9, 12, 10);
    const fake = new FakeDiscord();
    const origin = await fake.listen();
    cleanups.push(() => fake.close());
    const dir = mkdtempSync(join(tmpdir(), "ddn-snap-"));
    const ikey = loadInstanceKey(join(dir, "instance.key"));
    const transport = new DiscordWebhookTransport({ apiOrigin: origin });
    const sender = new DiscordSender({ transport, pacer: new ChannelPacer({ perMin: 6000, maxPerMin: 6000, burst: 20 }) });
    let hooks!: InstanceHooks;
    const snaps = new SnapshotsExtension({ instanceKey: ikey, hooks: () => hooks, sender, dataDir: dir, tickMs: 0 });
    const srv = new DdnServer({
      dbPath: join(dir, "ddn.db"),
      mode: "e2ee",
      rateLimits: false,
      now: () => t,
      extensions: [
        { name: "hooks", init: (s) => void (hooks = new InstanceHooks(s.db, ikey, s.clock)) },
        new BlobsExtension({ get hooks() { return hooks; }, sender, tickMs: 0, cdnOrigins: [origin] } as never),
        snaps,
      ],
    });
    const { url } = await srv.listen(0);
    cleanups.push(() => srv.close());
    const pool = fake.addWebhook("1550000000000000201");
    await hooks.add(POOL, pool.url, transport);

    const key = newAccountKey();
    const dk = await generateDeviceKey();
    const r = await createAccountHttp(url, dk, key);
    const api = new HttpApi({ baseUrl: url, accountId: r.accountId, deviceId: r.deviceId, key: dk });
    const client = new DriveClient({ device: { id: r.deviceId, name: "d" }, arbiter: new EncryptedArbiter(new OpCodec(key, r.accountId), api), blobs: new ServerBlobStore(api), now: () => t });
    await client.commitOp({ type: "create", kind: "folder", nodeId: "folderAAAAAAAAAAAAAAAAA", parentId: "root", name: "Photos" }, "mkdir");
    await client.upload(memorySource(new Uint8Array(500).fill(7)), "a.jpg", "folderAAAAAAAAAAAAAAAAA");

    // The client is gone from here on. 30 s of silence: not due yet.
    t += 30_000;
    expect(await snaps.tick()).toBe(0);
    t += 31_000; // > 1 min of silence
    expect(await snaps.tick()).toBe(1);
    expect(snaps.stats.segments).toBe(1);
    expect(srv.health()).toMatchObject({ snapshots: { by: "server", segments: 1 } });

    // A steady trickle never goes quiet for a minute: still written within 5 minutes.
    for (let i = 0; i < 6; i++) {
      await client.commitOp({ type: "rename", nodeId: "folderAAAAAAAAAAAAAAAAA", name: `Photos ${i}` }, "rename");
      t += 50_000;
      await snaps.tick();
    }
    expect(snaps.stats.segments).toBe(2);
    const loc = snaps.location(r.accountId)!;
    expect(existsSync(join(dir, "snapshots.json"))).toBe(true);
    expect(readFileSync(join(dir, "snapshots.json"), "utf8")).toContain(loc.messageId);

    // Close the gap and write what is left.
    await snaps.tick(true);
    const head = srv.logHead(r.accountId);

    // Disaster: the database is gone. Instance key + webhooks + snapshots.json rebuild the log.
    const rebuilt = await rebuildAccountLog(ikey, hooks, sender, r.accountId, loc);
    expect(rebuilt.length).toBe(head);
    expect(rebuilt.map((e) => e.seq)).toEqual(Array.from({ length: head }, (_, i) => i + 1));
    // A fresh arbiter seeded with it accepts the old log and continues.
    const seq = new Sequencer({ initialLog: rebuilt as never });
    expect(seq.headSeq).toBe(head);
    // The client (account key) decrypts it to the same tree it had.
    const codec = new OpCodec(key, r.accountId);
    const st = new MemoryIndexStore();
    initIndex(st);
    applyEntries(st, await Promise.all(rebuilt.map((e) => codec.decrypt(e))));
    expect(canonicalState(st)).toEqual(canonicalState(client.store));
    // The chain is sealed with the server's key: the operations inside stay unreadable to it.
    const raw = [...fake.messages.values()].flatMap((m) => m.attachments.map((a) => Buffer.from(a.data).toString("latin1"))).join("");
    expect(raw).not.toContain("Photos");
  });
});
