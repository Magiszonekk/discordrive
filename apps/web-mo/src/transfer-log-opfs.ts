// Transfer logs in the browser (zlecenie 2026-10-13-transfer §2), written by the app worker into
// OPFS: directory ddn-transfer-logs/, one file per tab session and part (name starts with the time,
// so a sort by name is oldest first), each ≤ PART_BYTES, all together ≤ MAX_BYTES (oldest parts
// deleted). Lines are buffered and flushed every second. A sync access handle is exclusive to one
// worker, so every tab writes its own files; the download joins them all (the report sorts by time).
// Without OPFS (old browser, private mode) the lines stay in memory for this tab only.

import { MemoryLogSink } from "@ddv4/metadata-client";

const DIR = "ddn-transfer-logs";
export const MAX_BYTES = 50 * 1024 * 1024;
const PART_BYTES = 8 * 1024 * 1024;
/** Time of the last Clear (ms), in the log directory; not a .jsonl, so list() ignores it. */
const CLEARED_FILE = "cleared-at";

/** Lines of `text` whose "t" (ms) is at or after `since`; a line without "t" is kept. */
export function keepSince(text: string, since: number): string {
  let out = "";
  for (const line of text.split("\n")) {
    if (!line) continue;
    const m = /"t":(\d+(?:\.\d+)?)/.exec(line);
    if (!m || Number(m[1]) >= since) out += line + "\n";
  }
  return out;
}

type SyncHandle = { write(b: Uint8Array, o?: { at: number }): number; flush(): void; close(): void; getSize(): number };
type FileH = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };

export class OpfsTransferLog {
  private dir: FileSystemDirectoryHandle | null = null;
  private h: SyncHandle | null = null;
  private name = "";
  private at = 0;
  private buf: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private mem: MemoryLogSink | null = null;
  private readonly session = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  private part = 0;
  private flushing: Promise<void> = Promise.resolve();

  /** Where lines go: "opfs" or "memory" (no OPFS here). */
  where: "opfs" | "memory" = "opfs";

  write = (line: string): void => {
    if (this.mem) return this.mem.write(line);
    this.buf.push(line);
    this.timer ??= setInterval(() => void this.flush(), 1000);
  };

  private async root(): Promise<FileSystemDirectoryHandle | null> {
    if (this.dir) return this.dir;
    try {
      const r = await navigator.storage.getDirectory();
      this.dir = await r.getDirectoryHandle(DIR, { create: true });
      return this.dir;
    } catch {
      return null;
    }
  }

