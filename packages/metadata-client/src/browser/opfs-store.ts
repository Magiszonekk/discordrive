// Tree layer in the browser (koncept §4.1): SqlIndexStore on SQLite-WASM with
// the OPFS SAH-pool VFS. Synchronous like node:sqlite, so apply() stays
// synchronous; must run in a dedicated Worker (OPFS sync access handles).
//
// The tree lives on disk (OPFS), not in RAM; the browser is a cache, not the
// backup (§4.1): the client asks for persistent storage but relies on the
// server log and the Discord snapshots for "nothing gets lost".

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { SqlIndexStore, type SqlDriver, type SqlValue } from "../sql-store.js";

type Db = InstanceType<Awaited<ReturnType<Awaited<ReturnType<typeof sqlite3InitModule>>["installOpfsSAHPoolVfs"]>>["OpfsSAHPoolDb"]>;

/**
 * Pool capacity is in files (database + journal). A client keeps ONE index
 * database per account, so the default of 6 handles a few accounts.
 */
export interface OpfsStoreOptions {
  /** OPFS directory for this app's databases (one VFS instance per directory). */
  directory?: string;
  /** Database file name inside the pool, e.g. per account: "/index-<accountId>.db". */
  filename: string;
  /** Delete every database of the pool before opening (tests, sign-out). */
  clearOnInit?: boolean;
  /** Where sqlite3.wasm is served from, if not next to the bundle. */
  wasmUrl?: string;
}

interface Stmt {
  bind(v: SqlValue[]): Stmt;
  step(): boolean;
  get(o: Record<string, SqlValue>): Record<string, SqlValue>;
  reset(clear?: boolean): Stmt;
  finalize(): void;
}

/** Prepared statements are cached per SQL text (measured: exec() re-preparing each call was the bottleneck). */
function driver(db: Db): SqlDriver {
  const cache = new Map<string, Stmt>();
  const prep = (sql: string): Stmt => {
    let st = cache.get(sql);
    if (!st) cache.set(sql, (st = (db as unknown as { prepare(sql: string): Stmt }).prepare(sql)));
    return st;
  };
  const rows = <T>(sql: string, p: SqlValue[], max = Infinity): T[] => {
    const st = prep(sql);
    try {
      if (p.length) st.bind(p);
      const out: T[] = [];
      // max = 0: statement without result rows (INSERT/UPDATE/DELETE), step once to execute it.
      if (max === 0) st.step();
      else while (out.length < max && st.step()) out.push(st.get({}) as T);
      return out;
    } finally {
      st.reset(true);
    }
  };
  return {
    exec: (sql) => void db.exec(sql),
    run: (sql, p) => {
      rows(sql, p, 0);
      return { changes: Number(db.changes()) };
    },
    get: <T>(sql: string, p: SqlValue[]) => rows<T>(sql, p, 1)[0],
    all: rows,
    close: () => {
      for (const st of cache.values()) st.finalize();
      cache.clear();
      db.close();
    },
  };
}

// One SAH pool per directory per worker: the VFS holds the OPFS access handles
// for its whole pool, so installing it twice (or in two workers at once) fails.
// Only one worker of the origin may own the pool: the main-tab worker (§4.1).
const pools = new Map<string, Promise<{ OpfsSAHPoolDb: new (f: string) => Db; getCapacity(): number; wipeFiles(): Promise<void> }>>();

function pool(opts: OpfsStoreOptions) {
  const dir = opts.directory ?? ".ddn-index";
  let p = pools.get(dir);
  if (!p) {
    p = (async () => {
      // init() takes Emscripten module overrides at runtime (locateFile), not in its typings.
      const init = sqlite3InitModule as unknown as (m?: { locateFile?: () => string }) => ReturnType<typeof sqlite3InitModule>;
      const sqlite3 = await init(opts.wasmUrl ? { locateFile: () => opts.wasmUrl! } : undefined);
      return sqlite3.installOpfsSAHPoolVfs({ directory: dir, initialCapacity: 6 }) as never;
    })();
    pools.set(dir, p);
    p.catch(() => pools.delete(dir));
  }
  return p;
}

export async function openOpfsIndexStore(opts: OpfsStoreOptions): Promise<SqlIndexStore & { vfsCapacity: number }> {
  const pl = await pool(opts);
  if (opts.clearOnInit) await pl.wipeFiles();
  const db = new pl.OpfsSAHPoolDb(opts.filename);
  db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL;");
  const store = new SqlIndexStore(driver(db)) as SqlIndexStore & { vfsCapacity: number };
  store.vfsCapacity = pl.getCapacity();
  return store;
}

/** Ask the browser not to evict our storage (§4.1). Returns whether it is persistent. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) || ((await navigator.storage?.persist?.()) ?? false);
  } catch {
    return false;
  }
}
