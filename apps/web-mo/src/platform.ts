// What the application core needs from the place it runs in. The browser worker (web-platform.ts) and the
// desktop agent (apps/desktop) each provide one; app-core.ts itself imports no browser-only or Node-only API,
// so the same core (and the same UI talking to it through `core`) serves both.
import type { IndexStore } from "@ddv4/sync-core";
import type { ByteSource, LaneFetch, ResumeStore, UploadJournal } from "@ddv4/metadata-client";
import type { StoredAccount } from "./keystore.js";

/** Account and device keys of this device. */
export interface KeyStore {
  load(): Promise<StoredAccount | undefined>;
  save(a: StoredAccount): Promise<void>;
  clear(): Promise<void>;
}

/** Unfinished uploads of one account, with the listing the "continue" note needs. */
export interface PlatformResumeStore extends ResumeStore {
  uploads(): Promise<{ key: string; j: UploadJournal; have: number }[]>;
  forget(key: string): Promise<void>;
}

/** Where this device's transfer log lines go (Settings → Diagnostics). */
export interface TransferLogStore {
  write: (line: string) => void;
  /** Shown in Diagnostics: "opfs", "memory", "file". */
  readonly where: string;
  flush(): Promise<void>;
  size(): Promise<number>;
  text(): Promise<string>;
  clear(): Promise<{ kept: number }>;
  stop(): Promise<void>;
}

/** A file on this computer opened for writing a download at offsets (desktop only). */
export interface DiskTarget {
  /** Bytes already in the file (a resumed download is cut back to what its journal vouches for). */
  readonly size: number;
  truncate(len: number): Promise<void>;
  writeAt(offset: number, data: Uint8Array): Promise<void>;
  /** fsync + close; `finalPath`: the name it got (the partial file is renamed when done). */
  finish(): Promise<{ finalPath: string }>;
  close(): Promise<void>;
}

/** Files on this computer (desktop only: the browser has no paths). */
export interface DiskFiles {
  /** Random-access source of a file to upload (read on demand, never whole into memory). */
  openSource(path: string): Promise<ByteSource & { name: string; mtimeMs: number; close(): Promise<void> }>;
  /** Every regular file under a folder (dropping a folder uploads its contents), with their path relative to it. */
  walk(dir: string): Promise<{ path: string; rel: string[] }[]>;
  /** Is this path a folder? */
  isDir(path: string): Promise<boolean>;
  /**
   * Open the target of a download in `dir`: a partial file `<name>.ddnpart` (kept across restarts
   * for resuming) renamed to a free name (`name`, `name (1)`, …) when done.
   */
  openTarget(dir: string, name: string, partKey: string): Promise<DiskTarget & { partPath: string }>;
  /** Default folder for downloads (the system's Downloads, or the one picked in Settings). */
  downloadsDir(): string;
  /** Change it (Settings → Desktop app). */
  setDownloadsDir?(dir: string): void;
}

export interface CorePlatform {
  /** "web": browser worker; "desktop": the desktop app's agent. */
  readonly kind: "web" | "desktop";
  readonly keys: KeyStore;
  /**
   * Whether a new device key may be exported. Browser: no (IndexedDB keeps a non-extractable CryptoKey);
   * desktop: yes, the agent seals the raw key with the OS key store.
   */
  readonly extractableDeviceKey: boolean;
  /** One main instance per account (browser: Web Locks across tabs; desktop: the agent is the only one). */
  leadership(accountId: string, onChange: (leader: boolean) => void): { ready: Promise<void>; release(): void };
  /** The tree on disk of the main instance; `persistent`: storage the system will not evict. */
  openIndex(accountId: string): Promise<{ store: IndexStore; persistent: boolean }>;
  resume(accountId: string): PlatformResumeStore;
  transferLog(): TransferLogStore;
  /** gzip when available, else the plain text. */
  gzip(text: string): Promise<{ data: Blob; gz: boolean }>;
  /** Origin of the instance the app was loaded from, when it has one (browser: the page's origin). */
  homeOrigin(): string | null;
  /** How requests to Discord go out (desktop: the agent's HTTP/2 pool); absent: the global fetch. */
  discordFetch?: typeof fetch;
  /**
   * Extra download connections the stuck-connection guard may move new downloads to (desktop: more
   * sessions of the agent's pool). The browser adds its own later (sandboxed iframes, attachLane).
   */
  cdnLanes?: LaneFetch[];
  /** How the device key is kept on disk (desktop): "os" = sealed by the system key store, "file" = owner-only file. */
  keyProtection?: "os" | "file";
  /** Desktop: files on this computer (uploads from disk, downloads written straight to disk). */
  files?: DiskFiles;
}
