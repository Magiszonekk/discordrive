// Transfer logs: one JSON object per line (JSON Lines), per
// fragment and per file, for finding where an upload or a download spends its time. Format:
// docs/transfer-log.md (version 1; later versions only ADD fields).
//
// Privacy: no webhook tokens or URLs, no CDN links (only the host), no file names unless the user
// turned "include file names" on (then `name`, otherwise only the extension). IDs (webhook,
// channel, upload) are not secrets: they cannot be used to post or read without the token / key.
//
// The logger is optional everywhere (null = off, no cost). Writing never throws into a transfer.

export type TransferDir = "up" | "down";
export type TransferSource = "web" | "cli" | "server";

export const TRANSFER_LOG_VERSION = 1;

/** Wall clock in ms with sub-ms resolution where available (0.1 ms). */
export function nowMs(): number {
  const p = (globalThis as { performance?: { timeOrigin?: number; now(): number } }).performance;
  const t = p && typeof p.timeOrigin === "number" ? p.timeOrigin + p.now() : Date.now();
  return Math.round(t * 10) / 10;
}

/** Duration rounded to 0.1 ms. */
export const ms = (from: number, to = nowMs()): number => Math.round((to - from) * 10) / 10;

/**
 * Error text safe for a log: every URL reduced to its host (webhook URLs carry the token, CDN
 * links carry signatures), long base64/hex runs cut, at most 200 characters.
 */
export function scrubText(s: string): string {
  return s
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s?#]+)[^\s"']*/gi, "<url:$1>")
    .replace(/\/webhooks\/(\d+)\/[A-Za-z0-9_.-]+/g, "/webhooks/$1/<redacted>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<long>")
    .slice(0, 200);
}

export function errText(e: unknown): string {
  return scrubText(String((e as Error)?.message ?? e));
}

/** Host of a URL (CDN/API), never the path or the query. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

/** Limiter state of a channel at the moment of an event (rate-limit.ts ChannelPacer.state). */
export interface LimiterState {
  /** Sustained rate (messages/min). */
  pm: number;
  /** Tokens in the bucket. */
  tok: number;
  /** Blocked for this many ms more (after a 429). */
  blk: number;
  /** Requests queued on this channel. */
  q: number;
}

export interface TransferLogOptions {
  src: TransferSource;
  /** Include file names (off by default: only the extension). */
  names?: boolean;
  /** Build mode (metadata-only / e2ee / plain), written into every file_start. */
  mode?: string;
  /** Build of the app (version + source hash + commit), written into every file_start. */
  build?: string;
  /** Fields added to every line (server: the account). */
  base?: Record<string, unknown>;
}

export class TransferLog {
  /** Fragments in flight right now, per direction (the "concurrency" of an event). */
  readonly fl: Record<TransferDir, number> = { up: 0, down: 0 };
  names: boolean;
  /** Events written (diagnostics/tests). */
  count = 0;

  constructor(
    private readonly sink: (line: string) => void,
    readonly o: TransferLogOptions,
  ) {
    this.names = !!o.names;
  }

  emit(ev: string, f: Record<string, unknown>): void {
    try {
      this.sink(JSON.stringify({ v: TRANSFER_LOG_VERSION, t: nowMs(), src: this.o.src, ...this.o.base, ev, ...f }) + "\n");
      this.count++;
    } catch {
      /* a log must never break a transfer */
    }
  }

  /** `{ name }` when names are on, else `{ ext }` (lowercase, at most 10 chars, "" without one). */
  nameFields(name: string): { name?: string; ext: string } {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 11 ? name.slice(dot + 1).toLowerCase() : "";
    return this.names ? { name, ext } : { ext };
  }
}

/** A sink that keeps lines in memory (tests, the in-memory fallback of the browser). */
export class MemoryLogSink {
  readonly lines: string[] = [];
  bytes = 0;
  constructor(private readonly maxBytes = 50 * 1024 * 1024) {}
  write = (line: string): void => {
    this.lines.push(line);
    this.bytes += line.length;
    while (this.bytes > this.maxBytes && this.lines.length > 1) this.bytes -= this.lines.shift()!.length;
  };
  text(): string {
    return this.lines.join("");
  }
  clear(): void {
    this.lines.length = 0;
    this.bytes = 0;
  }
}

/** Fields of a request event from an error (status, 429 details, Cloudflare). */
export function reqErrFields(e: unknown): Record<string, unknown> {
  const x = e as { status?: number; retryAfterMs?: number; scope?: string | null; global?: boolean; cloudflare?: boolean; name?: string };
  if (x?.name === "RateLimitedError") return { st: 429, ra: x.retryAfterMs, scope: x.scope ?? null, glob: !!x.global, ...(x.cloudflare ? { cf: true } : {}), err: "429" };
  return { ...(typeof x?.status === "number" ? { st: x.status } : {}), err: errText(e) };
}

/** Per-transfer context passed down to the blob store (which fragment a request belongs to). */
export interface TransferCtx {
  dir: TransferDir;
  /** Transfer ID: the upload ID (both directions; a download reads the pieces of one upload). */
  x: string;
  /** Fragment index or "m" (manifest). */
  i: number | "m";
}
