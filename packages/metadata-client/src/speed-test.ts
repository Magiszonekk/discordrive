// Speed test of this device: the line (speed.cloudflare.com) and Discord through the account's own channels.
// Test fragments go through the same blob store as an upload (the same pacing per channel, the same window of
// pieces in flight and automatic value, the same retries), encrypted like a file's fragments with a throwaway
// key, and are read back the same way. Nothing touches the account: no operation in the log, no node, no
// lease, no snapshot; every test message is deleted at the end. The list of what was posted is kept in the
// resume store while the test runs (`st:` keys), so a test cut short (window closed, app quit) is cleaned up at
// the next start (cleanupLeftovers).
import { encryptFragment, newFileKey, sha256Hex } from "./file-crypto.js";
import type { DriveClient, ResumeStore } from "./drive-client.js";
import type { Placement } from "./types.js";
import { RateLimitedError } from "./discord-transport.js";

export interface SpeedTestOptions {
  /** Test fragments (default 32). */
  count?: number;
  /** Bytes per fragment (default: the client's fragment size, 10 MiB - 28). */
  size?: number;
  /** Skip the line test (speed.cloudflare.com). */
  noLine?: boolean;
  /** Only upload (the fragments are not read back) / only download (needs an upload first: always uploads). */
  only?: "up" | "down";
  /** Seconds per direction of the line test (default 8). */
  lineSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (p: SpeedTestProgress) => void;
}

export interface SpeedTestProgress {
  stage: "line-down" | "line-up" | "up" | "down" | "cleanup";
  /** Bytes so far in this stage. */
  bytes: number;
  /** Planned bytes of this stage (0: by time). */
  total: number;
  /** MB/s of this stage so far. */
  mbps: number;
  /** Pieces in flight now (Discord stages). */
  inFlight?: number;
}

export interface SpeedTestResult {
  at: number;
  build: string | null;
  platform: string;
  line: { down: number; up: number } | null;
  discord: {
    up: number | null;
    down: number | null;
    /** Share of the line (0..1), when both are known. */
    upShare: number | null;
    downShare: number | null;
    channels: number;
    fragments: number;
    fragmentBytes: number;
    /** Pieces in flight: the setting (auto / a number) and the highest reached. */
    concUp: { auto: boolean; start: number; max: number };
    concDown: { auto: boolean; start: number; max: number };
    rateLimited: number;
    errors: number;
    deleted: number;
    leftOver: number;
  };
  /** Short explanation keys (the UI words them): why it is as fast as it is. */
  hints: SpeedHint[];
}

export type SpeedHint =
  | { k: "channels"; perChannel: number; channels: number }
  | { k: "browser-h3"; down: number }
  | { k: "line-full"; dir: "up" | "down"; share: number }
  | { k: "rate-limited"; n: number }
  | { k: "errors"; n: number }
  | { k: "metered" };

const KEY_PREFIX = "st:";
const MBPS = (b: number, ms: number) => (ms > 0 ? b / 1e6 / (ms / 1000) : 0);

/**
 * Delete one test message, trying again: a 429 waits what Discord asks (at most a minute), another failure
 * backs off (1, 2, 4, 8 s). True: deleted or already gone. Deletes are not paced like posts, so a burst of
 * them right after a test meets the channel's limit; giving up at the first 429 left messages behind.
 */
