// Operator commands on the instance database (they work while the server runs or not):
//   accounts list [--json]                       accounts with devices, activity, size, state, invite note, admin
//   accounts block <id> [--reason TEXT]          no sign-in/sync/pairing/notifications; sessions end at once
//   accounts unblock <id>
//   accounts delete <id> [--yes]                 delete the account's data on this server (asks first)
//   accounts admin <id> on|off                   the admin flag (web app → Admin)
//   invite [--days N] [--note TEXT]              new single-use code
//   invite list [--json]                         active / used / expired / revoked codes
//   invite revoke <code|id-prefix>
//   signup invite|open|closed                    sign-up policy, live (no restart, no setup)
// <id> = the account ID or a unique start of it (as shown by `accounts list`).
// Every change is written to the administrative log as "operator".
// A running server notices blocks and deletions within ~2 s (PRAGMA data_version) and closes the
// account's open connections; in e2ee/plain it then deletes the account's pieces on Discord in
// the background (`accounts list` shows the progress).

import { DatabaseSync } from "node:sqlite";
import { AdminError, AdminStore, InviteError, InviteStore, OPERATOR, SIGNUP_POLICIES, type SignupPolicy } from "@ddv4/metadata-client/node";
import { dbPath, loadConfig, saveConfig, type InstanceConfig } from "./config.js";
import { cliLang, t, type CliKey } from "./i18n.js";
import { humanBytes } from "./channels.js";

export interface AdminCliIo {
  out?: (s: string) => void;
  /** Ask a yes/no question (accounts delete without --yes). Default: refuse (no terminal). */
  confirm?: (q: string) => Promise<boolean>;
}

class UsageError extends Error {}

function openDb(c: InstanceConfig): DatabaseSync {
  const db = new DatabaseSync(dbPath(c));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return db;
}

const date = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-");
const shortId = (id: string) => id.slice(0, 13);

const ERR: Record<string, CliKey> = {
  no_such_account: "ac.e.noSuch",
  ambiguous_account: "ac.e.ambiguous",
  bad_account_ref: "ac.e.ref",
  last_admin: "ac.e.lastAdmin",
  no_such_invite: "inv.e.noSuch",
  ambiguous_invite: "inv.e.ambiguous",
  bad_invite_ref: "inv.e.ref",
  invite_used: "inv.e.used",
};

/** The instance's config; a database that does not exist yet is created on first use (fine). */
const load = (dataDir: string): InstanceConfig => loadConfig(dataDir);

/** `discordrive accounts …`. Returns the exit code (0 ok, 1 refused/failed, 64 usage). */
export async function accountsCli(dataDir: string, args: string[], opts: Record<string, string | boolean>, io: AdminCliIo = {}): Promise<number> {
  const out = io.out ?? ((s: string) => console.log(s));
  const [sub, ref, onoff] = args;
  if (!sub || !["list", "block", "unblock", "delete", "admin"].includes(sub)) {
    out(t("ac.usage"));
    return 64;
  }
  const c = load(dataDir);
  const db = openDb(c);
  const a = new AdminStore(db);
  try {
    if (sub === "list") {
      const list = a.accounts();
      const dels = a.deletions().filter((d) => d.state !== "done");
      if (opts.json === true) {
        out(JSON.stringify({ mode: c.mode, signup: a.signup(c.signup), accounts: list, deletions: dels }, null, 2));
        return 0;
      }
      if (!list.length) out(t("ac.none"));
      else {
        const rows = [[t("ac.col.id"), t("ac.col.created"), t("ac.col.seen"), t("ac.col.devices"), t("ac.col.size"), t("ac.col.state"), t("ac.col.invite"), t("ac.col.admin")]];
        for (const x of list)
          rows.push([
            shortId(x.accountId),
            date(x.createdAt),
            date(x.lastSeenAt),
            String(x.devices),
            humanBytes(x.serverBytes) + (x.poolBytes !== null ? ` + ${humanBytes(x.poolBytes)} ${t("ac.onDiscord")}` : ""),
            x.state === "blocked" ? t("ac.blocked") + (x.blockedReason ? ` (${x.blockedReason})` : "") : t("ac.active"),
            x.inviteNote === null ? "-" : x.inviteNote || t("ac.noNote"),
            x.admin ? t("ac.yes") : t("ac.no"),
          ]);
        out(table(rows));
      }
      for (const d of dels) out(t("ac.deleting", { id: shortId(d.accountId), done: d.done, total: d.total, state: d.state, err: d.error ? ` (${d.error})` : "" }));
      out(t("ac.listNote", { mode: c.mode }));
      return 0;
    }
    if (!ref) throw new UsageError(t("ac.needId"));
    const id = a.resolve(ref);
    switch (sub) {
      case "block": {
        const reason = typeof opts.reason === "string" ? opts.reason : "";
        a.block(id, reason, OPERATOR);
        out(t("ac.blockedOk", { id }));
        return 0;
      }
      case "unblock":
        a.unblock(id, OPERATOR);
        out(t("ac.unblockedOk", { id }));
        return 0;
      case "admin": {
        if (onoff !== "on" && onoff !== "off") throw new UsageError(t("ac.needOnOff"));
        a.setAdmin(id, onoff === "on", OPERATOR);
        out(t(onoff === "on" ? "ac.adminOn" : "ac.adminOff", { id }));
        if (onoff === "off" && a.adminCount() === 0) out(t("ac.noAdminsLeft"));
        return 0;
      }
      case "delete": {
        const acc = a.account(id)!;
        const pool = acc.poolBytes !== null;
        out(t(pool ? "ac.delWarnPool" : "ac.delWarnMo", { id, devices: acc.devices, size: humanBytes(acc.serverBytes), pool: humanBytes(acc.poolBytes ?? 0) }));
        let yes = opts.yes === true;
        if (!yes) {
          if (!io.confirm) {
            out(t("ac.delNeedYes"));
            return 1;
          }
          yes = await io.confirm(t("ac.delQ", { id: shortId(id) }));
        }
        if (!yes) {
          out(t("ac.delCancelled"));
          return 1;
        }
        const d = a.deleteAccount(id, OPERATOR);
        out(t(d.state === "done" ? "ac.deletedOk" : "ac.deletedQueued", { id, total: d.total }));
        return 0;
      }
    }
    return 64;
  } catch (e) {
    if (e instanceof UsageError) {
      out(`${e.message}\n\n${t("ac.usage")}`);
      return 64;
    }
    if (e instanceof AdminError) {
      out(ERR[e.code] ? t(ERR[e.code]!, { ref: ref ?? "" }) : e.code);
      return 1;
    }
    throw e;
  } finally {
    db.close();
  }
}

