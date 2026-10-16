// Resume after a reload. Upload: a "tab" dies midway (network gone for
// good); a new client on the same index + journal sends only the missing fragments, under the same upload ID,
// and the file is complete and correct. A changed file is not mixed in; a cancel forgets the journal.
// Download: stopped after k fragments, continued from k with the saved hash state → the same SHA-256.
import { describe, expect, it } from "vitest";
import { Sequencer, MemoryIndexStore } from "@ddv4/sync-core";
import { ChannelPacer, LocalArbiter, MemoryTransport, MetadataClient, memorySource, sha256Hex, type ByteSink, type ResumeStore } from "../src/index.js";

class MemResume implements ResumeStore {
  m = new Map<string, unknown>();
  async get(k: string) {
    return this.m.has(k) ? JSON.parse(JSON.stringify(this.m.get(k))) : undefined;
  }
  async put(k: string, v: unknown) {
    this.m.set(k, JSON.parse(JSON.stringify(v)));
  }
  async del(k: string) {
    this.m.delete(k);
  }
  async entries(p: string): Promise<[string, unknown][]> {
    return [...this.m].filter(([k]) => k.startsWith(p)).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]);
  }
  async delPrefix(p: string) {
    for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k);
  }
}
function data(n: number, seed = 0): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 13 + seed + (i >> 7)) & 255;
  return b;
}
function sink(): ByteSink & { all(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return { write: async (d) => void parts.push(new Uint8Array(d)), all: () => Buffer.concat(parts) };
}
const hooks = [0, 1].map((i) => ({ id: `15500000000000095${i}`, url: `mem://hook/${i}`, channelId: `chan-${i}` }));

function world() {
  const t = new MemoryTransport();
  const seq = new Sequencer();
  const resume = new MemResume();
  const store = new MemoryIndexStore();
  const mk = (s = store) =>
    new MetadataClient({ device: { id: "dev-r", name: "r" }, arbiter: new LocalArbiter(seq), transport: t, webhooks: hooks, store: s, chunkSize: 1000, maxRetries: 0, concurrency: 3, pacer: new ChannelPacer({ perMin: 1e6, maxPerMin: 1e6, burst: 1e6 }), sleep: async () => {}, resume });
  return { t, seq, resume, store, mk };
}

describe("resume", () => {
  it("upload: after a broken tab only the missing fragments are sent, same upload ID, file correct", async () => {
    const w = world();
    const src = data(20_000);
    const c1 = w.mk();
    w.t.beforePost = (n) => {
      if (n >= 9) throw new Error("webhook post: HTTP 500"); // the tab "dies": 9 posts got through
    };
    await expect(c1.upload(memorySource(src), "big.bin", undefined, { resumeKey: "k1" })).rejects.toThrow();
    const j = (await w.resume.get("up:k1")) as { uploadId: string };
    expect((await w.resume.entries("upf:k1:")).length).toBe(9);
    // a new tab: same device, the index caught up from the log (here: the same store), journal in IndexedDB
    w.t.beforePost = undefined;
    const before = w.t.posts;
    const c2 = w.mk();
    await c2.pull();
    const r = await c2.upload(memorySource(src), "big.bin", undefined, { resumeKey: "k1" });
    expect(r.uploadId).toBe(j.uploadId);
    expect(r.resumed).toBe(9);
    expect(w.t.posts - before).toBe(20 - 9 + 1); // missing fragments + the manifest
    expect(await w.resume.get("up:k1")).toBeUndefined();
    expect(await w.resume.entries("upf:k1:")).toEqual([]);
    const s = sink();
    await c2.download(r.nodeId, s);
    expect(await sha256Hex(s.all())).toBe(await sha256Hex(src));
  });

  it("upload: a changed file reuses only identical fragments; a cancel forgets the journal", async () => {
    const w = world();
    const c1 = w.mk();
    w.t.beforePost = (n) => {
      if (n >= 6) throw new Error("webhook post: HTTP 500");
    };
    await expect(c1.upload(memorySource(data(10_000)), "f.bin", undefined, { resumeKey: "k2" })).rejects.toThrow();
    w.t.beforePost = undefined;
    const changed = data(10_000);
    changed[2500] ^= 0xff; // fragment 2 differs
    const c2 = w.mk();
    const r = await c2.upload(memorySource(changed), "f.bin", undefined, { resumeKey: "k2" });
    expect(r.resumed).toBe(5); // 6 stored, 1 of them changed
    const s = sink();
    await c2.download(r.nodeId, s);
    expect(await sha256Hex(s.all())).toBe(await sha256Hex(changed));
    // cancel
    const ac = new AbortController();
    w.t.beforePost = (n) => {
      if (n === w.t.posts && n > 0) ac.abort();
    };
    await expect(c2.upload(memorySource(data(10_000, 3)), "g.bin", undefined, { resumeKey: "k3", signal: ac.signal })).rejects.toThrow();
    expect(await w.resume.get("up:k3")).toBeUndefined();
  });

  it("upload: an upload aborted meanwhile (cleanup took the lease) starts over instead of resuming", async () => {
    const w = world();
    const c1 = w.mk();
    w.t.beforePost = (n) => {
      if (n >= 3) throw new Error("webhook post: HTTP 500");
    };
    await expect(c1.upload(memorySource(data(5_000)), "f.bin", undefined, { resumeKey: "k4" })).rejects.toThrow();
    const j = (await w.resume.get("up:k4")) as { uploadId: string };
    // the cleaner (rule 8) takes the expired lease and aborts the upload
    expect(w.seq.renewLease(j.uploadId, "dev-r")).toBe(true);
    await c1.commitOp({ type: "upload_abort", uploadId: j.uploadId }, "abort");
    w.seq.releaseLease(j.uploadId, "dev-r");
    w.t.beforePost = undefined;
    const c2 = w.mk();
    await c2.pull();
    const r = await c2.upload(memorySource(data(5_000)), "f.bin", undefined, { resumeKey: "k4" });
    expect(r.uploadId).not.toBe(j.uploadId);
    expect(r.resumed).toBe(0);
  });

  it("download: continue from fragment k with the saved hash state; only the rest is fetched", async () => {
    const w = world();
    const c = w.mk();
    const src = data(15_500);
    const up = await c.upload(memorySource(src), "f.bin");
    let point: { versionId: string; next: number; hash: Uint8Array } | null = null;
    const ac = new AbortController();
    const s1 = sink();
    await expect(
      c.download(up.nodeId, s1, {
        signal: ac.signal,
        onWritten: (p) => {
          point = { versionId: p.versionId, next: p.next, hash: p.hash() };
          if (p.next === 7) ac.abort();
        },
      }),
    ).rejects.toThrow();
    expect(point!.next).toBe(7);
    const orig = w.t.fetchCdn.bind(w.t);
    let fetched = 0;
    w.t.fetchCdn = async (u) => (fetched++, orig(u));
    const s2 = sink();
    const at = point! as { versionId: string; next: number; hash: Uint8Array };
    await c.download(up.nodeId, s2, { resume: { versionId: at.versionId, from: at.next, hash: at.hash } });
    expect(fetched).toBe(16 - 7);
    const whole = Buffer.concat([s1.all().subarray(0, 7000), s2.all()]);
    expect(await sha256Hex(whole)).toBe(await sha256Hex(src));
    // a wrong hash state fails the check instead of writing a broken file
    const h = at.hash.slice();
    h[8] ^= 1; // inside the hash state (bytes 0–3 are a format header)
    await expect(c.download(up.nodeId, sink(), { resume: { versionId: at.versionId, from: at.next, hash: h } })).rejects.toThrow(/SHA-256/);
  });
});
