// Optional password-protected account key: off by default,
// wrong password, attempt limits (per account, per IP), change password, turn off, sign in on a
// new device (rescue-key registration), server never holds the password or the account key.
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HttpApi,
  generateDeviceKey,
  passwordStrength,
  protectAccountKey,
  signInWithPassword,
  PASSWORD_ARGON2,
} from "../src/index.js";
import { closeServers, newAccount, startServer } from "./http-helpers.js";

afterEach(closeServers);
// Fast parameters for most cases (the real ones are checked once below).
const FAST = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const PW = "correct horse battery staple";

async function enable(url: string, pw = PW, login = "Ola.Testowa") {
  const a = await newAccount(url);
  const up = await protectAccountKey(a.key, a.accountId, login, pw, FAST);
  await a.api.setPasswordKey(up);
  return a;
}

describe("password-protected account key", () => {
  it("off by default; on: a new device signs in with login + password and gets the same account key; the server stores no password and no account key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ddn-pw-"));
    const { srv, url } = await startServer({ dbPath: join(dir, "ddn.db"), rateLimits: false });
    const a = await newAccount(url);
    expect(await a.api.passwordKeyStatus()).toEqual({ enabled: false, login: null, updatedAt: null });
    const up = await protectAccountKey(a.key, a.accountId, "Ola.Testowa", PW, FAST);
    expect(up.login).toBe("ola.testowa");
    const st = await a.api.setPasswordKey(up);
    expect(st).toMatchObject({ enabled: true, login: "ola.testowa" });
    const dk = await generateDeviceKey();
    const r = await signInWithPassword(url, "OLA.testowa", PW, dk);
    expect(r.accountId).toBe(a.accountId);
    expect(r.key.rawB64).toBe(a.key.rawB64);
    // The new device is a real device of the account: it can sign in and list devices.
    const api = new HttpApi({ baseUrl: url, accountId: r.accountId, deviceId: r.deviceId, key: dk, instanceId: r.instanceId });
    expect((await api.listDevices()).map((d) => d.addedBy)).toContain("rescue");
    srv.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const raw = readFileSync(join(dir, "ddn.db")).toString("latin1");
    expect(raw).not.toContain(PW);
    expect(raw).not.toContain(a.key.rawB64);
    expect(raw).not.toContain(up.proof); // only SHA-256(proof)
  });

  it("wrong password: 401, no key; unknown login: fake but stable parameters, same 401", async () => {
    const { url } = await startServer({ rateLimits: false });
    await enable(url);
    await expect(signInWithPassword(url, "ola.testowa", "wrong password!!", await generateDeviceKey())).rejects.toMatchObject({ status: 401, code: "bad_password" });
    const p1 = await (await fetch(`${url}/v1/auth/password/params`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "nobody.here" }) })).json();
    const p2 = await (await fetch(`${url}/v1/auth/password/params`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "nobody.here" }) })).json();
    expect(p1).toEqual(p2);
    expect(p1.kdf).toMatchObject({ alg: "argon2id", memoryKiB: PASSWORD_ARGON2.memoryKiB });
    const real = await (await fetch(`${url}/v1/auth/password/params`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "ola.testowa" }) })).json();
    expect(Object.keys(real.kdf).sort()).toEqual(Object.keys(p1.kdf).sort());
    const k = await fetch(`${url}/v1/auth/password/key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "nobody.here", proof: "AAAA" }) });
    expect(k.status).toBe(401);
  });

  it("attempt limit per account: 5 failures in 15 min -> 429 even with the right password; a later success clears it", async () => {
    let now = Date.UTC(2026, 9, 13, 10);
    const { url } = await startServer({ rateLimits: false, now: () => now });
    await enable(url);
    const dk = await generateDeviceKey();
    for (let i = 0; i < 5; i++) await expect(signInWithPassword(url, "ola.testowa", `bad guess ${i}xxxx`, dk)).rejects.toMatchObject({ status: 401 });
    await expect(signInWithPassword(url, "ola.testowa", PW, dk)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    now += 15 * 60_000 + 1;
    const r = await signInWithPassword(url, "ola.testowa", PW, dk);
    expect(r.accountId).toMatch(/^acct-/);
  });

  it("attempt limit per IP: the password bucket answers 429 with retry-after", async () => {
    const { url } = await startServer({ rateLimits: { password: { burst: 3, perMin: 1 } } });
    let last = 0;
    for (let i = 0; i < 4; i++) last = (await fetch(`${url}/v1/auth/password/params`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "x.y.z" }) })).status;
    expect(last).toBe(429);
  });

  it("change password: the old one stops working, the new one opens the same key; turning it off deletes the sealed key", async () => {
    const { url } = await startServer({ rateLimits: false });
    const a = await enable(url);
    await a.api.setPasswordKey(await protectAccountKey(a.key, a.accountId, "ola.testowa", "a new long passphrase 2026", FAST));
    await expect(signInWithPassword(url, "ola.testowa", PW, await generateDeviceKey())).rejects.toMatchObject({ status: 401 });
    expect((await signInWithPassword(url, "ola.testowa", "a new long passphrase 2026", await generateDeviceKey())).key.rawB64).toBe(a.key.rawB64);
    await a.api.removePasswordKey();
    expect((await a.api.passwordKeyStatus()).enabled).toBe(false);
    await expect(signInWithPassword(url, "ola.testowa", "a new long passphrase 2026", await generateDeviceKey())).rejects.toMatchObject({ status: 401 });
  });

  it("login names are unique per instance; too-short passwords are refused on the client", async () => {
    const { url } = await startServer({ rateLimits: false });
    await enable(url);
    const b = await newAccount(url);
    await expect(b.api.setPasswordKey(await protectAccountKey(b.key, b.accountId, "OLA.TESTOWA", PW, FAST))).rejects.toMatchObject({ status: 409, code: "login_taken" });
    await expect(protectAccountKey(b.key, b.accountId, "bob", "short", FAST)).rejects.toThrow(/password_too_short/);
  });

  it("discordrive's Argon2id parameters (64 MiB, 3 passes, 4 lanes) by default; strength estimate", async () => {
    const { url } = await startServer({ rateLimits: false });
    const a = await newAccount(url);
    const t0 = Date.now();
    const up = await protectAccountKey(a.key, a.accountId, "real.params", PW);
    const ms = Date.now() - t0;
    expect(up.kdf).toMatchObject({ alg: "argon2id", memoryKiB: 65536, iterations: 3, parallelism: 4 });
    await a.api.setPasswordKey(up);
    expect((await signInWithPassword(url, "real.params", PW, await generateDeviceKey())).key.rawB64).toBe(a.key.rawB64);
    console.log(JSON.stringify({ argon2idMs: ms }));
    expect(passwordStrength("password12").score).toBe(0);
    expect(passwordStrength("aaaaaaaaaaaaaaaa").score).toBe(0);
    expect(passwordStrength(PW).score).toBeGreaterThanOrEqual(2);
    expect(passwordStrength("Tr0ub4dor&3-horse-Battery").score).toBe(3);
  });
});