/** `discordrive invite [list|revoke <ref>]`. */
export async function inviteCli(dataDir: string, args: string[], opts: Record<string, string | boolean>, io: AdminCliIo = {}): Promise<number> {
  const out = io.out ?? ((s: string) => console.log(s));
  const [sub, ref] = args;
  if (sub !== undefined && sub !== "list" && sub !== "revoke") {
    out(t("inv.usage"));
    return 64;
  }
  const c = load(dataDir);
  const db = openDb(c);
  const a = new AdminStore(db);
  const inv = new InviteStore(db);
  try {
    if (sub === undefined) {
      const daysRaw = typeof opts.days === "string" ? Number(opts.days) : 7;
      if (!Number.isFinite(daysRaw) || daysRaw <= 0 || daysRaw > 365) throw new UsageError(t("inv.badDays"));
      const note = typeof opts.note === "string" ? opts.note : "";
      const r = inv.create(Math.round(daysRaw * 24 * 3600_000), note, OPERATOR);
      a.log(OPERATOR, "invite.create", r.id, { note, days: daysRaw });
      out(r.code);
      console.error(t("cli.invite", { date: new Date(r.expiresAt).toLocaleString(cliLang() === "pl" ? "pl-PL" : "en-US") }));
      if (a.signup(c.signup) !== "invite") console.error(t("inv.policyNote", { policy: t(`signup.${a.signup(c.signup)}` as CliKey) }));
      return 0;
    }
    if (sub === "list") {
      const list = inv.list();
      if (opts.json === true) {
        out(JSON.stringify({ invites: list }, null, 2));
        return 0;
      }
      if (!list.length) out(t("inv.none"));
      else {
        const rows = [[t("inv.col.id"), t("inv.col.state"), t("inv.col.created"), t("inv.col.expires"), t("inv.col.note"), t("inv.col.usedBy")]];
        for (const x of list) rows.push([x.id, t(`inv.st.${x.state}` as CliKey), date(x.createdAt), date(x.expiresAt), x.note || "-", x.usedBy ? shortId(x.usedBy) : "-"]);
        out(table(rows));
      }
      return 0;
    }
    if (!ref) throw new UsageError(t("inv.needRef"));
    const r = inv.revoke(ref);
    a.log(OPERATOR, "invite.revoke", r.id, { note: r.note });
    out(t("inv.revokedOk", { id: r.id }));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      out(`${e.message}\n\n${t("inv.usage")}`);
      return 64;
    }
    if (e instanceof InviteError) {
      out(t(ERR[e.code]!, { ref: ref ?? "" }));
      return 1;
    }
    throw e;
  } finally {
    db.close();
  }
}

/** `discordrive signup invite|open|closed`: the policy in the database (live) and in config.json. */
export async function signupCli(dataDir: string, args: string[], io: AdminCliIo = {}): Promise<number> {
  const out = io.out ?? ((s: string) => console.log(s));
  const [policy] = args;
  const c = load(dataDir);
  const db = openDb(c);
  try {
    const a = new AdminStore(db);
    if (policy === undefined) {
      out(t("su.now", { policy: t(`signup.${a.signup(c.signup)}` as CliKey) }));
      out(t("su.usage"));
      return 0;
    }
    if (!(SIGNUP_POLICIES as string[]).includes(policy)) {
      out(t("su.usage"));
      return 64;
    }
    a.setSignup(policy as SignupPolicy, OPERATOR);
    saveConfig({ ...c, signup: policy as SignupPolicy });
    out(t("su.set", { policy: t(`signup.${policy}` as CliKey) }));
    return 0;
  } finally {
    db.close();
  }
}

function table(rows: string[][]): string {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => [...(r[i] ?? "")].length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat(w[i]! - [...cell].length))).join("  ").trimEnd()).join("\n");
}
