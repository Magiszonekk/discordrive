// Instance administration over HTTP: who may call /v1/admin (the flag is checked on every call),
// re-authentication of destructive actions, blocking (sign-in refused, open sockets closed,
// long-polls released), deletion of an account's server data, invite codes, the live sign-up
// policy, the last-admin rule and the administrative log.
import { afterEach, describe, expect, it } from "vitest";
import { authMessage, createAccountHttp, generateDeviceKey, getChallenge, newAccountKey } from "../src/index.js";
import { OPERATOR } from "../src/node/index.js";
import { closeServers, newAccount, startServer, type TestAccount } from "./http-helpers.js";

afterEach(closeServers);

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function raw(url: string, a: TestAccount, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(url + path, {
    method,
    headers: { authorization: "Bearer " + (await a.api.session()), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("admin API", () => {
  it("regular account: 403 on every /v1/admin route; /v1/account says admin false", async () => {
    const { url } = await startServer({ adminSweepMs: 0 });
    const user = await newAccount(url);
    expect((await raw(url, user, "GET", "/v1/account")).body).toMatchObject({ accountId: user.accountId, admin: false });
    for (const [m, p, b] of [
      ["GET", "/v1/admin/accounts"],
      ["GET", `/v1/admin/accounts/${user.accountId}`],
      ["POST", `/v1/admin/accounts/${user.accountId}/block`, {}],
      ["POST", `/v1/admin/accounts/${user.accountId}/unblock`, {}],
      ["POST", `/v1/admin/accounts/${user.accountId}/admin`, { on: true }],
      ["DELETE", `/v1/admin/accounts/${user.accountId}`, {}],
      ["GET", "/v1/admin/invites"],
      ["POST", "/v1/admin/invites", { days: 1 }],
      ["POST", "/v1/admin/invites/revoke", { ref: "abcd" }],
      ["GET", "/v1/admin/instance"],
      ["PUT", "/v1/admin/signup", { policy: "open" }],
      ["GET", "/v1/admin/log"],
      ["GET", "/v1/admin/doctor"],
    ] as [string, string, unknown?][]) {
      const r = await raw(url, user, m, p, b);
      expect([m, p, r.status, r.body.error]).toEqual([m, p, 403, "not_admin"]);
    }
    // No session at all: 401.
    expect((await fetch(url + "/v1/admin/accounts")).status).toBe(401);
  });

  it("admin: lists accounts (no names), blocks/unblocks, invites; a blocked admin loses access at once", async () => {
    const { srv, url } = await startServer({ adminSweepMs: 0 });
    const admin = await newAccount(url);
    const other = await newAccount(url);
    srv.admin.setAdmin(admin.accountId, true, OPERATOR);
    expect((await raw(url, admin, "GET", "/v1/account")).body.admin).toBe(true);
    const list = (await raw(url, admin, "GET", "/v1/admin/accounts")).body.accounts as { accountId: string; devices: number; admin: boolean; state: string }[];
    expect(list.map((x) => [x.accountId, x.devices, x.admin, x.state])).toEqual([
      [admin.accountId, 1, true, "active"],
      [other.accountId, 1, false, "active"],
    ]);
    // Block the other account: its token stops working, sign-in is refused with account_blocked.
    const tok = await other.api.session();
    expect((await raw(url, admin, "POST", `/v1/admin/accounts/${other.accountId}/block`, { reason: "spam" })).status).toBe(200);
    expect((await fetch(url + "/v1/log", { headers: { authorization: "Bearer " + tok } })).status).toBe(401);
    await expect(other.api.session(true)).rejects.toThrow(/403 account_blocked/);
    expect((await raw(url, admin, "GET", `/v1/admin/accounts/${other.accountId}`)).body.account).toMatchObject({ state: "blocked", blockedReason: "spam" });
    // Admin cannot block itself, nor the last admin.
    expect((await raw(url, admin, "POST", `/v1/admin/accounts/${admin.accountId}/block`, {})).body.error).toBe("self_target");
    expect((await raw(url, admin, "POST", `/v1/admin/accounts/${other.accountId}/unblock`, {})).status).toBe(200);
    await other.api.session(true);
    // Invite: created (code shown once), listed by ID, revoked; a revoked code cannot be claimed.
    const inv = (await raw(url, admin, "POST", "/v1/admin/invites", { days: 2, note: "for Ann" })).body as { code: string; id: string };
    expect(inv.code).toMatch(/^ddn-inv-/);
    const invites = (await raw(url, admin, "GET", "/v1/admin/invites")).body.invites as { id: string; note: string; state: string; createdBy: string }[];
    expect(invites).toEqual([expect.objectContaining({ id: inv.id, note: "for Ann", state: "active", createdBy: admin.accountId })]);
    expect(JSON.stringify(invites)).not.toContain(inv.code.slice(8));
    expect((await raw(url, admin, "POST", "/v1/admin/invites/revoke", { ref: inv.id.slice(0, 6) })).body.invite).toMatchObject({ state: "revoked" });
    srv.admin.setSignup("invite", null);
    await expect(createAccountHttp(url, await generateDeviceKey(), newAccountKey(), undefined, inv.code)).rejects.toThrow(/invite_required/);
    // A blocked admin: the flag alone does not open the panel.
    srv.admin.block(admin.accountId, "", OPERATOR);
    await expect(admin.api.session(true)).rejects.toThrow(/account_blocked/);
    // The log has every step with its actor.
    const log = srv.admin.logList().map((e) => `${e.actor === OPERATOR ? "op" : e.actor === admin.accountId ? "admin" : "?"} ${e.action}`);
    expect(log.reverse()).toEqual(["op account.admin_on", "admin account.block", "admin account.unblock", "admin invite.create", "admin invite.revoke", "op account.block"]);
  });

  it("destructive actions need a fresh signature of the device: session token alone is refused", async () => {
    const { srv, url } = await startServer({ adminSweepMs: 0 });
    const admin = await newAccount(url);
    const victim = await newAccount(url);
    srv.admin.setAdmin(admin.accountId, true, OPERATOR);
    // Session only (no challenge/signature): 400.
    expect((await raw(url, admin, "DELETE", `/v1/admin/accounts/${victim.accountId}`, {})).status).toBe(400);
    expect((await raw(url, admin, "POST", `/v1/admin/accounts/${victim.accountId}/admin`, { on: true })).status).toBe(400);
    // A signature over ANOTHER action/target does not count (stolen signature replay).
    const c = await getChallenge(url);
    const wrong = await admin.device.sign(authMessage.adminAction(c, admin.accountId, admin.deviceId, "admin-on", victim.accountId));
    const r = await raw(url, admin, "DELETE", `/v1/admin/accounts/${victim.accountId}`, { challengeId: c.challengeId, signature: wrong });
    expect([r.status, r.body.error]).toEqual([401, "bad_signature"]);
    // A different key (someone with the token but not the device key) cannot sign it either.
    const c2 = await getChallenge(url);
    const thief = await generateDeviceKey();
    const r2 = await raw(url, admin, "DELETE", `/v1/admin/accounts/${victim.accountId}`, { challengeId: c2.challengeId, signature: await thief.sign(authMessage.adminAction(c2, admin.accountId, admin.deviceId, "delete-account", victim.accountId)) });
    expect(r2.status).toBe(401);
    expect(srv.admin.exists(victim.accountId)).toBe(true);
    // The real device: works.
    await admin.api.adminSigned("POST", `/v1/admin/accounts/${victim.accountId}/admin`, "admin-on", victim.accountId, { on: true });
    expect(srv.admin.isAdmin(victim.accountId)).toBe(true);
    await admin.api.adminSigned("POST", `/v1/admin/accounts/${victim.accountId}/admin`, "admin-off", victim.accountId, { on: false });
    const d = await admin.api.adminSigned<{ deletion: { state: string } }>("DELETE", `/v1/admin/accounts/${victim.accountId}`, "delete-account", victim.accountId);
    expect(d.deletion.state).toBe("done"); // metadata only: nothing on Discord to delete
    expect(srv.admin.exists(victim.accountId)).toBe(false);
  });

  it("last admin: cannot take the flag from itself in the panel; the operator (CLI) can", async () => {
    const { srv, url } = await startServer({ adminSweepMs: 0 });
    const admin = await newAccount(url);
    srv.admin.setAdmin(admin.accountId, true, OPERATOR);
    await expect(admin.api.adminSigned("POST", `/v1/admin/accounts/${admin.accountId}/admin`, "admin-off", admin.accountId, { on: false })).rejects.toThrow(/409 last_admin/);
    expect(srv.admin.isAdmin(admin.accountId)).toBe(true);
    // With a second admin it works (also on itself).
    const two = await newAccount(url);
    srv.admin.setAdmin(two.accountId, true, OPERATOR);
    await admin.api.adminSigned("POST", `/v1/admin/accounts/${admin.accountId}/admin`, "admin-off", admin.accountId, { on: false });
    expect(srv.admin.isAdmin(admin.accountId)).toBe(false);
    expect((await raw(url, admin, "GET", "/v1/admin/accounts")).status).toBe(403);
    // Operator: may remove the last one.
    srv.admin.setAdmin(two.accountId, false, OPERATOR);
    expect(srv.admin.adminCount()).toBe(0);
  });

  it("blocking closes the account's notification socket and wakes its long-poll; other accounts keep theirs", async () => {
    const { srv, url } = await startServer({ adminSweepMs: 50 });
    const a = await newAccount(url);
    const b = await newAccount(url);
    const lostA: string[] = [];
    const subA = a.api.subscribe(() => {}, { onAuthLost: (c) => lostA.push(c), maxBackoffMs: 100 });
    const subB = b.api.subscribe(() => {});
    try {
      await until(() => subA.connected && subB.connected);
      const poll = a.api.waitFor(0, 25).then(
        () => "returned",
        (e: unknown) => String(e),
      );
      const t0 = Date.now();
      srv.admin.block(a.accountId, "", OPERATOR);
      srv.adminSweep(true);
      await until(() => !subA.connected, 3000);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(await poll).toBeTruthy();
      await until(() => lostA.length > 0, 5000);
      expect(lostA[0]).toBe("account_blocked");
      expect(subB.connected).toBe(true);
      expect(srv.notify.count(a.accountId)).toBe(0);
    } finally {
      subA.close();
      subB.close();
    }
  });

  it("blocked account: no pairing, no rescue device, no password key, share links stop; data stays", async () => {
    const { srv, url } = await startServer({ adminSweepMs: 0 });
    const a = await newAccount(url);
    await a.api.put(a.accountId, 0, { revision: 1, blob: new Uint8Array([1, 2, 3]) });
    srv.admin.block(a.accountId, "", OPERATOR);
    await expect(a.api.addDevice((await generateDeviceKey()).publicKey)).rejects.toThrow(/account_blocked|unauthorized/);
    const { rescueKey } = await import("../src/device-key.js");
    const rk = await rescueKey(a.key);
    const c = await getChallenge(url);
    const nk = await generateDeviceKey();
    const r = await fetch(url + "/v1/auth/rescue-device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: c.challengeId, accountId: a.accountId, devicePublicKey: nk.publicKey, signature: await rk.sign(authMessage.rescueAddDevice(c, a.accountId, nk.publicKey)) }),
    });
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([403, "account_blocked"]);
    // Data still there: unblock and read the vault.
    srv.admin.unblock(a.accountId, OPERATOR);
    expect((await a.api.get())?.revision).toBe(1);
  });

  it("deleting an account removes its rows everywhere and frees nothing of other accounts", async () => {
    const { srv, url } = await startServer({ adminSweepMs: 0 });
    const a = await newAccount(url);
    const b = await newAccount(url);
    for (const x of [a, b]) await x.api.put(x.accountId, 0, { revision: 1, blob: new Uint8Array([7]) });
    srv.admin.deleteAccount(a.accountId, OPERATOR);
    const count = (table: string, col = "account_id", id = a.accountId) => Number((srv.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`).get(id) as { n: number }).n);
    for (const t of ["log", "vault", "sessions", "devices", "shares", "password_keys"]) expect([t, count(t)]).toEqual([t, 0]);
    expect(count("accounts", "id")).toBe(0);
    expect(count("vault", "account_id", b.accountId)).toBe(1);
    await expect(a.api.session(true)).rejects.toThrow(/401 bad_signature/);
    expect((await b.api.get())?.revision).toBe(1);
    expect(srv.admin.logList()[0]).toMatchObject({ actor: OPERATOR, action: "account.delete", target: a.accountId });
  });

  it("sign-up policy is live (no restart) and the first account can be made admin by setup", async () => {
    const { srv, url } = await startServer({ adminSweepMs: 0, signup: "open" });
    srv.admin.setFirstAccountAdmin(true);
    const first = await newAccount(url);
    expect(srv.admin.isAdmin(first.accountId)).toBe(true);
    const second = await newAccount(url);
    expect(srv.admin.isAdmin(second.accountId)).toBe(false);
    srv.admin.setSignup("closed", OPERATOR);
    await expect(newAccount(url)).rejects.toThrow(/signup_closed/);
    expect(((await (await fetch(url + "/v1/health")).json()) as { signup: string }).signup).toBe("closed");
    await first.api.json("PUT", "/v1/admin/signup", { policy: "open" });
    await newAccount(url);
  });
});
