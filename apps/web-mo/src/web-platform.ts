// The browser worker's platform for the application core: keys in IndexedDB, the tree in SQLite on OPFS
// (main tab only, Web Locks), upload journals in IndexedDB, the transfer log in OPFS.
import { claimLeadership, openOpfsIndexStore, requestPersistentStorage } from "@ddv4/metadata-client/browser";
import type { CorePlatform } from "./platform.js";
import { keystore } from "./keystore.js";
import { IdbResumeStore } from "./resume-idb.js";
import { OpfsTransferLog, gzipText } from "./transfer-log-opfs.js";

export function webPlatform(cfg: { wasmUrl?: string } = {}): CorePlatform {
  let tlog: OpfsTransferLog | null = null;
  return {
    kind: "web",
    keys: keystore,
    extractableDeviceKey: false,
    leadership: (accountId, onChange) => claimLeadership(accountId, onChange),
    async openIndex(accountId) {
      const persistent = await requestPersistentStorage();
      return { store: await openOpfsIndexStore({ filename: `/index-${accountId}.db`, wasmUrl: cfg.wasmUrl }), persistent };
    },
    resume: (accountId) => new IdbResumeStore(accountId),
    transferLog: () => (tlog ??= new OpfsTransferLog()),
    gzip: gzipText,
    homeOrigin: () => (globalThis as { location?: { origin?: string } }).location?.origin ?? null,
  };
}
