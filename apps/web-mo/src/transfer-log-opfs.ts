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

  /** Every line this browser kept (all tabs), oldest file first. */
  async text(): Promise<string> {
    await this.flush();
    if (this.mem) return this.mem.text();
    const parts: string[] = [];
    for (const f of await this.list()) parts.push(await f.file.text());
    return parts.join("");
  }

  async size(): Promise<number> {
    if (this.mem) return this.mem.bytes;
    return (await this.list()).reduce((s, f) => s + f.size, 0) + this.buf.reduce((s, l) => s + l.length, 0);
  }

  /** Delete every log file (this tab's open part is emptied and kept open). */
  async clear(): Promise<void> {
    await this.flush();
    this.mem?.clear();
    const d = await this.root();
    if (!d) return;
    if (this.h) {
      this.h.close();
      this.h = null;
    }
    for (const f of await this.list()) await d.removeEntry(f.name).catch(() => {});
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