export async function removeTestMessage(remove: (p: Placement) => Promise<unknown>, p: Placement, signal?: AbortSignal, tries = 5): Promise<boolean> {
  for (let a = 0; a < tries; a++) {
    try {
      await remove(p);
      return true;
    } catch (e) {
      if (/404|Unknown Message|gone/i.test(String((e as Error)?.message ?? e))) return true;
      if (a === tries - 1 || signal?.aborted) return false;
      const ms = e instanceof RateLimitedError ? Math.min(60_000, Math.max(250, e.retryAfterMs)) : 1000 * 2 ** a;
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  return false;
}

/**
 * Delete what an earlier test left (cut short, or deletes that failed then): returns how many messages were
 * deleted. An entry leaves the list only when its message is gone; a failure keeps it for the next start.
 */
export async function cleanupLeftovers(client: Pick<DriveClient, "blobs">, store: ResumeStore): Promise<number> {
  const remove = (client.blobs as { remove?(p: Placement): Promise<unknown> }).remove?.bind(client.blobs);
  if (!remove) return 0;
  let n = 0;
  for (const [k, v] of await store.entries(KEY_PREFIX).catch(() => [] as [string, unknown][])) {
    if (await removeTestMessage(remove, v as Placement)) {
      n++;
      await store.del(k).catch(() => {});
    }
  }
  return n;
}

/** The line: download / upload streams to speed.cloudflare.com for `seconds` each way. */
export async function lineSpeed(f: typeof fetch, seconds = 8, signal?: AbortSignal, onProgress?: SpeedTestOptions["onProgress"]): Promise<{ down: number; up: number }> {
  const run = async (up: boolean) => {
    const t0 = Date.now();
    const end = t0 + seconds * 1000;
    let bytes = 0;
    const tick = () => onProgress?.({ stage: up ? "line-up" : "line-down", bytes, total: 0, mbps: MBPS(bytes, Date.now() - t0) });
    const body = up ? new Uint8Array(8_000_000) : null;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (Date.now() < end && !signal?.aborted) {
          try {
            if (up) {
              const r = await f("https://speed.cloudflare.com/__up", { method: "POST", body: body as BodyInit, signal });
              if (r.ok) bytes += body!.byteLength;
              await r.arrayBuffer().catch(() => null);
            } else {
              const r = await f("https://speed.cloudflare.com/__down?bytes=25000000", { signal });
              const rd = r.body?.getReader();
              if (!rd) break;
              for (;;) {
                const x = await rd.read();
                if (x.done) break;
                bytes += x.value.byteLength;
                if (Date.now() > end) {
                  await rd.cancel().catch(() => {});
                  break;
                }
              }
            }
          } catch {
            if (signal?.aborted) break;
            await new Promise((r) => setTimeout(r, 300));
          }
          tick();
        }
      }),
    );
    return MBPS(bytes, Date.now() - t0);
  };
  const down = await run(false);
  const up = await run(true);
  return { down, up };
}

/**
 * Discord through the client's channels: `count` fragments up (as an upload: the window, pacing, retries),
 * then read back (as a download), then deleted. Returns the numbers; deletes everything also when cancelled
 * or failed (the cleanup list survives a crash in `store`).
 */
