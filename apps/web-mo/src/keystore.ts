// Key storage in the browser (IndexedDB). The device's Ed25519 private key is
// a NON-extractable CryptoKey: IndexedDB stores the key object, JS can sign
// with it but never read its bytes (decision #13). The account key must be
// readable (it is shown in the rescue kit and sent during pairing), so it is
// stored as raw bytes; the browser is a cache, the rescue kit is the backup.

const DB = "ddn-keys";
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

export interface StoredAccount {
  serverUrl: string;
  instanceId: string;
  accountId: string;
  deviceId: string;
  deviceName: string;
  /** Account key, base64. */
  accountKey: string;
  devicePublicKey: string;
  devicePrivateKey: CryptoKey;
  pointer?: { webhookId: string; messageId: string };
}

export const keystore = {
  load: () => tx<StoredAccount | undefined>("readonly", (s) => s.get("account")),
  save: (a: StoredAccount) => tx<void>("readwrite", (s) => s.put(a, "account")),
  clear: () => tx<void>("readwrite", (s) => s.delete("account")),
};
