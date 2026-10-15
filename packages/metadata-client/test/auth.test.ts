import { afterEach, describe, expect, it } from "vitest";
import {
  HttpApi,
  ServerError,
  WebhookVault,
  authMessage,
  createAccountHttp,
  generateDeviceKey,
  getChallenge,
  importDeviceKey,
  exportDeviceKey,
  newAccountKey,
  rescueKey,
  rescueRegisterDevice,
  accountKeyFromB64,
  verifySignature,
} from "../src/index.js";
import { addDevice, closeServers, newAccount, startServer } from "./http-helpers.js";

afterEach(closeServers);

async function raw(url: string, path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const r = await fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

describe("device sign-in with Ed25519 (decision #13)", () => {
  it("sign-in by signed challenge gives a session; the server stores only public keys", async () => {
    const { srv, url } = await startServer();
    const acct = await newAccount(url);
    expect(await acct.api.read(0)).toEqual([]);
    expect(acct.api.logins).toBe(1);
    await acct.api.read(0);
    expect(acct.api.logins).toBe(1); // session reused
    const dump = JSON.stringify(srv.db.prepare("SELECT * FROM devices").all()) + JSON.stringify(srv.db.prepare("SELECT * FROM accounts").all());
    expect(dump).toContain(acct.device.publicKey);
    const exported = await exportDeviceKey({ ...(await generateDeviceKey(true)) });
    expect(exported.pkcs8.length).toBeGreaterThan(40);
    // nothing secret: no session token in clear, no account key
    expect(dump).not.toContain(acct.key.rawB64);
    expect(JSON.stringify(srv.db.prepare("SELECT * FROM sessions").all())).not.toMatch(/dds_/);
  });

  it("rejects a bad signature, a replayed challenge, an expired challenge, another instance's challenge", async () => {
    let now = Date.UTC(2026, 9, 6, 12);
    const { url } = await startServer({ now: () => now });
    const acct = await newAccount(url);
    const login = async (c: Awaited<ReturnType<typeof getChallenge>>, signer = acct.device) =>
      raw(url, "/v1/auth/login", { challengeId: c.challengeId, accountId: acct.accountId, deviceId: acct.deviceId, signature: await signer.sign(authMessage.login(c, acct.accountId, acct.deviceId)) });

    // wrong key
    const intruder = await generateDeviceKey();
    expect(await login(await getChallenge(url), intruder)).toMatchObject({ status: 401, body: { error: "bad_signature" } });
    // signature over a different message (another account ID)
    const c1 = await getChallenge(url);
    const forged = await raw(url, "/v1/auth/login", { challengeId: c1.challengeId, accountId: acct.accountId, deviceId: acct.deviceId, signature: await acct.device.sign(authMessage.login(c1, "acct-other0000000000000000", acct.deviceId)) });
    expect(forged).toMatchObject({ status: 401, body: { error: "bad_signature" } });
    // good login, then replay of the same challenge + signature
    const c2 = await getChallenge(url);
    const ok = await login(c2);
    expect(ok.status).toBe(200);
    expect(await login(c2)).toMatchObject({ status: 401, body: { error: "challenge_unknown" } });
    // a failed attempt burns the challenge too
    const c3 = await getChallenge(url);
    await login(c3, intruder);
    expect(await login(c3)).toMatchObject({ status: 401, body: { error: "challenge_unknown" } });
    // expired challenge
    const c4 = await getChallenge(url);
    now += 3 * 60_000;
    expect(await login(c4)).toMatchObject({ status: 401, body: { error: "challenge_expired" } });
    // a challenge signed for another instance does not verify here
    const c5 = await getChallenge(url);
    const other = { ...c5, instanceId: "inst-elsewhere000000000000" };
    const r = await raw(url, "/v1/auth/login", { challengeId: c5.challengeId, accountId: acct.accountId, deviceId: acct.deviceId, signature: await acct.device.sign(authMessage.login(other, acct.accountId, acct.deviceId)) });
    expect(r).toMatchObject({ status: 401, body: { error: "bad_signature" } });
    // client side: refuses a challenge from an unexpected instance
    await expect(getChallenge(url, undefined, "inst-pinned00000000000000000")).rejects.toThrow(/another server instance/);
  });

  it("an expired session is refused; HttpApi signs in again by itself", async () => {
    let now = Date.UTC(2026, 9, 6, 12);
    const { url } = await startServer({ now: () => now, sessionTtlMs: 60_000 });
    const acct = await newAccount(url);
    await acct.api.read(0);
    const token = await acct.api.session();
    now += 61_000;
    const r = await fetch(url + "/v1/log?after=0", { headers: { authorization: "Bearer " + token } });
    expect(r.status).toBe(401);
    // HttpApi's local clock is real time, so it still believes the token is valid: it gets a 401 and re-signs once.
    expect(await acct.api.read(0)).toEqual([]);
    expect(acct.api.logins).toBe(2);
    expect(await acct.api.session()).not.toBe(token);
  });

  it("pairing adds a key only with a signature of a signed-in device of the same account", async () => {
    const { url } = await startServer();
    const a = await newAccount(url);
    const other = await newAccount(url);
    const b = await addDevice(url, a);
    expect(await b.api.read(0)).toEqual([]);
    // signature by a device of ANOTHER account, sent with A's session: rejected
    const c = await getChallenge(url);
    const newKey = await generateDeviceKey();
    const r = await raw(url, "/v1/devices", { challengeId: c.challengeId, devicePublicKey: newKey.publicKey, signature: await other.device.sign(authMessage.addDevice(c, a.accountId, newKey.publicKey)) }, await a.api.session());
    expect(r).toMatchObject({ status: 401, body: { error: "bad_signature" } });
    // without a session at all
    const c2 = await getChallenge(url);
    expect((await raw(url, "/v1/devices", { challengeId: c2.challengeId, devicePublicKey: newKey.publicKey, signature: await a.device.sign(authMessage.addDevice(c2, a.accountId, newKey.publicKey)) })).status).toBe(401);
    // the same public key cannot be registered twice
    await expect(a.api.addDevice(b.device.publicKey)).rejects.toMatchObject({ status: 409, code: "public_key_in_use" });
    expect((await a.api.listDevices()).length).toBe(2);
  });

  it("revoking deletes the public key: open sessions die and the device cannot sign in again", async () => {
    const { srv, url } = await startServer();
    const a = await newAccount(url);
    const b = await addDevice(url, a);
    const tokenB = await b.api.session();
    await a.api.revokeDevice(b.deviceId);
    expect((await fetch(url + "/v1/log?after=0", { headers: { authorization: "Bearer " + tokenB } })).status).toBe(401);
    await expect(b.api.read(0)).rejects.toMatchObject({ status: 401, code: "bad_signature" });
    expect(JSON.stringify(srv.db.prepare("SELECT * FROM devices").all())).not.toContain(b.device.publicKey);
    expect((await a.api.listDevices()).map((d) => d.deviceId)).toEqual([a.deviceId]);
    // revoking needs a fresh signature, a session alone is not enough
    const c = await getChallenge(url);
    expect((await raw(url, `/v1/devices/${a.deviceId}?action=revoke`, { challengeId: c.challengeId, signature: "A".repeat(86) }, await a.api.session())).status).toBe(401);
    await expect(a.api.revokeDevice(b.deviceId)).rejects.toMatchObject({ status: 404 });
  });

  it("documented limit (docs/threat-model.md §2.4): a revoked device that kept the account key can register again with the rescue key", async () => {
    const { url } = await startServer();
    const a = await newAccount(url);
    const b = await addDevice(url, a);
    await a.api.revokeDevice(b.deviceId);
    await expect(b.api.read(0)).rejects.toMatchObject({ status: 401 });
    // Revocation deletes B's public key, but the account key B held is not rotated: the rescue key
    // derives from it, so B (or whoever copied its storage) can add a fresh device on its own.
    const again = await generateDeviceKey();
    const { deviceId } = await rescueRegisterDevice(url, accountKeyFromB64(a.key.rawB64), a.accountId, again);
    expect((await a.api.listDevices()).map((d) => d.deviceId)).toContain(deviceId);
  });

  it("rescue kit: with only the account key, a new device registers and reads the vault", async () => {
    const { url } = await startServer();
    const a = await newAccount(url);
    await new WebhookVault(a.api, a.key, a.accountId).addWebhook({ id: "777777777777777777", url: "https://discord.com/api/webhooks/777777777777777777/" + "R".repeat(68), channelId: "c", guildId: null, label: "r", addedAt: 1 });
    // every device lost; the kit holds the account key (and account ID)
    const key = accountKeyFromB64(a.key.rawB64);
    expect((await rescueKey(key)).publicKey).toBe((await rescueKey(a.key)).publicKey); // deterministic
    const fresh = await generateDeviceKey();
    const { deviceId } = await rescueRegisterDevice(url, key, a.accountId, fresh);
    const api = new HttpApi({ baseUrl: url, accountId: a.accountId, deviceId, key: fresh });
    expect((await new WebhookVault(api, key, a.accountId).load()).webhooks.map((w) => w.id)).toEqual(["777777777777777777"]);
    // a wrong account key cannot register anything
    await expect(rescueRegisterDevice(url, newAccountKey(), a.accountId, await generateDeviceKey())).rejects.toMatchObject({ status: 401 });
  });

  it("account creation needs both the device key and the rescue key to sign", async () => {
    const { url } = await startServer();
    const device = await generateDeviceKey();
    const key = newAccountKey();
    const rk = await rescueKey(key);
    const c = await getChallenge(url);
    const msg = authMessage.createAccount(c, device.publicKey, rk.publicKey);
    const bad = await raw(url, "/v1/accounts", { challengeId: c.challengeId, devicePublicKey: device.publicKey, rescuePublicKey: rk.publicKey, deviceSignature: await device.sign(msg), rescueSignature: await device.sign(msg) });
    expect(bad).toMatchObject({ status: 401, body: { error: "bad_signature" } });
    const ok = await createAccountHttp(url, device, key);
    expect(ok.accountId).toMatch(/^acct-/);
    await expect(createAccountHttp(url, device, newAccountKey())).rejects.toBeInstanceOf(ServerError); // device key already registered
  });

  it("device keys round-trip through PKCS#8 and verify", async () => {
    const k = await generateDeviceKey(true);
    const back = await importDeviceKey(await exportDeviceKey(k));
    expect(back.publicKey).toBe(k.publicKey);
    expect(await verifySignature(k.publicKey, "m", await back.sign("m"))).toBe(true);
    expect(await verifySignature(k.publicKey, "m2", await back.sign("m"))).toBe(false);
    const other = await generateDeviceKey(true);
    await expect(importDeviceKey({ ...(await exportDeviceKey(k)), publicKey: other.publicKey })).rejects.toThrow(/does not match/);
  });
});
