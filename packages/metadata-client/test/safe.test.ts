// The Safe (crypto + its slot on the instance). Fast Argon2 parameters in tests (the real ones are the
// account password's 64 MiB / 3 / 4); the minimum memory the parameters allow.
import { describe, expect, it, afterEach } from "vitest";
import {
  SafeBadPasswordError,
  SafeDamagedError,
  SafeExistsError,
  SafeRollbackError,
  SafeStore,
  SafeTooLargeError,
  SAFE_PAD_MIN,
  accountKeyFromB64,
  openSafeHeader,
  openSafeMaster,
  padState,
  parseSafeKit,
  safeKitText,
  unpadState,
} from "../src/index.js";
import { addDevice, closeServers, newAccount, startServer } from "./http-helpers.js";

afterEach(closeServers);
const FAST = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
type State = { files: { name: string; thumb: string }[] };
const SECRET_NAMES = ["paszport-skan.jpg", "umowa-poufna.pdf", "wyniki-badan-2026.pdf"];
const state = (): State => ({ files: SECRET_NAMES.map((name, i) => ({ name, thumb: `thumb-key-${i}` })) });

describe("the Safe", () => {
  it("opens with the password on any device; a wrong one fails; the server and the account key see no names or count", async () => {
    const { srv, url } = await startServer();
    const a = await newAccount(url);
    const b = await addDevice(url, a);
    const sa = new SafeStore<State>(a.api, a.key, a.accountId);
    expect(await sa.exists()).toBe(false);
    const u = await sa.create("correct horse battery staple", state(), FAST);
    expect(u.revision).toBe(1);

    // The second device (same account key) knows a Safe exists; it opens it with the password only.
    const sb = new SafeStore<State>(b.api, a.key, a.accountId);
    expect(await sb.exists()).toBe(true);
    await expect(sb.unlock("wrong password here")).rejects.toBeInstanceOf(SafeBadPasswordError);
    expect((await sb.unlock("correct horse battery staple")).state.files.map((f) => f.name)).toEqual(SECRET_NAMES);

    // Everything the account key opens (the header) has no names and no count; the instance's row neither.
    const row = (srv as unknown as { db: { prepare(q: string): { get(...a: unknown[]): { blob: string } } } }).db.prepare("SELECT blob FROM slots WHERE account_id = ? AND name = 'safe'").get(a.accountId);
    const raw = Buffer.from(row.blob, "base64").toString("latin1");
    for (const n of SECRET_NAMES) expect(raw).not.toContain(n);
    const { header, sealedState } = await openSafeHeader(a.key, a.accountId, 1, row.blob);
    expect(JSON.stringify(header)).not.toMatch(/paszport|umowa|wyniki|files/);
    expect(Object.keys(header).sort()).toEqual(["format", "kdf", "sealedMaster", "version"]);
    // The state is padded: its size says only "under 64 KiB".
    expect(sealedState.byteLength).toBe(1 + 12 + SAFE_PAD_MIN + 16);

    // Another account's key cannot open even the header.
    const other = await newAccount(url);
    await expect(openSafeHeader(other.key, a.accountId, 1, row.blob)).rejects.toThrow();
  }, 60_000);

  it("the account's rescue kit (the account key) and a stolen database do not open it; the Safe kit does", async () => {
    const { url } = await startServer();
    const a = await newAccount(url);
    const sa = new SafeStore<State>(a.api, a.key, a.accountId);
    const u = await sa.create("correct horse battery staple", state(), FAST);
    // A new device restored from the account's kit: the same account key, no password.
    const restored = new SafeStore<State>(a.api, accountKeyFromB64(a.key.rawB64), a.accountId);
    await expect(restored.unlock("")).rejects.toBeInstanceOf(SafeBadPasswordError);
    // The optional Safe kit holds the master: it opens without the password.
    const kit = await safeKitText(a.accountId, u.master);
    expect(kit).toMatch(/^ddn-safe1:[^:]+:[A-Za-z0-9_-]{43}:[0-9a-f]{8}$/);
    const parsed = await parseSafeKit(kit);
    expect(parsed.accountId).toBe(a.accountId);
    expect((await restored.unlockWithMaster(parsed.master)).state.files).toHaveLength(3);
    await expect(parseSafeKit("ddn-safe1:x:abc")).rejects.toThrow("not a Safe kit");
    // A typo in the key part: the check says "not a Safe kit" (not "wrong key or tampered data").
    const parts = kit.split(":");
    const typo = [parts[0], parts[1], (parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1), parts[3]].join(":");
    await expect(parseSafeKit(typo)).rejects.toThrow("not a Safe kit");
  }, 60_000);

  it("password change keeps the master; concurrent edits merge; a rollback is refused; one Safe per account", async () => {
    const { url } = await startServer();
    const a = await newAccount(url);
    const b = await addDevice(url, a);
    const sa = new SafeStore<State>(a.api, a.key, a.accountId);
    let ua = await sa.create("first password 123", { files: [] }, FAST);
    await expect(new SafeStore<State>(b.api, a.key, a.accountId).create("another one 12345", { files: [] }, FAST)).rejects.toBeInstanceOf(SafeExistsError);

    const sb = new SafeStore<State>(b.api, a.key, a.accountId);
    let ub = await sb.unlock("first password 123");
    ua = await sa.update(ua, (s) => ({ files: [...s.files, { name: "a.jpg", thumb: "t1" }] }));
    // B edits from its stale copy: the compare-and-swap re-reads and applies its change on top.
    ub = await sb.update(ub, (s) => ({ files: [...s.files, { name: "b.jpg", thumb: "t2" }] }));
    expect(ub.state.files.map((f) => f.name)).toEqual(["a.jpg", "b.jpg"]);

    // A new password: the old one stops working, the master (the files' keys) is the same.
    const before = ub.master;
    ub = await sb.changePassword(ub, "second password 456", FAST);
    await expect(new SafeStore<State>(a.api, a.key, a.accountId).unlock("first password 123")).rejects.toBeInstanceOf(SafeBadPasswordError);
    const again = await new SafeStore<State>(a.api, a.key, a.accountId).unlock("second password 456");
    expect(Buffer.from(again.master).equals(Buffer.from(before))).toBe(true);
    expect(again.state.files).toHaveLength(2);
    // A, still unlocked with the master, keeps writing after the password change (header taken as it is).
    ua = await sa.update(ua, (s) => ({ files: [...s.files, { name: "c.jpg", thumb: "t3" }] }));
    expect((await new SafeStore<State>(b.api, a.key, a.accountId).unlock("second password 456")).state.files.map((f) => f.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);

    // The server shows an older revision: refused.
    const stale = new SafeStore<State>(a.api, a.key, a.accountId, ua.revision + 2);
    await expect(stale.exists()).rejects.toBeInstanceOf(SafeRollbackError);
  }, 120_000);

  it("a part moved between revisions does not open (each is bound to its revision)", async () => {
    const { srv, url } = await startServer();
    const a = await newAccount(url);
    const sa = new SafeStore<State>(a.api, a.key, a.accountId);
    const u = await sa.create("correct horse battery staple", { files: [] }, FAST);
    await sa.update(u, () => state());
    // The instance serves revision 2's blob as revision 3 (it bumps the number): it does not open.
    const db = (srv as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db;
    db.prepare("UPDATE slots SET revision = 3 WHERE account_id = ?").run(a.accountId);
    await expect(new SafeStore<State>(a.api, a.key, a.accountId).unlock("correct horse battery staple")).rejects.toThrow();
  }, 60_000);

  it("overwritten by another device: damaged (not a wrong password); an earlier revision brings it back", async () => {
    const { srv, url } = await startServer();
    const a = await newAccount(url);
    const b = await addDevice(url, a);
    const sa = new SafeStore<State>(a.api, a.key, a.accountId);
    let u = await sa.create("correct horse battery staple", { files: [] }, FAST);
    u = await sa.update(u, () => state());
    // Another device of the account writes junk into the slot (a broken client, or on purpose).
    expect(await b.api.putSlot("safe", u.revision, u.revision + 1, Buffer.from("junk junk junk").toString("base64"))).toBeNull();
    const fresh = new SafeStore<State>(a.api, a.key, a.accountId);
    await expect(fresh.unlock("correct horse battery staple")).rejects.toBeInstanceOf(SafeDamagedError);
    // The instance kept the replaced revisions: the newest good one comes back under a new revision.
    const hist = await fresh.history();
    expect(hist.map((h) => h.revision)).toEqual([2, 1]);
    const back = await fresh.restore(2, { password: "correct horse battery staple" });
    expect(back.revision).toBe(4);
    expect((await new SafeStore<State>(b.api, a.key, a.accountId).unlock("correct horse battery staple")).state.files.map((f) => f.name)).toEqual(SECRET_NAMES);
    // The history is the account's own (another account sees none) and goes with the account's deletion.
    const other = await newAccount(url);
    expect(await other.api.slotHistory("safe")).toEqual([]);
    const db = (srv as unknown as { db: { prepare(q: string): { get(...a: unknown[]): { n: number } } } }).db;
    expect(db.prepare("SELECT count(*) AS n FROM slot_history WHERE account_id = ?").get(a.accountId).n).toBe(3);
  }, 60_000);

  it("after a password change the old password opens the Safe by no way (unlock, history, restore)", async () => {
    const { url } = await startServer();
    const a = await newAccount(url);
    const b = await addDevice(url, a);
    const sa = new SafeStore<State>(a.api, a.key, a.accountId);
    let u = await sa.create("old password leaked", state(), FAST);
    u = await sa.update(u, (s) => ({ files: [...s.files, { name: "x.pdf", thumb: "t" }] }));
    expect((await sa.history()).length).toBe(1);
    u = await sa.changePassword(u, "new password 2026!", FAST);
    u = await sa.update(u, (s) => ({ files: [...s.files, { name: "added-after-change.pdf", thumb: "t2" }] }));
    // The other device of the account knows only the old password.
    const sb = new SafeStore<State>(b.api, a.key, a.accountId);
    await expect(sb.unlock("old password leaked")).rejects.toBeInstanceOf(SafeBadPasswordError);
    // No earlier revision from before the change is left to try the old password on.
    const hist = await sb.history();
    expect(hist.every((h) => h.revision > 2)).toBe(true);
    for (const h of hist) {
      const old = await b.api.slotRevision("safe", h.revision);
      const { header } = await openSafeHeader(a.key, a.accountId, old.revision, old.blob);
      await expect(openSafeMaster(header, "old password leaked", a.accountId)).rejects.toBeInstanceOf(SafeBadPasswordError);
    }
    for (const r of [1, 2]) await expect(b.api.slotRevision("safe", r)).rejects.toThrow();
    for (const h of hist) await expect(sb.restore(h.revision, { password: "old password leaked" })).rejects.toBeInstanceOf(SafeBadPasswordError);
    // The new password works; the history keeps working after the change (revisions under the new password).
    expect((await sb.unlock("new password 2026!")).state.files.map((f) => f.name)).toContain("added-after-change.pdf");
  }, 120_000);

  it("padding: 64 KiB · 2^k buckets, round trip, too large refused", () => {
    expect(padState(new Uint8Array(10)).byteLength).toBe(SAFE_PAD_MIN);
    expect(padState(new Uint8Array(SAFE_PAD_MIN - 4)).byteLength).toBe(SAFE_PAD_MIN);
    expect(padState(new Uint8Array(SAFE_PAD_MIN - 3)).byteLength).toBe(2 * SAFE_PAD_MIN);
    const x = Uint8Array.from({ length: 1000 }, (_, i) => i & 255);
    expect([...unpadState(padState(x))]).toEqual([...x]);
    expect(() => padState(new Uint8Array(1024 * 1024))).toThrow(SafeTooLargeError);
  });
});
