// HTTP/2 transport of the desktop agent (and any Node client) towards Discord: a `fetch`-compatible function
// over node:http2 with its own connection management, handed to DiscordWebhookTransport({ fetch }).
//
// Measured (docs/conn-bench.md, docs/desktop-agent-transport.md):
//  - uploads need SEVERAL separate connections: on one HTTP/2 connection Discord resets streams past some
//    concurrency (ENHANCE_YOUR_CALM / INTERNAL_ERROR at 32 × 10 MiB); the same posts over separate
//    connections all pass and reach ~91% of the line. conn-bench's h2-N is ONE connection per post in
//    flight; the agent measured on a test server (2 GB, 12 channels): 6 sessions × up to 6 streams got
//    resets down to 1–2 streams per session and 17 MB/s, one stream per session matches conn-bench. So an
//    upload session carries one large post at a time, and sessions are opened as the window grows;
//  - downloads are best on ONE connection (112 MB/s on a 110 MB/s line; N connections measured worse).
// So: requests with a body go to a small pool of sessions ("up" lanes) with a per-session stream cap;
// requests without one go to one session per origin ("down"), plus extra lanes for the stuck-connection
// guard, each its own session, opened only when the guard actually probes one.
//
// Session errors: a session that got GOAWAY, a session error or was closed is dead at once and never
// reused (reusing a closing session silently lost 111 uploads in conn-bench). A stream refused with
// REFUSED_STREAM (or not processed before a GOAWAY) was not handled by the server, so it is sent again on a
// live session here; REFUSED_STREAM / ENHANCE_YOUR_CALM lower that session's stream cap (too many streams
// on one connection) instead of being treated as a generic network failure. Every other failure surfaces as
// a NetworkError, and the caller's retry logic (netCall, the uploader) sends the piece again.
//
// http:// origins (local tests) and origins whose server does not speak h2 go through the global fetch
// (HTTP/1.1, a pool of sockets: within ~15% of h2 per conn-bench).
import http2, { type ClientHttp2Session, type ClientHttp2Stream, type SecureClientSessionOptions } from "node:http2";
import { NetworkError } from "../net.js";

const { NGHTTP2_REFUSED_STREAM, NGHTTP2_ENHANCE_YOUR_CALM, NGHTTP2_CANCEL, NGHTTP2_NO_ERROR } = http2.constants;

export interface H2FetchOptions {
  /** Most separate sessions for uploads (requests with a body); opened as needed. Default 32. */
  upSessions?: number;
  /** Streams at once on one upload session (lowered when the server refuses). Default 1. */
  upStreams?: number;
  /** Streams at once on the download session. Default 64 (one connection carries everything). */
  downStreams?: number;
  /** TLS options for every session (tests: a self-signed certificate). */
  tls?: Pick<SecureClientSessionOptions, "ca" | "rejectUnauthorized">;
  /** Fallback for http:// and non-h2 origins. Default: the global fetch. */
  fallback?: typeof fetch;
  /** Called on session events (logs, tests): opened, dead (goaway/error/close), cap lowered. */
  onEvent?: (e: H2Event) => void;
}

export type H2Event =
  | { ev: "open"; origin: string; role: string; lane: number }
  | { ev: "dead"; origin: string; role: string; lane: number; why: string }
  | { ev: "cap"; origin: string; role: string; lane: number; cap: number }
  | { ev: "retry"; origin: string; role: string; lane: number; why: string };

/** Header the response carries: which connection (lane) answered (transfer log `ln`). */
export const LANE_HEADER = "x-ddn-lane";

class Lane {
  session: ClientHttp2Session | null = null;
  dead = true;
  active = 0;
  constructor(
    readonly index: number,
    public cap: number,
  ) {}
  usable(): boolean {
    return !this.dead && !!this.session && !this.session.closed && !this.session.destroyed;
  }
}