export async function discordSpeed(
  client: DriveClient,
  store: ResumeStore | null,
  o: SpeedTestOptions & { onPlaced?: (n: number) => void } = {},
): Promise<{ up: number | null; down: number | null; posted: Placement[]; rateLimited: number; errors: number; deleted: number; leftOver: number; maxUp: number; maxDown: number; startUp: number; startDown: number }> {
  const count = Math.max(1, Math.min(200, o.count ?? 32));
  const size = Math.max(1024, Math.min(o.size ?? client.fragmentSize, 25 * 1024 * 1024 - 28));
  const signal = o.signal;
  const key = await newFileKey();
  const blobs = client.blobs;
  const posted: (Placement | null)[] = new Array(count).fill(null);
  let rateLimited = 0;
  let errors = 0;
  const net = client.net;
  client.syncWindows();
  const startUp = client.uploadConcurrency;
  const startDown = client.downloadConcurrency;
  let maxUp = 0;
  let maxDown = 0;
  const autoUp = client.autoConcurrency.upload && !net.metered();
  const autoDown = client.autoConcurrency.download && !net.metered();

  // One plaintext buffer reused (random once): the encryption makes every fragment different on the wire.
  const plain = crypto.getRandomValues(new Uint8Array(Math.min(size, 65536)));
  const full = new Uint8Array(size);
  for (let off = 0; off < size; off += plain.byteLength) full.set(plain.subarray(0, Math.min(plain.byteLength, size - off)), off);

  let up: number | null = null;
  let down: number | null = null;
  const remove = (blobs as { remove?(p: Placement): Promise<unknown> }).remove?.bind(blobs);
  const forget = async (i: number) => store?.del(`${KEY_PREFIX}${i}`).catch(() => {});
  let deleted = 0;
  try {
    // ── upload ──
    let next = 0;
    let sent = 0;
    const t0 = Date.now();
    const report = () => o.onProgress?.({ stage: "up", bytes: sent, total: count * size, mbps: MBPS(sent, Date.now() - t0), inFlight: net.win.up.inUse });
    const worker = async () => {
      for (;;) {
        const free = await net.win.up.acquire(signal);
        const i = next++;
        if (i >= count || signal?.aborted) return free();
        try {
          const ct = await encryptFragment(key, full);
          const tk = autoUp ? net.tune.up.begin() : null;
          maxUp = Math.max(maxUp, net.win.up.inUse);
          try {
            const p = await blobs.put(ct, `st-${crypto.randomUUID()}.txt`, { index: i, sha256: await sha256Hex(ct), signal, stats: { posts: 0 } });
            posted[i] = p;
            await store?.put(`${KEY_PREFIX}${i}`, p).catch(() => {});
            if (tk) net.tune.up.end(tk, ct.byteLength, next < count);
          } catch (e) {
            if (tk) net.tune.up.drop(tk);
            if (e instanceof RateLimitedError) rateLimited++;
            throw e;
          }
          sent += size;
          report();
        } finally {
          free();
        }
      }
    };
    const workers = Math.min(count, Math.max(net.win.up.max, client.autoCap("up")));
    const results = await Promise.allSettled(Array.from({ length: workers }, worker));
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const failed = results.filter((r) => r.status === "rejected");
    errors += failed.length;
    if (posted.every((p) => !p)) throw (failed[0] as PromiseRejectedResult | undefined)?.reason ?? new Error("nothing was stored");
    up = MBPS(sent, Date.now() - t0);
    o.onPlaced?.(posted.filter(Boolean).length);

    // ── download ──
    if (o.only !== "up") {
      const have = posted.filter((p): p is Placement => !!p);
      await blobs.prefetch?.(have, { x: "speedtest", first: 0 }).catch(() => {});
      let k = 0;
      let got = 0;
      const t1 = Date.now();
      const rep = () => o.onProgress?.({ stage: "down", bytes: got, total: have.length * size, mbps: MBPS(got, Date.now() - t1), inFlight: net.win.down.inUse });
      const reader = async () => {
        for (;;) {
          const free = await net.win.down.acquire(signal);
          const i = k++;
          if (i >= have.length || signal?.aborted) return free();
          try {
            const tk = autoDown ? net.tune.down.begin() : null;
            maxDown = Math.max(maxDown, net.win.down.inUse);
            try {
              const b = await blobs.get(have[i]!, signal, { x: "speedtest", i });
              if (tk) net.tune.down.end(tk, b.byteLength, k < have.length);
              got += b.byteLength - 28;
            } catch (e) {
              if (tk) net.tune.down.drop(tk);
              if (e instanceof RateLimitedError) rateLimited++;
              throw e;
            }
            rep();
          } finally {
            free();
          }
        }
      };
      const n = Math.min(have.length, Math.max(net.win.down.max, client.autoCap("down")));
      const rr = await Promise.allSettled(Array.from({ length: n }, reader));
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      errors += rr.filter((r) => r.status === "rejected").length;
      down = MBPS(got, Date.now() - t1);
    }
  } finally {
    // ── delete every test message (also after a cancel or a failure) ──
    if (remove) {
      const all = posted.map((p, i) => [p, i] as const).filter((x): x is readonly [Placement, number] => !!x[0]);
      let done = 0;
      // Two at a time, each tried again after a 429 (a cancel does not stop the clean-up).
      await Promise.all(
        Array.from({ length: 2 }, async () => {
          for (;;) {
            const x = all.shift();
            if (!x) return;
            const ok = await removeTestMessage(remove, x[0]);
            if (ok) {
              deleted++;
              await forget(x[1]);
            }
            done++;
            o.onProgress?.({ stage: "cleanup", bytes: done, total: posted.filter(Boolean).length, mbps: 0 });
          }
        }),
      );
    }
  }
  const leftOver = posted.filter(Boolean).length - deleted;
  return { up, down, posted: posted.filter((p): p is Placement => !!p), rateLimited, errors, deleted, leftOver, maxUp, maxDown, startUp, startDown };
}

/** Why it is as fast as it is (the known causes): a few keys the UI words. */
export function speedHints(r: { line: { down: number; up: number } | null; up: number | null; down: number | null; channels: number; rateLimited: number; errors: number; browser: boolean; metered: boolean }): SpeedHint[] {
  const h: SpeedHint[] = [];
  if (r.metered) h.push({ k: "metered" });
  if (r.rateLimited > 0) h.push({ k: "rate-limited", n: r.rateLimited });
  if (r.errors > 0) h.push({ k: "errors", n: r.errors });
  const line = r.line;
  if (r.up !== null && line && line.up > 0 && r.up / line.up >= 0.85) h.push({ k: "line-full", dir: "up", share: r.up / line.up });
  // ~5 MB/s per channel is what Discord gives one channel (30 posts a minute of 10 MiB): below the line, more channels help.
  else if (r.up !== null && r.channels > 0 && r.up / r.channels >= 3.5 && (!line || r.up < line.up * 0.85)) h.push({ k: "channels", perChannel: r.up / r.channels, channels: r.channels });
  if (r.down !== null && line && line.down > 0 && r.down / line.down >= 0.85) h.push({ k: "line-full", dir: "down", share: r.down / line.down });
  else if (r.down !== null && r.browser && r.down < 25 && line && line.down > 50) h.push({ k: "browser-h3", down: r.down });
  return h;
}