  private async open(): Promise<boolean> {
    if (this.h) return true;
    const d = await this.root();
    if (!d) return false;
    try {
      this.name = `${this.session}-${String(this.part++).padStart(3, "0")}.jsonl`;
      const f = (await d.getFileHandle(this.name, { create: true })) as FileH;
      this.h = await f.createSyncAccessHandle();
      this.at = this.h.getSize();
      return true;
    } catch {
      return false;
    }
  }

  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushNow()).catch(() => {});
    return this.flushing;
  }

  private async flushNow(): Promise<void> {
    if (!this.buf.length) return;
    if (!(await this.open())) {
      // No OPFS / sync handles: keep this tab's lines in memory.
      this.mem = new MemoryLogSink(MAX_BYTES);
      this.where = "memory";
      for (const l of this.buf) this.mem.write(l);
      this.buf = [];
      return;
    }
    const data = new TextEncoder().encode(this.buf.join(""));
    this.buf = [];
    this.at += this.h!.write(data, { at: this.at });
    this.h!.flush();
    if (this.at >= PART_BYTES) {
      this.h!.close();
      this.h = null;
      await this.trim();
    }
  }

  /** Oldest parts go while the total is over MAX_BYTES (a part another tab holds open is skipped). */
  private async trim(): Promise<void> {
    const d = await this.root();
    if (!d) return;
    const files = await this.list();
    let total = files.reduce((s, f) => s + f.size, 0);
    for (const f of files) {
      if (total <= MAX_BYTES) break;
      if (f.name === this.name && this.h) continue;
      try {
        await d.removeEntry(f.name);
        total -= f.size;
      } catch {
        /* open in another tab */
      }
    }
  }

  private async list(): Promise<{ name: string; size: number; file: File }[]> {
    const d = await this.root();
    if (!d) return [];
    const out: { name: string; size: number; file: File }[] = [];
    for await (const [name, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind !== "file" || !name.endsWith(".jsonl")) continue;
      try {
        const file = await (h as FileSystemFileHandle).getFile();
        out.push({ name, size: file.size, file });
      } catch {
        /* locked by another tab's sync handle: Chromium still allows getFile */
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Every line this browser kept (all tabs), oldest file first; lines from before the last Clear are left out. */
  async text(): Promise<string> {
    await this.flush();
    if (this.mem) return this.mem.text();
    const since = await this.clearedAt();
    const parts: string[] = [];
    for (const f of await this.list()) {
      const t = await f.file.text();
      parts.push(since ? keepSince(t, since) : t);
    }
    return parts.join("");
  }

  async size(): Promise<number> {
    if (this.mem) return this.mem.bytes;
    if (await this.clearedAt()) return new TextEncoder().encode(await this.text()).byteLength;
    return (await this.list()).reduce((s, f) => s + f.size, 0) + this.buf.reduce((s, l) => s + l.length, 0);
  }

  /**
   * Delete every log file (this tab's open part is closed first). A part that another tab (or a tab
   * left open from an earlier session) still holds open cannot be removed — the browser refuses while
   * its sync handle is open. So Clear also stores the time of the clear, and older lines are left out
   * of the download no matter which file they sit in. Returns how many parts could not be removed.
   */
  async clear(): Promise<{ kept: number }> {
    await this.flush();
    this.mem?.clear();
    const d = await this.root();
    if (!d) return { kept: 0 };
    if (this.h) {
      this.h.close();
      this.h = null;
    }
    await this.setClearedAt(Date.now());
    let kept = 0;
    for (const f of await this.list()) await d.removeEntry(f.name).catch(() => void kept++);
    if (!kept) await this.setClearedAt(0);
    return { kept };
  }

  private clearedCache: number | undefined;
  private async clearedAt(): Promise<number> {
    if (this.clearedCache !== undefined) return this.clearedCache;
    const d = await this.root();
    let v = 0;
    try {
      const fh = await d!.getFileHandle(CLEARED_FILE);
      v = Number((await (await fh.getFile()).text()).trim()) || 0;
    } catch {
      v = 0;
    }
    this.clearedCache = v;
    return v;
  }
  private async setClearedAt(ms: number): Promise<void> {
    this.clearedCache = ms;
    const d = await this.root();
    if (!d) return;
    try {
      if (!ms) {
        await d.removeEntry(CLEARED_FILE).catch(() => {});
        return;
      }
      const fh = (await d.getFileHandle(CLEARED_FILE, { create: true })) as FileH;
      const h = await fh.createSyncAccessHandle();
      const b = new TextEncoder().encode(String(ms));
      (h as SyncHandle & { truncate(n: number): void }).truncate(0);
      h.write(b, { at: 0 });
      h.flush();
      h.close();
    } catch {
      /* the in-memory value still filters this tab's downloads */
    }
  }

  async stop(): Promise<void> {
    await this.flush();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.h) {
      this.h.close();
      this.h = null;
    }
  }
}

/** gzip when the browser can (CompressionStream), else the plain text. */
export async function gzipText(text: string): Promise<{ data: Blob; gz: boolean }> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!CS) return { data: new Blob([text], { type: "application/x-ndjson" }), gz: false };
  const s = new Blob([text]).stream().pipeThrough(new CS("gzip"));
  return { data: new Blob([await new Response(s).arrayBuffer()], { type: "application/gzip" }), gz: true };
}
