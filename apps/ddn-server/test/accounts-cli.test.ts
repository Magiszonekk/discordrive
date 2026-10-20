// Operator commands: `discordrive accounts | invite | signup`, and `--help` / unknown options on
// every command (help only, nothing done). Deleting an account per mode: metadata only touches
// nothing on Discord; e2ee/plain delete the account's pieces from the instance's channels in the
// background (the running server picks the deletion up from the database).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DriveClient, EncryptedArbiter, HttpApi, OpCodec, createAccountHttp, generateDeviceKey, memorySource, newAccountKey } from "@ddv4/metadata-client";
import { ServerBlobStore } from "@ddv4/metadata-client/server-blobs";
import { FakeDiscord } from "@ddv4/metadata-client/node";
import { accountsCli, inviteCli, signupCli } from "../src/accounts.js";
import { main } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { setCliLang } from "../src/i18n.js";
import { ttyPrompter } from "../src/prompt.js";
import { serve } from "../src/serve.js";
import { setup } from "../src/setup.js";

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-accounts-cli-"));
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}
process.env.XDG_DATA_HOME = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-xdg-"));
process.env.DISCORDRIVE_NO_AUTOSTART = "1";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  setCliLang("en");
  for (const c of cleanups.splice(0).reverse()) await c();
});

const quiet = () => {
  const o = new PassThrough();
  o.resume();
  return ttyPrompter(new PassThrough(), o);
};

/** Run main() with console.log/console.error captured. */
async function cli(...argv: string[]): Promise<{ code: number | "running"; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const [l, e] = [console.log, console.error];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = l;
    console.error = e;
  }
}

const inviteCount = (dir: string) => {
  const db = new DatabaseSync(join(dir, "ddn.db"), { readOnly: true });
  try {
    return Number((db.prepare("SELECT count(*) AS n FROM invites").get() as { n: number }).n);
  } finally {
    db.close();
  }
};

async function mkInstance(mode: "metadata-only" | "e2ee" | "plain", extra: Record<string, unknown> = {}) {
  const dir = tmp();
  const port = await freePort();
  await setup({ yes: true, acceptRisk: true, dataDir: dir, port, publicUrl: `http://127.0.0.1:${port}`, signup: "invite", autostart: false, selfTest: false, invite: false, mode, ...extra }, quiet());
  return { dir, port, url: `http://127.0.0.1:${port}` };
}

describe("--help and unknown options: help only, nothing is done", () => {
  it("every command: --help / -h prints help and exits 0 without side effects (invite --help made a real code before)", async () => {
    const { dir } = await mkInstance("metadata-only");
    expect(inviteCount(dir)).toBe(0);
    for (const argv of [
      ["invite", "--help"],
      ["invite", "-h"],
      ["invite", "--note", "x", "--help"],
      ["invite", "list", "--help"],
      ["invite", "revoke", "abc", "-h"],
      ["accounts", "--help"],
      ["accounts", "delete", "acct-x", "--yes", "--help"],
      ["signup", "open", "--help"],
      ["doctor", "--help"],
      ["setup", "--help"],
      ["start", "--help"],
      ["channels", "--help"],
      ["uninstall-autostart", "--help"],
    ]) {
      const r = await cli(...argv, "--data-dir", dir);
      expect([argv.join(" "), r.code]).toEqual([argv.join(" "), 0]);
      expect(r.out).toMatch(/discordrive/);
      expect(r.out).not.toMatch(/ddn-inv-/);
    }
    expect(inviteCount(dir)).toBe(0);
    expect(loadConfig(dir).signup).toBe("invite");
    // `help <command>` too.
    expect((await cli("help", "invite")).out).toMatch(/invite list/);
  });

  it("an unknown option or a stray word is an error with the help, nothing is done", async () => {
    const { dir } = await mkInstance("metadata-only");
    for (const argv of [["invite", "--bogus"], ["invite", "--days"], ["accounts", "list", "--force"], ["doctor", "extra"], ["signup", "open", "--yes"], ["start", "--nope"], ["setup", "--yes", "--accept-risk", "--colour", "x"]]) {
      const r = await cli(...argv, "--data-dir", dir);
      expect([argv.join(" "), r.code]).toEqual([argv.join(" "), 64]);
      expect(r.err).toMatch(/unknown option|needs a value|takes no argument/);
    }
    expect(inviteCount(dir)).toBe(0);
    expect(loadConfig(dir).signup).toBe("invite");
  });
});

