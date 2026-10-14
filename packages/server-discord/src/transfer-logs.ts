// Server part of the transfer logs (zlecenie 2026-10-13-transfer §2), e2ee and plain: what the
// instance does between the browser and Discord (body read, in-flight budget, limiter wait, the
// Discord request, 429s, retries), one JSON line per event in
//   <data dir>/logs/transfers-YYYY-MM-DD.jsonl   (UTC day; oldest files deleted past maxBytes)
// Same format as the browser's log (docs/transfer-log.md), src "server", with `acct` on every line
// so a user downloads only the lines of their own account.
//
// On for every account when the instance config says `transferLogs: true`, otherwise per account:
// the user turns "Record transfer logs" on in Settings → Diagnostics (POST /v1/diagnostics/transfer-log).
// Never written: webhook tokens/URLs, CDN links, file names (the server of an e2ee instance does not
// know them anyway; plain does and still leaves them out).

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { TransferLog } from "@ddv4/metadata-client";

export const SERVER_LOG_MAX_BYTES = 200 * 1024 * 1024;
const FILE_RE = /^transfers-\d{4}-\d{2}-\d{2}\.jsonl$/;

export interface ServerTransferLogsOptions {
  dataDir: string;
  /** Log every account (instance config `transferLogs: true`). */
  all?: boolean;
  maxBytes?: number;
  now?: () => number;
}

export class ServerTransferLogs {
  readonly dir: string;
  readonly all: boolean;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private db: DatabaseSync | null = null;
  private readonly on = new Set<string>();
  private readonly loggers = new Map<string, TransferLog>();
  private buf: string[] = [];
  private bufBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private writes = 0;

  constructor(o: ServerTransferLogsOptions) {
    this.dir = join(o.dataDir, "logs");
    this.all = !!o.all;
    this.maxBytes = o.maxBytes ?? SERVER_LOG_MAX_BYTES;
    this.now = o.now ?? (() => Date.now());
  }

  init(db: DatabaseSync): void {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS s_diag (account_id TEXT PRIMARY KEY, transfer_log INTEGER NOT NULL DEFAULT 0, cleared_at INTEGER NOT NULL DEFAULT 0)");
    for (const r of db.prepare("SELECT account_id FROM s_diag WHERE transfer_log = 1").all() as { account_id: string }[]) this.on.add(r.account_id);
    this.timer = setInterval(() => this.flush(), 1000);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  enabled(acct: string): boolean {
    return this.all || this.on.has(acct);
  }

  /** The logger for an account, or null when its logs are off (no cost then). */
  for(acct: string): TransferLog | null {
    if (!this.enabled(acct)) return null;
    let l = this.loggers.get(acct);
    if (!l) {
      l = new TransferLog((line) => this.write(line), { src: "server", base: { acct } });
      this.loggers.set(acct, l);
    }
    return l;
  }

  set(acct: string, on: boolean): void {
    this.db?.prepare("INSERT INTO s_diag (account_id, transfer_log) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET transfer_log = excluded.transfer_log").run(acct, on ? 1 : 0);
    if (on) this.on.add(acct);
    else this.on.delete(acct);
  }

  status(acct: string): { on: boolean; all: boolean; own: boolean } {
    return { on: this.enabled(acct), all: this.all, own: this.on.has(acct) };
  }

  /** "Clear" for one account: its older lines are no longer handed out (the shared files are rotated, not rewritten). */
  clear(acct: string): void {
    this.flush();
    this.db?.prepare("INSERT INTO s_diag (account_id, cleared_at) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET cleared_at = excluded.cleared_at").run(acct, this.now());
  }

  private write(line: string): void {
    this.buf.push(line);
    this.bufBytes += line.length;
    if (this.bufBytes > 256 * 1024) this.flush();
  }

  flush(): void {
    if (!this.buf.length) return;
    const data = this.buf.join("");
    this.buf = [];
    this.bufBytes = 0;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const day = new Date(this.now()).toISOString().slice(0, 10);
      appendFileSync(join(this.dir, `transfers-${day}.jsonl`), data, { mode: 0o600 });
      if (++this.writes % 20 === 1) this.rotate();
    } catch {
      /* a full disk must not break uploads */
    }
  }

  private files(): { name: string; size: number }[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => FILE_RE.test(f))
        .sort()
        .map((name) => ({ name, size: statSync(join(this.dir, name)).size }));
    } catch {
      return [];
    }
  }

  /** Oldest day files go while the total is over the limit (the current day stays). */
  rotate(): void {
    const fs = this.files();
    let total = fs.reduce((s, f) => s + f.size, 0);
    for (const f of fs.slice(0, -1)) {
      if (total <= this.maxBytes) break;
      try {
        unlinkSync(join(this.dir, f.name));
        total -= f.size;
      } catch {
        /* next time */
      }
    }
  }

  /** This account's lines (after its last clear), oldest first. */
  read(acct: string): string {
    this.flush();
    const cleared = (this.db?.prepare("SELECT cleared_at FROM s_diag WHERE account_id = ?").get(acct) as { cleared_at: number } | undefined)?.cleared_at ?? 0;
    const tag = `"acct":${JSON.stringify(acct)}`;
    const out: string[] = [];
    for (const f of this.files()) {
      for (const line of readFileSync(join(this.dir, f.name), "utf8").split("\n")) {
        if (!line || !line.includes(tag)) continue;
        if (cleared) {
          const t = Number(/"t":([\d.]+)/.exec(line)?.[1] ?? 0);
          if (t <= cleared) continue;
        }
        out.push(line);
      }
    }
    return out.length ? out.join("\n") + "\n" : "";
  }

  bytes(): number {
    return this.files().reduce((s, f) => s + f.size, 0);
  }
}
