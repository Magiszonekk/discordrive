// e2ee: the instance copies the Safe's slot into the account's chain on its channels; after the database is
// lost the operator rebuilds it from Discord (rebuildAccountSafe → restoreSlot), and a database restored from an
// older backup gets the newer Safe back by itself. A moved chain takes the copies along.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelPacer, DiscordWebhookTransport, HttpApi, SafeBadPasswordError, SafeStore, createAccountHttp, generateDeviceKey, newAccountKey, readPointer } from "@ddv4/metadata-client";
import { DdnServer, FakeDiscord } from "@ddv4/metadata-client/node";
import { BlobsExtension, DiscordSender, InstanceHooks, POOL, SnapshotsExtension, loadInstanceKey, rebuildAccountSafe, serverBlobIO, serverSnapshotKey } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});
const FAST = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const PW = "correct horse battery staple";

async function instance(dir: string, fake: FakeDiscord, origin: string, clock: { t: number }) {
  const ikey = loadInstanceKey(join(dir, "instance.key"));
  const transport = new DiscordWebhookTransport({ apiOrigin: origin });
  const sender = new DiscordSender({ transport, pacer: new ChannelPacer({ perMin: 6000, maxPerMin: 6000, burst: 20 }) });
  let hooks!: InstanceHooks;
  const snaps = new SnapshotsExtension({ instanceKey: ikey, hooks: () => hooks, sender, dataDir: dir, tickMs: 0 });
  const srv = new DdnServer({
    dbPath: join(dir, "ddn.db"),
    mode: "e2ee",
    rateLimits: false,
    now: () => clock.t,
    extensions: [{ name: "hooks", init: (s) => void (hooks = new InstanceHooks(s.db, ikey, s.clock)) }, new BlobsExtension({ get hooks() { return hooks; }, sender, tickMs: 0, cdnOrigins: [origin] } as never), snaps],
  });
  const { url } = await srv.listen(0);
  cleanups.push(() => srv.close());
  return { srv, url, snaps, ikey, sender, transport, hooks: () => hooks };
}

