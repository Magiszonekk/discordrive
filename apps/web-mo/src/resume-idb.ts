// Unfinished transfers on this device (resume after a reload).
// IndexedDB of this origin, one object store, plain JSON values; used from the app worker.
// An upload's header holds the file key of the unfinished version (the device already keeps the
// account key in IndexedDB the same way, keystore.ts); one small entry per stored fragment.

import { resumeKeys, type ResumeStore, type UploadJournal } from "@ddv4/metadata-client";

const DB = "ddn-resume";
const STORE = "kv";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const r = f(t.objectStore(STORE));
      t.oncomplete = () => resolve(r.result as T);
      t.onerror = () => reject(t.error);
    });
  } finally {
    d.close();
  }
}

/** Keys from `p` up to (not including) the next prefix: every string key that starts with `p`. */
const range = (p: string) => IDBKeyRange.bound(p, p + "\uffff", false, true);

/** Per account: keys are prefixed, so two accounts in one browser never see each other's journals. */
export class IdbResumeStore implements ResumeStore {
  private readonly pre: string;
  constructor(account: string) {
    this.pre = `${account}|`;
  }
  get(key: string): Promise<unknown> {
    return tx("readonly", (s) => s.get(this.pre + key));
  }
  async put(key: string, value: unknown): Promise<void> {
    await tx("readwrite", (s) => s.put(value, this.pre + key));
  }
  async del(key: string): Promise<void> {
    await tx("readwrite", (s) => s.delete(this.pre + key));
  }
  async entries(prefix: string): Promise<[string, unknown][]> {
    const r = range(this.pre + prefix);
    const keys = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys(r));
    const vals = await tx<unknown[]>("readonly", (s) => s.getAll(r));
    return keys.map((k, i) => [String(k).slice(this.pre.length), vals[i]]);
  }
  async delPrefix(prefix: string): Promise<void> {
    await tx("readwrite", (s) => s.delete(range(this.pre + prefix)));
  }
  /** Unfinished uploads of this account (the "pick the files again to continue" note), with stored fragments. */
  async uploads(): Promise<{ key: string; j: UploadJournal; have: number }[]> {
    const out: { key: string; j: UploadJournal; have: number }[] = [];
    for (const [k, v] of await this.entries("up:")) {
      const j = v as UploadJournal;
      if (j?.v !== 1) continue;
      const key = k.slice(3);
      const have = await tx<number>("readonly", (s) => s.count(range(this.pre + resumeKeys(key).frags)));
      out.push({ key, j, have });
    }
    return out;
  }
  async forget(key: string): Promise<void> {
    const r = resumeKeys(key);
    await this.del(r.head);
    await this.delPrefix(r.frags);
  }
}

/** Resume key of an upload: the same file (name, size, modification time) into the same folder. */
export function uploadResumeKey(folder: string, file: { name: string; size: number; lastModified?: number }): string {
  return `${folder}|${file.size}|${file.lastModified ?? 0}|${file.name}`;
}
