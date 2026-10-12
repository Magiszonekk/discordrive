import { describe, expect, it } from "vitest";
import {
  MemoryTransport,
  MemoryVaultStore,
  UnsealError,
  VaultRollbackError,
  WebhookVault,
  inspectForVault,
  newAccountKey,
  openVault,
  sealVault,
  toWebhookRefs,
  vaultAdvice,
  emptyVault,
  type VaultWebhook,
} from "../src/index.js";

const SECRET = "S".repeat(68);
const hook = (id: string, channelId: string, t = 1): VaultWebhook => ({
  id,
  url: `https://discord.com/api/webhooks/${id}/${SECRET}`,
  channelId,
  guildId: "g1",
  label: `h${id}`,
  addedAt: t,
});

describe("webhook vault (koncept §3.2)", () => {
  it("server stores only ciphertext; another device with the key reads it", async () => {
    const key = newAccountKey();
    const store = new MemoryVaultStore();
    const a = new WebhookVault(store, key, "acct-1");
    await a.addWebhook(hook("100000000000000001", "c1"));
    await a.addWebhook(hook("100000000000000002", "c2", 2));
    const raw = store.data.get("acct-1")!;
    expect(raw.revision).toBe(2);
    const text = new TextDecoder("latin1").decode(raw.blob);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("100000000000000001");
    expect(text).not.toContain("discord");

    const b = new WebhookVault(store, key, "acct-1");
    const v = await b.load();
    expect(v.webhooks.map((w) => w.id)).toEqual(["100000000000000001", "100000000000000002"]);
    expect(toWebhookRefs(v)[0]).toEqual({ id: "100000000000000001", url: hook("100000000000000001", "c1").url, channelId: "c1" });
  });

  it("wrong key, another account's blob, or a relabelled revision do not open", async () => {
    const key = newAccountKey();
    const s1 = await sealVault(key, "acct-1", 3, emptyVault());
    await expect(openVault(newAccountKey(), "acct-1", s1)).rejects.toBeInstanceOf(UnsealError);
    await expect(openVault(key, "acct-2", s1)).rejects.toBeInstanceOf(UnsealError);
    await expect(openVault(key, "acct-1", { ...s1, revision: 4 })).rejects.toBeInstanceOf(UnsealError);
    const flipped = new Uint8Array(s1.blob);
    flipped[flipped.length - 1]! ^= 1;
    await expect(openVault(key, "acct-1", { revision: 3, blob: flipped })).rejects.toBeInstanceOf(UnsealError);
    expect((await openVault(key, "acct-1", s1)).webhooks).toEqual([]);
  });

  it("refuses a rollback to an older revision", async () => {
    const key = newAccountKey();
    const store = new MemoryVaultStore();
    const a = new WebhookVault(store, key, "acct-1");
    await a.addWebhook(hook("100000000000000001", "c1"));
    const old = store.data.get("acct-1")!;
    await a.removeWebhook("100000000000000001");
    store.data.set("acct-1", old); // malicious server replays revision 1
    const b = new WebhookVault(store, key, "acct-1", a.revision);
    await expect(b.load()).rejects.toBeInstanceOf(VaultRollbackError);
  });

  it("concurrent edits from two devices both survive (CAS + re-apply)", async () => {
    const key = newAccountKey();
    const store = new MemoryVaultStore();
    const a = new WebhookVault(store, key, "acct-1");
    const b = new WebhookVault(store, key, "acct-1");
    await a.load();
    await b.load();
    await a.addWebhook(hook("100000000000000001", "c1"));
    await b.addWebhook(hook("100000000000000002", "c2", 2)); // stale revision -> conflict -> retry
    const v = await new WebhookVault(store, key, "acct-1").load();
    expect(v.webhooks.map((w) => w.id).sort()).toEqual(["100000000000000001", "100000000000000002"]);
    expect(store.data.get("acct-1")!.revision).toBe(2);
  });

  it("wizard advice follows decision #12 (1 channel required, 3–4 encouraged)", () => {
    const v = emptyVault();
    expect(vaultAdvice(v)).toMatchObject({ ok: false, channels: 0 });
    v.webhooks.push(hook("1", "c1"));
    expect(vaultAdvice(v)).toMatchObject({ ok: true, suggestMore: true, channels: 1 });
    v.webhooks.push(hook("2", "c1"));
    const shared = vaultAdvice(v);
    expect(shared).toMatchObject({ channels: 1, sharedChannels: ["c1"] });
    expect(shared.message).toMatch(/separate channels/);
    v.webhooks.push(hook("3", "c2"), hook("4", "c3"));
    expect(vaultAdvice(v)).toMatchObject({ ok: true, suggestMore: false, channels: 3 });
  });

  it("inspectForVault validates the URL against Discord and never echoes it", async () => {
    const t = new MemoryTransport((id) => `chan-of-${id}`);
    const url = `https://discord.com/api/webhooks/123456789012345678/${SECRET}`;
    const w = await inspectForVault(t, url, () => 5);
    expect(w).toMatchObject({ id: "123456789012345678", channelId: "chan-of-123456789012345678", addedAt: 5 });
    t.deadHooks.add("123456789012345678");
    const err = await inspectForVault(t, url).catch((e: Error) => e);
    expect(String(err)).not.toContain(SECRET);
    const err2 = await inspectForVault(t, `https://example.com/${SECRET}`).catch((e: Error) => e);
    expect(String(err2)).not.toContain(SECRET);
  });
});