describe("e2ee: copies of the Safe in the server-written chain", () => {
  it("copied after a quiet minute (no client open); the database lost → rebuilt from Discord → opens with the password only", async () => {
    const clock = { t: Date.UTC(2026, 9, 27, 10) };
    const fake = new FakeDiscord();
    const origin = await fake.listen();
    cleanups.push(() => fake.close());
    const dir = mkdtempSync(join(tmpdir(), "ddn-safecopy-"));
    const I = await instance(dir, fake, origin, clock);
    const pool = fake.addWebhook("1550000000000000301");
    await I.hooks().add(POOL, pool.url, I.transport);

    const key = newAccountKey();
    const dk = await generateDeviceKey();
    const r = await createAccountHttp(I.url, dk, key);
    const api = new HttpApi({ baseUrl: I.url, accountId: r.accountId, deviceId: r.deviceId, key: dk });
    const st = new SafeStore<{ names: string[] }>(api, key, r.accountId);
    let u = await st.create(PW, { names: ["umowa-poufna.pdf"] }, FAST);
    u = await st.update(u, (s) => ({ names: [...s.names, "wyniki-badan.pdf"] }));

    // Not yet: written just now.
    clock.t += 30_000;
    await I.snaps.tick();
    expect(I.snaps.stats.safeCopies).toBe(0);
    clock.t += 31_000; // a quiet minute
    await I.snaps.tick();
    expect(I.snaps.stats.safeCopies).toBe(1);
    const loc = I.snaps.location(r.accountId)!;
    const io = serverBlobIO(I.hooks(), I.sender, r.accountId);
    const p = await readPointer(io, serverSnapshotKey(I.ikey, r.accountId), r.accountId, loc);
    expect(p.safe!.copies.map((c) => c.revision)).toEqual([2]);
    // The instance cannot read the Safe: nothing of it in clear on Discord.
    for (const m of fake.messages.values()) for (const a of m.attachments) expect(Buffer.from(a.data).toString("latin1")).not.toMatch(/umowa|wyniki/);
    // The channel holding the copy is critical (move only).
    const db = I.srv.db;
    expect((db.prepare("SELECT kind FROM s_snap_objs WHERE account_id = ? AND kind = 'safe'").all(r.accountId) as unknown[]).length).toBe(1);

    // Disaster: the database is gone. Instance key + webhooks + snapshots.json give the Safe back.
    const got = await rebuildAccountSafe(I.ikey, I.hooks(), I.sender, r.accountId, loc);
    expect(got!.slot.revision).toBe(2);
    db.prepare("DELETE FROM slots WHERE account_id = ?").run(r.accountId);
    db.prepare("DELETE FROM slot_history WHERE account_id = ?").run(r.accountId);
    expect(I.srv.restoreSlot(r.accountId, "safe", got!.slot, got!.history)).toBe(true);
    await expect(new SafeStore(api, key, r.accountId).unlock("not it 12345")).rejects.toBeInstanceOf(SafeBadPasswordError);
    expect((await new SafeStore<{ names: string[] }>(api, key, r.accountId).unlock(PW)).state.names).toEqual(["umowa-poufna.pdf", "wyniki-badan.pdf"]);
  }, 120_000);

  it("a database restored from an older backup gets the newer Safe back on start; a new password copies at once", async () => {
    const clock = { t: Date.UTC(2026, 9, 27, 10) };
    const fake = new FakeDiscord();
    const origin = await fake.listen();
    cleanups.push(() => fake.close());
    const dir = mkdtempSync(join(tmpdir(), "ddn-safecopy-"));
    let I = await instance(dir, fake, origin, clock);
    const pool = fake.addWebhook("1550000000000000302");
    await I.hooks().add(POOL, pool.url, I.transport);
    const key = newAccountKey();
    const dk = await generateDeviceKey();
    const r = await createAccountHttp(I.url, dk, key);
    let api = new HttpApi({ baseUrl: I.url, accountId: r.accountId, deviceId: r.deviceId, key: dk });
    const st = new SafeStore<{ n: number }>(api, key, r.accountId);
    let u = await st.create(PW, { n: 1 }, FAST);
    clock.t += 61_000;
    await I.snaps.tick();
    // "Backup" of the database at revision 1.
    const old = I.srv.slotOf(r.accountId, "safe")!;
    u = await st.update(u, () => ({ n: 2 }));
    u = await st.changePassword(u, "new password 2026", FAST);
    // A new password: copied at the next tick, no quiet minute.
    await I.snaps.tick();
    const io = serverBlobIO(I.hooks(), I.sender, r.accountId);
    const loc = I.snaps.location(r.accountId)!;
    expect((await readPointer(io, serverSnapshotKey(I.ikey, r.accountId), r.accountId, loc)).safe!.copies.map((c) => c.revision)).toEqual([3]);

    // The instance stops; its database comes back from the old backup (revision 1, old password); it starts again.
    I.srv.db.prepare("UPDATE slots SET revision = ?, blob = ? WHERE account_id = ?").run(old.revision, old.blob, r.accountId);
    I.srv.db.prepare("DELETE FROM slot_history WHERE account_id = ?").run(r.accountId);
    await I.srv.close();
    cleanups.length = 0;
    cleanups.push(() => fake.close());
    I = await instance(dir, fake, origin, clock);
    api = new HttpApi({ baseUrl: I.url, accountId: r.accountId, deviceId: r.deviceId, key: dk });
    await I.snaps.tick();
    expect(I.snaps.stats.safeRestored).toBe(1);
    expect((await new SafeStore<{ n: number }>(api, key, r.accountId).unlock("new password 2026")).state.n).toBe(2);
    expect((await api.slotHistory("safe")).map((h) => h.revision)).toEqual([1]);
  }, 120_000);
});