class Group {
  readonly lanes: Lane[];
  private waiters: (() => void)[] = [];
  constructor(
    readonly origin: string,
    readonly role: "up" | "down",
    size: number,
    readonly cap: number,
    private readonly open: (g: Group, l: Lane) => void,
  ) {
    this.lanes = Array.from({ length: size }, (_, i) => new Lane(i, cap));
  }
  /** A lane with a free stream slot (opening a dead/new one if needed), waiting while all are full. */
  async acquire(only?: number): Promise<Lane> {
    for (;;) {
      const cands = only === undefined ? this.lanes : [this.lanes[only]!];
      // A live session with a free slot first; a new session only when every live one is full (sessions
      // are opened as the number of requests in flight grows, never all up front).
      let best: Lane | null = null;
      for (const l of cands) if (l.usable() && l.active < l.cap && (!best || l.active < best.active)) best = l;
      if (!best) {
        const fresh = cands.find((l) => !l.usable());
        if (fresh) {
          this.open(this, fresh);
          best = fresh;
        }
      }
      if (best) {
        best.active++;
        return best;
      }
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
  release(l: Lane) {
    l.active = Math.max(0, l.active - 1);
    this.waiters.shift()?.();
  }
  wakeAll() {
    for (const w of this.waiters.splice(0)) w();
  }
}

/** A request the server did not process (safe to send again): refused, or past the GOAWAY's last stream. */
class NotProcessed extends Error {}

export interface H2Fetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /**
   * A request whose body is given as parts, written to the connection as they are (no copy; the webhook
   * post: multipart head + the 10 MiB fragment + tail). Same sessions and rules as a fetch with a body.
   */
  sendParts(url: string, init: { method: string; headers: Record<string, string>; parts: Uint8Array[]; signal?: AbortSignal }): Promise<Response>;
  /** Download on a given lane of the origin's download group (lane ≥ 1: the guard's extra connections). */
  onLane(lane: number): (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  /** Close every session. */
  close(): void;
  /** Sessions open now, per origin and role (tests, diagnostics). */
  stats(): { origin: string; role: string; lane: number; alive: boolean; active: number; cap: number }[];
}

export function h2Fetch(o: H2FetchOptions = {}): H2Fetch {
  const upN = Math.max(1, o.upSessions ?? 32);
  const upCap = Math.max(1, o.upStreams ?? 1);
  const downCap = Math.max(1, o.downStreams ?? 64);
  const fallback = o.fallback ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const groups = new Map<string, Group>();
  /** Origins that answered without h2 (ALPN): the fallback serves them from then on. */
  const noH2 = new Set<string>();
  const emit = (e: H2Event) => o.onEvent?.(e);

  const openLane = (g: Group, l: Lane) => {
    const s = http2.connect(g.origin, { ...o.tls, settings: { initialWindowSize: 6 * 1024 * 1024 } });
    l.session = s;
    l.dead = false;
    const kill = (why: string) => {
      if (l.session !== s || l.dead) return;
      l.dead = true;
      emit({ ev: "dead", origin: g.origin, role: g.role, lane: l.index, why });
      if (!s.closed) s.close();
      g.wakeAll();
    };
    s.on("goaway", (code) => kill(`goaway ${code}`));
    s.on("error", (e: NodeJS.ErrnoException) => kill(`error ${e.code ?? e.message}`));
    s.on("close", () => kill("close"));
    s.on("connect", () => {
      // ALPN fell back to HTTP/1.1: this origin is served by the fallback from now on.
      const alpn = (s.socket as { alpnProtocol?: string | false } | undefined)?.alpnProtocol;
      if (alpn !== undefined && alpn !== "h2") {
        noH2.add(g.origin);
        kill("no h2");
        return;
      }
      try {
        s.setLocalWindowSize(15 * 1024 * 1024);
      } catch {
        /* closed meanwhile */
      }
    });
    s.unref();
    emit({ ev: "open", origin: g.origin, role: g.role, lane: l.index });
  };

  const group = (origin: string, role: "up" | "down", lanes = 1): Group => {
    const k = `${role} ${origin}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = new Group(origin, role, role === "up" ? upN : lanes, role === "up" ? upCap : downCap, openLane)));
    while (g.lanes.length < lanes) g.lanes.push(new Lane(g.lanes.length, downCap));
    return g;
  };

  /** One request on one stream; resolves at the response headers, the body streams after. */
  const onStream = (g: Group, l: Lane, url: URL, method: string, headers: Record<string, string>, body: ReadableStream<Uint8Array> | null, signal?: AbortSignal | null): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) return reject(abortErr(signal));
      let req: ClientHttp2Stream;
      try {
        req = l.session!.request({ ":method": method, ":path": url.pathname + url.search, ...headers }, { endStream: !body });
      } catch (e) {
        // The session is closing (GOAWAY between pick and request): not processed.
        return reject(new NotProcessed(String((e as Error)?.message ?? e)));
      }
      let answered = false;
      let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
      const onAbort = () => {
        req.close(NGHTTP2_CANCEL);
        const e = abortErr(signal!);
        if (!answered) reject(e);
        else ctrl?.error(e);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const fail = (e: Error) => {
        signal?.removeEventListener("abort", onAbort);
        if (!answered) reject(e);
        else ctrl?.error(e);
      };
      req.on("error", (e: NodeJS.ErrnoException) => {
        if (req.rstCode === NGHTTP2_REFUSED_STREAM || e.code === "ERR_HTTP2_GOAWAY_SESSION") return fail(new NotProcessed(`${e.code ?? e.message}`));
        fail(new NetworkError(`h2: ${e.code ?? e.message}`));
      });
      req.on("close", () => {
        const rst = req.rstCode;
        if (rst === NGHTTP2_REFUSED_STREAM || rst === NGHTTP2_ENHANCE_YOUR_CALM) {
          // Too many streams on this connection: fewer from now on.
          const cap = Math.max(1, Math.min(l.cap - 1, l.active - 1));
          if (cap < l.cap) {
            l.cap = cap;
            emit({ ev: "cap", origin: g.origin, role: g.role, lane: l.index, cap });
          }
        }
        if (rst !== undefined && rst !== NGHTTP2_NO_ERROR && !(signal?.aborted ?? false)) {
          if (rst === NGHTTP2_REFUSED_STREAM && !answered) return fail(new NotProcessed("REFUSED_STREAM"));
          fail(new NetworkError(`h2: stream reset (code ${rst})`));
        }
      });
      req.on("response", (h) => {
        answered = true;
        const status = Number(h[":status"]);
        const out = new Headers();
        for (const [k, v] of Object.entries(h)) if (!k.startsWith(":") && v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        out.set(LANE_HEADER, String(l.index));
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            req.on("data", (d: Buffer) => c.enqueue(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
            req.on("end", () => {
              signal?.removeEventListener("abort", onAbort);
              try {
                c.close();
              } catch {
                /* errored meanwhile */
              }
            });
          },
          cancel() {
            req.close(NGHTTP2_CANCEL);
          },
        });
        const nullBody = status === 204 || status === 304 || method === "HEAD";
        resolve(new Response(nullBody ? null : stream, { status, headers: out }));
      });
      req.setTimeout(0);
      if (body) void pump(body, req).catch((e) => req.destroy(e as Error));
    });

  /** `body()` makes the request body afresh for every attempt (a stream can be read once). */
  const run = async (url: URL, method: string, headers: Record<string, string>, body: (() => ReadableStream<Uint8Array> | null) | null, signal: AbortSignal | null | undefined, role: "up" | "down", lane?: number): Promise<Response> => {
    const g = group(url.origin, role, lane === undefined ? 1 : lane + 1);
    for (let tries = 0; ; tries++) {
      const l = await g.acquire(lane);
      try {
        const r = await onStream(g, l, url, method, headers, body ? body() : null, signal);
        // The stream slot is held until the body is read (or cancelled).
        return holdUntilRead(r, () => g.release(l));
      } catch (e) {
        g.release(l);
        if (e instanceof NotProcessed && tries < 3) {
          emit({ ev: "retry", origin: g.origin, role, lane: l.index, why: e.message });
          continue;
        }
        if (e instanceof NotProcessed) throw new NetworkError(`h2: not processed (${e.message})`);
        throw e;
      }
    }
  };

  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.protocol !== "https:" || noH2.has(url.origin)) return fallback(req);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const signal = init.signal ?? null;
    // The body (a webhook post: multipart with a ~10 MiB fragment) is streamed onto the connection, never
    // copied whole; an attempt the server did not process gets it serialized again from `init`.
    let first: Request | null = req;
    const body = req.body
      ? () => {
          const r = first ?? new Request(input, init);
          first = null;
          return r.body;
        }
      : null;
    return run(url, req.method, headers, body, signal, body ? "up" : "down");
  }) as H2Fetch;

  f.sendParts = async (u, init) => {
    const url = new URL(u);
    if (url.protocol !== "https:" || noH2.has(url.origin)) return fallback(u, { method: init.method, headers: init.headers, body: new Blob(init.parts as BlobPart[]), signal: init.signal });
    const len = init.parts.reduce((s, p) => s + p.byteLength, 0);
    const parts = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const p of init.parts) c.enqueue(p);
          c.close();
        },
      });
    return run(url, init.method, { ...lower(init.headers), "content-length": String(len) }, parts, init.signal, "up");
  };
  f.onLane = (lane) => async (u, init) => {
    const url = new URL(u);
    if (url.protocol !== "https:" || noH2.has(url.origin)) return fallback(u, init);
    return run(url, "GET", {}, null, init?.signal, "down", lane);
  };
  f.close = () => {
    for (const g of groups.values()) for (const l of g.lanes) l.session?.close();
    groups.clear();
  };
  f.stats = () => [...groups.values()].flatMap((g) => g.lanes.map((l) => ({ origin: g.origin, role: g.role, lane: l.index, alive: l.usable(), active: l.active, cap: l.cap })));
  return f;
}

/** Copy a body stream onto an HTTP/2 stream, waiting for the connection to drain (back-pressure). */
async function pump(body: ReadableStream<Uint8Array>, req: ClientHttp2Stream): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (req.destroyed) return void reader.cancel().catch(() => {});
      if (!req.write(value)) await new Promise<void>((r) => req.once("drain", r).once("close", r));
    }
    if (!req.destroyed) req.end();
  } finally {
    reader.releaseLock();
  }
}

const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

function abortErr(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error("aborted"), { name: "AbortError" });
}

/** Release the stream slot once the body is consumed, cancelled or fails (or at once when there is none). */
function holdUntilRead(r: Response, release: () => void): Response {
  if (!r.body) {
    release();
    return r;
  }
  let done = false;
  const once = () => {
    if (!done) ((done = true), release());
  };
  const reader = r.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const x = await reader.read();
        if (x.done) {
          once();
          c.close();
        } else c.enqueue(x.value);
      } catch (e) {
        once();
        c.error(e);
      }
    },
    cancel(why) {
      once();
      return reader.cancel(why);
    },
  });
  return new Response(body, { status: r.status, headers: r.headers });
}
