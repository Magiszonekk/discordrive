// `discordrive channels`: the operator's side of removing a channel (zlecenie 2026-10-13-webhooki
// p. 1, owner decision 6). Pool webhooks (scope "pool") belong to the operator: the same rules as
// an account's own channels (Settings → Channels), over every account with blobs or snapshot
// chains on the webhook.
//
//   channels [--data-dir D] list                 pool webhooks: files, bytes, retired, critical; removed ones
//   channels impact <id>                         what removing it affects
//   channels retire <id> | unretire <id>         no new blobs there / undo (refused when critical or last)
//   channels move <id> [--wait]                  queue "move and remove"; the RUNNING server executes it
//                                                (it holds the Discord sender and its pacing); --wait polls
//   channels status                              the last move job of the pool
//   channels remove <id> --force                 remove anyway (files on it become unavailable, nothing deleted)
//
// Database only, never Discord: safe beside a running server (WAL + busy timeout; the server sees
// the change through PRAGMA data_version and picks queued jobs up on its background tick).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChannelError, ChannelStore, INSTANCE_KEY_FILE, InstanceHooks, POOL, loadInstanceKey, type MoveStatusJson } from "@ddv4/server-discord";
import { t, cliLang, type CliKey } from "./i18n.js";

export function humanBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < u.length - 1) ((v /= 1000), i++);
  const s = i === 0 ? String(v) : v.toFixed(v >= 100 ? 0 : 1);
  return `${cliLang() === "pl" ? s.replace(".", ",") : s} ${u[i]}`;
}

function humanMs(ms: number | null): string {
  if (ms === null) return "?";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

const ERR: Record<string, CliKey> = {
  no_such_channel: "ch.e.noSuch",
  channel_critical: "ch.e.critical",
  need_other_channel: "ch.e.needOther",
  move_running: "ch.e.moveRunning",
  index_pending: "ch.e.indexPending",
};

function open(dataDir: string): { db: DatabaseSync; store: ChannelStore } {
  const cfg = join(dataDir, "config.json");
  if (existsSync(cfg)) {
    const mode = (JSON.parse(readFileSync(cfg, "utf8")) as { mode?: string }).mode;
    if (mode !== "e2ee" && mode !== "plain") throw new ChannelError(400, t("ch.notServerMode", { mode: String(mode ?? "metadata-only") }));
  }
  const dbFile = join(dataDir, "ddn.db");
  if (!existsSync(dbFile)) throw new ChannelError(400, t("ch.noDb", { dir: dataDir }));
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA busy_timeout = 5000");
  const hooks = new InstanceHooks(db, loadInstanceKey(join(dataDir, INSTANCE_KEY_FILE), false));
  return { db, store: new ChannelStore(db, hooks) };
}

function statusLine(s: MoveStatusJson): string {
  const state = s.queued ? t("ch.st.queued") : t(`ch.st.${s.state}` as CliKey);
  return t("ch.status", {
    id: s.webhookId,
    label: s.label || "-",
    state,
    done: s.done,
    total: s.total,
    bytes: humanBytes(s.bytesDone),
    bytesTotal: humanBytes(s.bytesTotal),
    eta: humanMs(s.state === "done" || s.state === "failed" ? 0 : s.etaMs),
  }) + (s.error ? `  (${s.error})` : "");
}

export interface ChannelsCliOptions {
  out?: (s: string) => void;
  /** Poll interval of `move --wait` (ms). */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Returns the exit code (0 ok, 1 refused/failed, 64 usage). */
export async function channelsCli(dataDir: string, args: string[], opts: Record<string, string | boolean>, o: ChannelsCliOptions = {}): Promise<number> {
  const out = o.out ?? ((s: string) => console.log(s));
  const [sub = "list", id] = args;
  const needId = () => {
    if (!id || !/^\d{15,22}$/.test(id)) throw new ChannelError(64, t("ch.needId"));
    return id;
  };
  if (!["list", "impact", "retire", "unretire", "move", "status", "remove"].includes(sub)) {
    out(t("ch.usage"));
    return 64;
  }
  let db: DatabaseSync | null = null;
  try {
    const o2 = open(dataDir);
    db = o2.db;
    const cs = o2.store;
    switch (sub) {
      case "list": {
        const rows = cs.rows(POOL);
        if (!rows.length) out(t("ch.none"));
        for (const r of rows) {
          const flags = [r.retired ? t("ch.retired") : "", r.critical ? t("ch.critical", { what: r.criticalWhat.join("+") }) : "", r.alive ? "" : t("ch.dead")].filter(Boolean).join(" ");
          out(t("ch.row", { id: r.id, channel: r.channelId, label: r.label || "-", files: r.files, bytes: humanBytes(r.bytes) }) + (flags ? `  ${flags}` : ""));
        }
        const rm = cs.removed(POOL);
        if (rm.length) out(t("ch.removedHead"));
        for (const r of rm) out(t("ch.removedRow", { id: r.id, label: r.label || "-", how: t(r.how === "moved" ? "ch.how.moved" : "ch.how.removed"), n: r.unavailableFiles, at: new Date(r.removedAt).toISOString().slice(0, 16).replace("T", " ") }));
        const pend = cs.unindexed(POOL);
        if (pend.length) out(t("ch.indexNote", { n: pend.length }));
        const st = cs.status(cs.lastJob(POOL));
        if (st) out(statusLine(st));
        return 0;
      }
      case "impact": {
        const im = cs.impact(POOL, needId());
        out(t("ch.impact", { id: im.webhookId, label: im.label || "-", files: im.files, bytes: humanBytes(im.bytes) }));
        if (im.critical) out(t("ch.impactCritical", { what: im.criticalWhat.join("+") }));
        out(t("ch.impactMove", { n: im.otherActive, bytes: humanBytes(im.moveBytes), eta: humanMs(im.moveEtaMs) }));
        if (im.retired) out(t("ch.impactRetired"));
        if (cs.unindexed(POOL).length) out(t("ch.indexNote", { n: cs.unindexed(POOL).length }));
        return 0;
      }
      case "retire":
      case "unretire":
        cs.retire(POOL, needId(), sub === "retire");
        out(t(sub === "retire" ? "ch.retiredOk" : "ch.unretiredOk", { id: id! }));
        return 0;
      case "remove": {
        const w = needId();
        if (opts.force !== true) {
          const im = cs.impact(POOL, w);
          out(t("ch.removeNeedsForce", { files: im.files, bytes: humanBytes(im.bytes) }));
          return 1;
        }
        cs.removeAnyway(POOL, w);
        out(t("ch.removedOk", { id: w }));
        return 0;
      }
      case "status": {
        const st = cs.status(cs.lastJob(POOL));
        out(st ? statusLine(st) : t("ch.noJob"));
        return 0;
      }
      case "move": {
        const j = cs.enqueueMove(POOL, needId());
        out(t("ch.queued", { id: j.webhook_id }));
        if (opts.wait !== true) {
          out(t("ch.background"));
          return 0;
        }
        const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        let last = "";
        for (;;) {
          const row = cs.job(j.id)!;
          const st = cs.status(row)!;
          const line = statusLine(st);
          if (line !== last) out((last = line));
          if (row.state === "done") return 0;
          if (row.state === "failed") return 1;
          await sleep(o.pollMs ?? 1000);
        }
      }
    }
    return 64;
  } catch (e) {
    if (e instanceof ChannelError) {
      out(ERR[e.code] ? t(ERR[e.code]!) : e.code === e.message ? e.code : e.message);
      return e.status === 64 ? 64 : 1;
    }
    throw e;
  } finally {
    db?.close();
  }
}
