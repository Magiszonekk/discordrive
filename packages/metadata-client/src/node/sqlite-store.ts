// Tree layer on disk for Node (CLI/desktop): SqlIndexStore over the built-in
// node:sqlite (Node 22+, synchronous, no native addon).

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { SqlIndexStore, type SqlDriver, type SqlValue } from "../sql-store.js";

export type { ChildRow } from "../sql-store.js";

export function nodeSqliteDriver(path = ":memory:"): SqlDriver & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  const cache = new Map<string, StatementSync>();
  const st = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  return {
    db,
    exec: (sql) => db.exec(sql),
    run: (sql, p: SqlValue[]) => ({ changes: Number(st(sql).run(...p).changes) }),
    get: <T>(sql: string, p: SqlValue[]) => st(sql).get(...p) as T | undefined,
    all: <T>(sql: string, p: SqlValue[]) => st(sql).all(...p) as T[],
    close: () => db.close(),
  };
}

export class SqliteIndexStore extends SqlIndexStore {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    const d = nodeSqliteDriver(path);
    super(d);
    this.db = d.db;
  }
}
