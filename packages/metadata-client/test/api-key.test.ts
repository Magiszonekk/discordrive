import { afterEach, describe, expect, it } from "vitest";
import { ApiKeyError, ServerError, WebhookVault, apiKeyHttp, createApiKey, decodeApiKey, encodeApiKey, openDeviceInfo, openDeviceName, sealDeviceName } from "../src/index.js";
import { closeServers, newAccount, startServer } from "./http-helpers.js";

afterEach(closeServers);

const sample = {
  server: "http://127.0.0.1:3020",
  instanceId: "inst-AAAAAAAAAAAAAAAAAAAAAA",
  accountId: "acct-BBBBBBBBBBBBBBBBBBBBBB",
  deviceId: "dev-CCCCCCCCCCCCCCCCCCCCCC",
  seed: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  accountKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
};

describe("API key text", () => {
  it("round-trips, ignores white space and line breaks", async () => {
    const t = await encodeApiKey(sample);
    expect(t).toMatch(/^ddn-api1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8}$/);
    expect(await decodeApiKey(t)).toEqual(sample);
    const wrapped = `  ${t.slice(0, 40)}\n${t.slice(40, 90)}\r\n${t.slice(90)}\n`;
    expect(await decodeApiKey(wrapped)).toEqual(sample);
  });

  it("a typo, a cut-off copy or another code is a readable error, never a JSON one", async () => {
    const t = await encodeApiKey(sample);
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    const cases: [string, ApiKeyError["reason"]][] = [
      [flip(t, 20), "damaged"],
      [flip(t, t.length - 2), "damaged"],
      [t.slice(0, t.length - 12), "damaged"],
      [t.slice(0, t.indexOf(".")), "damaged"],
      ["ddn-api1:", "damaged"],
      ["ddn-kit3:eyJ2IjozfQ", "kind"],
      ["ddn-pair1:abc.def", "kind"],
      ["ddn-api2:xyz.abc", "kind"],
      ["hello", "format"],
    ];
    for (const [s, reason] of cases) {
      const e = await decodeApiKey(s).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e, s).toBeInstanceOf(ApiKeyError);
      expect((e as ApiKeyError).reason, s).toBe(reason);
      expect((e as Error).message).not.toMatch(/JSON|Unexpected|token|base64/i);
    }
  });

  it("a whole text with a wrong body (good checksum) is refused as damaged", async () => {
    const { b64u } = await import("../src/device-key.js");
    const head = "ddn-api1:" + b64u(new TextEncoder().encode(JSON.stringify({ v: 1, s: "x", i: "i", a: "a", d: "d", p: "short", k: "short" })));
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(head)));
    await expect(decodeApiKey(`${head}.${b64u(d.subarray(0, 6))}`)).rejects.toMatchObject({ reason: "damaged" });
  });
});

describe("API key = a device of the account", () => {
  it("signs in, reads the account's data, is listed as an API key with its last use; revoked → refused", async () => {
    let now = Date.UTC(2026, 10, 18, 12);
    const { srv, url } = await startServer({ now: () => now });
    const a = await newAccount(url);
    const vault = new WebhookVault(a.api, a.key, a.accountId);
    await vault.update((v) => v);
    expect(vault.revision).toBeGreaterThan(0);
    expect(await a.api.listDevices()).toHaveLength(1);
    const instanceId = (await (await fetch(url + "/v1/auth/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).instanceId as string;

    const made = await createApiKey(a.api, { server: url + "/", instanceId, accountId: a.accountId, key: a.key }, "backup script");
    const k = await decodeApiKey(made.text);
    expect(k).toMatchObject({ server: url, instanceId, accountId: a.accountId, deviceId: made.deviceId, accountKey: a.key.rawB64 });

    // The key's own client: signs in as that device and opens what is sealed with the account key.
    const c = await apiKeyHttp(k);
    const list = await c.http.listDevices();
    expect(list.map((d) => d.deviceId).sort()).toEqual([a.deviceId, made.deviceId].sort());
    const me = list.find((d) => d.deviceId === made.deviceId)!;
    expect(me.addedBy).toBe(a.deviceId);
    expect(me.lastSeenAt).toBe(now);
    expect(await openDeviceInfo(c.key, a.accountId, made.deviceId, me.nameSealed)).toEqual({ name: "backup script", kind: "api" });
    // Older apps read the name only.
    expect(await openDeviceName(a.key, a.accountId, made.deviceId, me.nameSealed)).toBe("backup script");
    // A device sealed without a kind is an ordinary device.
    expect(await openDeviceInfo(a.key, a.accountId, a.deviceId, await sealDeviceName(a.key, a.accountId, a.deviceId, "Laptop"))).toEqual({ name: "Laptop", kind: "device" });
    const v2 = new WebhookVault(c.http, c.key, a.accountId);
    await v2.load();
    expect(v2.revision).toBe(vault.revision);

    // The server stores no secret of the key: only its public half.
    const dump = JSON.stringify(srv.db.prepare("SELECT * FROM devices").all());
    expect(dump).toContain(c.device.publicKey);
    expect(dump).not.toContain(k.seed);
    expect(dump).not.toContain("backup script");

    // Revoked from the creating device: the key's session and any new sign-in are refused.
    now += 5 * 60_000;
    await a.api.revokeDevice(made.deviceId);
    const err = await c.http.listDevices().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServerError);
    expect((err as ServerError).status).toBe(401);
    const fresh = await apiKeyHttp(k);
    await expect(fresh.http.listDevices()).rejects.toMatchObject({ status: 401 });
    expect((await a.api.listDevices()).map((d) => d.deviceId)).toEqual([a.deviceId]);
  });

  it("refuses a key of another server instance", async () => {
    const one = await startServer();
    const two = await startServer();
    const a = await newAccount(one.url);
    const instanceId = (await (await fetch(one.url + "/v1/auth/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).instanceId as string;
    const made = await createApiKey(a.api, { server: one.url, instanceId, accountId: a.accountId, key: a.key }, "k");
    const k = { ...(await decodeApiKey(made.text)), server: two.url };
    await expect((await apiKeyHttp(k)).http.listDevices()).rejects.toThrow(/another server instance/);
  });
});