describe("discordrive accounts / invite / signup", () => {
  it("full round: invite with note → account → list shows it; block refuses sign-in; unblock; admin; delete; log as operator", async () => {
    const { dir, url } = await mkInstance("metadata-only", { firstAdmin: false });
    const srv = await serve(loadConfig(dir), () => {});
    cleanups.push(() => srv.close());
    const lines: string[] = [];
    const io = { out: (s: string) => void lines.push(s) };
    const take = () => lines.splice(0).join("\n");

    // invite (+ --note, --days), list, revoke by ID prefix
    const made = await cli("invite", "--note", "for Ann", "--days", "3", "--data-dir", dir);
    expect(made.code).toBe(0);
    const code = made.out.trim();
    expect(code).toMatch(/^ddn-inv-[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    const spare = (await cli("invite", "--note", "spare", "--data-dir", dir)).out.trim();
    expect(await inviteCli(dir, ["list"], {}, io)).toBe(0);
    const listed = take();
    expect(listed).toMatch(/active.*for Ann/);
    expect(listed).not.toContain(code.slice(8)); // the code itself is never listed
    const json = JSON.parse((await cli("invite", "list", "--json", "--data-dir", dir)).out) as { invites: { id: string; note: string }[] };
    const spareId = json.invites.find((x) => x.note === "spare")!.id;
    expect(await inviteCli(dir, ["revoke", spareId.slice(0, 5)], {}, io)).toBe(0);
    expect(take()).toMatch(/Revoked/);
    await expect(createAccountHttp(url, await generateDeviceKey(), newAccountKey(), undefined, spare)).rejects.toThrow(/invite_required/);
    expect(await inviteCli(dir, ["revoke", "zz"], {}, io)).toBe(1);
    take();

    // account from the code; list shows the note, devices, admin no, active
    const key = newAccountKey();
    const dk = await generateDeviceKey();
    const a = await createAccountHttp(url, dk, key, undefined, code);
    const api = new HttpApi({ baseUrl: url, accountId: a.accountId, deviceId: a.deviceId, key: dk });
    await api.put(a.accountId, 0, { revision: 1, blob: new Uint8Array(100) });
    expect(await accountsCli(dir, ["list"], {}, io)).toBe(0);
    const l1 = take();
    expect(l1).toMatch(new RegExp(`${a.accountId.slice(0, 13)}.*\\s1\\s.*active\\s+for Ann\\s+no`));
    const lj = JSON.parse((await cli("accounts", "list", "--json", "--data-dir", dir)).out) as { accounts: { accountId: string; inviteNote: string; devices: number; serverBytes: number; poolBytes: number | null; admin: boolean }[] };
    expect(lj.accounts[0]).toMatchObject({ accountId: a.accountId, inviteNote: "for Ann", devices: 1, poolBytes: null, admin: false });
    expect(lj.accounts[0]!.serverBytes).toBeGreaterThan(100);
    // the code shows who used it
    expect((await cli("invite", "list", "--data-dir", dir)).out).toMatch(new RegExp(`used.*for Ann.*${a.accountId.slice(0, 13)}`));

    // block (by a prefix of the ID): sign-in refused, data kept; unblock
    const prefix = a.accountId.slice(5, 12);
    expect(await accountsCli(dir, ["block", prefix], { reason: "test" }, io)).toBe(0);
    await expect(api.session(true)).rejects.toThrow(/account_blocked/);
    expect(await accountsCli(dir, ["list"], {}, io)).toBe(0);
    expect(take()).toMatch(/blocked \(test\)/);
    expect(await accountsCli(dir, ["unblock", a.accountId], {}, io)).toBe(0);
    await api.session(true);
    expect((await api.get())?.revision).toBe(1);

    // admin on/off
    expect(await accountsCli(dir, ["admin", a.accountId, "on"], {}, io)).toBe(0);
    expect((await api.json<{ admin: boolean }>("GET", "/v1/account")).body.admin).toBe(true);
    expect(await accountsCli(dir, ["admin", a.accountId, "maybe"], {}, io)).toBe(64);
    expect(await accountsCli(dir, ["admin", a.accountId, "off"], {}, io)).toBe(0);
    expect(take()).toMatch(/No admin accounts left/);

    // delete: without --yes and without a terminal = refused; with a "no" answer = refused; --yes = gone
    expect(await accountsCli(dir, ["delete", a.accountId], {}, io)).toBe(1);
    const t1 = take();
    expect(t1).toMatch(/NOT deleted: the user can restore the account from their rescue kit on another instance/);
    expect(t1).toMatch(/confirm with --yes/);
    expect(await accountsCli(dir, ["delete", a.accountId], {}, { ...io, confirm: async () => false })).toBe(1);
    expect(take()).toMatch(/Not deleted\./);
    expect(await accountsCli(dir, ["delete", a.accountId], { yes: true }, io)).toBe(0);
    expect(take()).toMatch(/Deleted:/);
    await expect(api.session(true)).rejects.toThrow(/401 bad_signature/);
    expect(await accountsCli(dir, ["block", a.accountId], {}, io)).toBe(1);
    expect(take()).toMatch(/no such account/);

    // signup: live (the running server answers with the new policy at once), saved in config.json
    expect(await signupCli(dir, ["closed"], io)).toBe(0);
    await expect(createAccountHttp(url, await generateDeviceKey(), newAccountKey())).rejects.toThrow(/signup_closed/);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).signup).toBe("closed");
    expect(await signupCli(dir, ["sometimes"], io)).toBe(64);
    expect(await signupCli(dir, ["open"], io)).toBe(0);
    await createAccountHttp(url, await generateDeviceKey(), newAccountKey());
    const h = (await (await fetch(`${url}/v1/health`)).json()) as { signup: string };
    expect(h.signup).toBe("open");

    // the administrative log, as "operator"
    const actions = srv.admin.logList().map((e) => `${e.actor} ${e.action}`).reverse();
    expect(actions).toEqual([
      "operator invite.create",
      "operator invite.create",
      "operator invite.revoke",
      "operator account.block",
      "operator account.unblock",
      "operator account.admin_on",
      "operator account.admin_off",
      "operator account.delete",
      "operator signup.set",
      "operator signup.set",
    ]);
    // Polish
    setCliLang("pl");
    expect(await accountsCli(dir, ["list"], {}, io)).toBe(0);
    expect(take()).toMatch(/aktywne/);
  });

  it("a block made by the CLI closes the account's open websocket of the running server within seconds", async () => {
    const { dir, url } = await mkInstance("metadata-only", { signup: "open" });
    const srv = await serve(loadConfig(dir), () => {});
    cleanups.push(() => srv.close());
    const dk = await generateDeviceKey();
    const a = await createAccountHttp(url, dk, newAccountKey());
    const api = new HttpApi({ baseUrl: url, accountId: a.accountId, deviceId: a.deviceId, key: dk });
    const lost: string[] = [];
    const sub = api.subscribe(() => {}, { onAuthLost: (c) => lost.push(c), maxBackoffMs: 200 });
    cleanups.push(() => sub.close());
    for (let i = 0; i < 100 && !sub.connected; i++) await new Promise((r) => setTimeout(r, 20));
    expect(sub.connected).toBe(true);
    const t0 = Date.now();
    expect(await accountsCli(dir, ["block", a.accountId], {}, { out: () => {} })).toBe(0);
    while (sub.connected && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    expect(sub.connected).toBe(false);
    expect(Date.now() - t0).toBeLessThan(4000);
    for (let i = 0; i < 200 && !lost.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(lost).toEqual(["account_blocked"]);
  });

  it("setup: the first account becomes admin (default), not on --no-first-admin, never on a re-run with accounts", async () => {
    const { dir, url } = await mkInstance("metadata-only", { signup: "open" });
    let srv = await serve(loadConfig(dir), () => {});
    const mk = async () => {
      const dk = await generateDeviceKey();
      const a = await createAccountHttp(url, dk, newAccountKey());
      return new HttpApi({ baseUrl: url, accountId: a.accountId, deviceId: a.deviceId, key: dk });
    };
    const first = await mk();
    const second = await mk();
    expect((await first.json<{ admin: boolean }>("GET", "/v1/account")).body.admin).toBe(true);
    expect((await second.json<{ admin: boolean }>("GET", "/v1/account")).body.admin).toBe(false);
    await srv.close();
    // A re-run of setup on this instance (it has accounts) does not arm it again.
    await setup({ yes: true, acceptRisk: true, dataDir: dir, autostart: false, selfTest: false }, quiet());
    srv = await serve(loadConfig(dir), () => {});
    cleanups.push(() => srv.close());
    const third = await mk();
    expect((await third.json<{ admin: boolean }>("GET", "/v1/account")).body.admin).toBe(false);

    const other = await mkInstance("metadata-only", { signup: "open", firstAdmin: false });
    const s2 = await serve(loadConfig(other.dir), () => {});
    cleanups.push(() => s2.close());
    const dk = await generateDeviceKey();
    const a = await createAccountHttp(other.url, dk, newAccountKey());
    const api = new HttpApi({ baseUrl: other.url, accountId: a.accountId, deviceId: a.deviceId, key: dk });
    expect((await api.json<{ admin: boolean }>("GET", "/v1/account")).body.admin).toBe(false);
  });
});

describe("deleting an account per mode", () => {
  for (const mode of ["e2ee", "plain"] as const) {
    it(`${mode}: its pieces disappear from the (fake) Discord in the background, other accounts' stay`, async () => {
      const fake = new FakeDiscord();
      const origin = await fake.listen();
      cleanups.push(() => fake.close());
      const hooksFile = join(tmp(), "hooks.txt");
      writeFileSync(hooksFile, [fake.addWebhook("1550000000000000711").url, fake.addWebhook("1550000000000000712").url].join("\n") + "\n");
      const { dir, url } = await mkInstance(mode, { signup: "open", webhooksFile: hooksFile, discordApiOrigin: origin });
      const srv = await serve(loadConfig(dir), () => {});
      cleanups.push(() => srv.close());
      const ext = <T>(name: string) => srv.extensions.find((x) => x.name === name) as unknown as T;
      const blobs = ext<{ deleteAccounts(): Promise<number> }>("server-blobs");
      const snaps = ext<{ tick(force: boolean): Promise<number> }>("server-snapshots");

      const mkClient = async () => {
        const key = newAccountKey();
        const dk = await generateDeviceKey();
        const a = await createAccountHttp(url, dk, key);
        const api = new HttpApi({ baseUrl: url, accountId: a.accountId, deviceId: a.deviceId, key: dk });
        let arbiter: ConstructorParameters<typeof DriveClient>[0]["arbiter"];
        if (mode === "plain") {
          const { PlainArbiter, PlainOpCodec } = await import("@ddv4/metadata-client/plain-ops");
          arbiter = new PlainArbiter(new PlainOpCodec(a.accountId), api);
        } else arbiter = new EncryptedArbiter(new OpCodec(key, a.accountId), api);
        const client = new DriveClient({ device: { id: a.deviceId, name: "t" }, arbiter, blobs: new ServerBlobStore(api), chunkSize: 4096 });
        return { a, api, client };
      };
      const victim = await mkClient();
      const keeper = await mkClient();
      await victim.client.upload(memorySource(new Uint8Array(4096 * 5 + 7).fill(1)), "v.bin");
      await keeper.client.upload(memorySource(new Uint8Array(4096 * 3 + 1).fill(2)), "k.bin");
      expect(await snaps.tick(true)).toBe(2);
      const onDiscord = () => [...fake.messages.values()].length;
      const before = onDiscord();
      const db = new DatabaseSync(join(dir, "ddn.db"), { readOnly: true });
      cleanups.push(() => db.close());
      const pieces = (acct: string) =>
        Number((db.prepare("SELECT count(*) AS n FROM s_blobs WHERE account_id = ? AND deleted_at IS NULL").get(acct) as { n: number }).n) +
        Number((db.prepare("SELECT count(*) AS n FROM s_snap_objs WHERE account_id = ?").get(acct) as { n: number }).n);
      const victimPieces = pieces(victim.a.accountId);
      const keeperPieces = pieces(keeper.a.accountId);
      expect(victimPieces).toBeGreaterThanOrEqual(7); // 6 fragments + manifest + snapshot objects

      const lines: string[] = [];
      expect(await accountsCli(dir, ["delete", victim.a.accountId], { yes: true }, { out: (s) => void lines.push(s) })).toBe(0);
      const text = lines.join("\n");
      expect(text).toMatch(/cannot be undone/);
      expect(text).toMatch(/being deleted in the background/);
      // The running server picks the deletion up (its background tick; here driven directly).
      expect(await blobs.deleteAccounts()).toBe(1);
      expect(pieces(victim.a.accountId)).toBe(0);
      expect(onDiscord()).toBe(before - victimPieces);
      expect(pieces(keeper.a.accountId)).toBe(keeperPieces);
      const lj = JSON.parse((await cli("accounts", "list", "--json", "--data-dir", dir)).out) as { accounts: { accountId: string; poolBytes: number }[]; deletions: unknown[] };
      expect(lj.accounts.map((x) => x.accountId)).toEqual([keeper.a.accountId]);
      expect(lj.accounts[0]!.poolBytes).toBeGreaterThan(0);
      expect(lj.deletions).toEqual([]);
      // The keeper still downloads its file.
      const parts: Uint8Array[] = [];
      const k = keeper.client.list("root").find((x) => x.name === "k.bin")!;
      await keeper.client.download(k.id, { write: async (b) => void parts.push(new Uint8Array(b)) });
      expect(Buffer.concat(parts).length).toBe(4096 * 3 + 1);
      if (mode === "plain") {
        const { readdirSync, existsSync } = await import("node:fs");
        const rep = join(dir, "replicas");
        expect(existsSync(rep) ? readdirSync(rep).filter((f) => f.startsWith(victim.a.accountId)) : []).toEqual([]);
      }
      const snapFile = JSON.parse(readFileSync(join(dir, "snapshots.json"), "utf8")) as { accounts: { account_id: string }[] };
      expect(snapFile.accounts.map((x) => x.account_id)).toEqual([keeper.a.accountId]);
    });
  }

  it("metadata only: deleting sends nothing to Discord (the files are on the user's own channels)", async () => {
    const fake = new FakeDiscord();
    await fake.listen();
    cleanups.push(() => fake.close());
    const { dir, url } = await mkInstance("metadata-only", { signup: "open" });
    const srv = await serve(loadConfig(dir), () => {});
    cleanups.push(() => srv.close());
    const dk = await generateDeviceKey();
    const a = await createAccountHttp(url, dk, newAccountKey());
    const api = new HttpApi({ baseUrl: url, accountId: a.accountId, deviceId: a.deviceId, key: dk });
    await api.put(a.accountId, 0, { revision: 1, blob: new Uint8Array(10) });
    const calls = fake.posts + fake.messages.size;
    expect(await accountsCli(dir, ["delete", a.accountId], { yes: true }, { out: () => {} })).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.posts + fake.messages.size).toBe(calls);
    expect(srv.admin.deletion(a.accountId)).toMatchObject({ state: "done", total: 0 });
  });
});
