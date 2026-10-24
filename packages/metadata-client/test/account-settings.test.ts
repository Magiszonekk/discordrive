// Account settings shared by the devices (every mode): sealed with the account key on the instance,
// compare-and-swap on the revision, other fields kept, a rollback refused, other accounts cannot read it.
import { afterEach, describe, expect, it } from "vitest";
import { AccountSettingsStore, SettingsRollbackError } from "../src/index.js";
import { addDevice, closeServers, newAccount, startServer } from "./http-helpers.js";

afterEach(closeServers);

describe("account settings", () => {
  it("one device stores the AI settings, another reads them; concurrent edits keep both; opaque on the server", async () => {
    const { srv, url } = await startServer({ mode: "e2ee" } as never);
    const a = await newAccount(url);
    const b = await addDevice(url, a);
    const sa = new AccountSettingsStore(a.api, a.key, a.accountId);
    const sb = new AccountSettingsStore(b.api, a.key, a.accountId);
    expect((await sb.load()).ai).toBeUndefined();
    await sa.update((s) => ({ ...s, ai: { url: "http://localhost:8080/v1", key: "sekret", model: "vision-1" } }));
    expect((await sb.load()).ai).toEqual({ url: "http://localhost:8080/v1", key: "sekret", model: "vision-1" });
    // B edits from its stale copy after A wrote again: the compare-and-swap re-reads, both fields stay.
    await sa.update((s) => ({ ...s, other: 1 }));
    await sb.update((s) => ({ ...s, ai: { ...s.ai!, model: "vision-2" } }));
    const now = await sa.load();
    expect(now.ai!.model).toBe("vision-2");
    expect(now.other).toBe(1);
    // The instance stores ciphertext only.
    const row = (srv as unknown as { db: { prepare(q: string): { get(...a: unknown[]): { blob: string } } } }).db.prepare("SELECT blob FROM settings WHERE account_id = ?").get(a.accountId);
    expect(Buffer.from(row.blob, "base64").toString("latin1")).not.toContain("sekret");
  });

  it("an older revision from the server is refused; another account sees nothing", async () => {
    const { url } = await startServer();
    const a = await newAccount(url);
    const s = new AccountSettingsStore(a.api, a.key, a.accountId);
    await s.update((x) => ({ ...x, ai: { url: "u", key: "k", model: "m" } }));
    const stale = new AccountSettingsStore(a.api, a.key, a.accountId, s.seenRevision + 3);
    await expect(stale.load()).rejects.toBeInstanceOf(SettingsRollbackError);
    const other = await newAccount(url);
    expect((await new AccountSettingsStore(other.api, other.key, other.accountId).load()).ai).toBeUndefined();
  });
});
