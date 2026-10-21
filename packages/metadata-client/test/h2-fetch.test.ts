// h2Fetch (the agent's HTTP/2 transport) against a local HTTP/2 TLS server that can misbehave like
// Discord: separate sessions for uploads, one for downloads, GOAWAY mid-transfer (no request lost, the
// dead session never reused), REFUSED_STREAM (sent again, the session's stream cap lowered).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http2, { type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { h2Fetch, LANE_HEADER, type H2Event } from "../src/node/h2-fetch.js";

let origin = "";
let ca = "";
let server: http2.Http2SecureServer;
const sessions = new Set<ServerHttp2Session>();
/** Behaviour of the next requests (tests set it). */
let mode: { goawayAfter?: number; refuseFirst?: number; delayMs?: number } = {};
let seen = 0;
let refused = 0;
const sessionOfReq: ServerHttp2Session[] = [];

beforeAll(async () => {
  const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ddn-h2-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(d, "k"), "-out", join(d, "c"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  ca = readFileSync(join(d, "c"), "utf8");
  server = http2.createSecureServer({ key: readFileSync(join(d, "k")), cert: ca, settings: { maxConcurrentStreams: 100 } });
  server.on("session", (s) => {
    sessions.add(s);
    s.on("close", () => sessions.delete(s));
  });
  server.on("stream", (st: ServerHttp2Stream, h) => {
    st.on("error", () => {});
    const n = ++seen;
    if (mode.refuseFirst && refused < mode.refuseFirst) {
      refused++;
      st.close(http2.constants.NGHTTP2_REFUSED_STREAM);
      return;
    }
    const chunks: Buffer[] = [];
    st.on("data", (c: Buffer) => chunks.push(c));
    st.on("end", () => {
      sessionOfReq.push(st.session as ServerHttp2Session);
      const body = Buffer.concat(chunks);
      setTimeout(() => {
        if (st.closed) return;
        st.respond({ ":status": 200, "content-type": "application/json" });
        st.end(JSON.stringify({ path: h[":path"], method: h[":method"], len: body.length }));
        if (mode.goawayAfter && n === mode.goawayAfter) st.session?.goaway(http2.constants.NGHTTP2_NO_ERROR);
      }, mode.delayMs ?? 5);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  for (const s of sessions) s.destroy();
  server.close();
});

function reset() {
  mode = {};
  seen = 0;
  refused = 0;
  sessionOfReq.length = 0;
}

describe("h2Fetch", () => {
  it("uploads spread over separate sessions (one post each), downloads share one", async () => {
    reset();
    mode.delayMs = 50;
    // Default: one large post per session, sessions opened as posts are in flight.
    const f = h2Fetch({ tls: { ca } });
    const ups = await Promise.all(Array.from({ length: 8 }, (_, i) => f(`${origin}/up/${i}`, { method: "POST", body: new Uint8Array(1000 + i) })));
    const upLanes = new Set(ups.map((r) => r.headers.get(LANE_HEADER)));
    const bodies = await Promise.all(ups.map((r) => r.json() as Promise<{ len: number }>));
    expect(bodies.map((b) => b.len).sort()).toEqual(Array.from({ length: 8 }, (_, i) => 1000 + i));
    expect(upLanes.size).toBe(8);
    expect(new Set(sessionOfReq).size).toBe(8);
    // Two posts at a time afterwards: the sessions already open are reused, no new ones.
    sessionOfReq.length = 0;
    for (let k = 0; k < 3; k++) await Promise.all([0, 1].map((i) => f(`${origin}/up/again${k}${i}`, { method: "POST", body: new Uint8Array(10) }).then((r) => r.json())));
    expect(f.stats().filter((s) => s.role === "up" && s.alive)).toHaveLength(8);

    sessionOfReq.length = 0;
    const downs = await Promise.all(Array.from({ length: 10 }, (_, i) => f(`${origin}/down/${i}`).then((r) => r.json())));
    expect(downs).toHaveLength(10);
    expect(new Set(sessionOfReq).size).toBe(1);
    const st = f.stats();
    expect(st.filter((s) => s.role === "up" && s.alive)).toHaveLength(8);
    expect(st.filter((s) => s.role === "down" && s.alive)).toHaveLength(1);
    f.close();
  });

  it("GOAWAY: the session is dropped, later requests go to a fresh one, none is lost", async () => {
    reset();
    mode.goawayAfter = 3;
    const events: H2Event[] = [];
    const f = h2Fetch({ tls: { ca }, onEvent: (e) => events.push(e) });
    const out: number[] = [];
    for (let i = 0; i < 6; i++) out.push(((await (await f(`${origin}/down/${i}`)).json()) as { path: string }).path.length);
    expect(out).toHaveLength(6);
    expect(events.some((e) => e.ev === "dead" && /goaway/.test(e.why))).toBe(true);
    expect(events.filter((e) => e.ev === "open" && e.role === "down").length).toBe(2);
    // Requests after the GOAWAY were all served by the second session.
    expect(new Set(sessionOfReq.slice(3)).size).toBe(1);
    expect(sessionOfReq[3]).not.toBe(sessionOfReq[0]);
    f.close();
  });

  it("REFUSED_STREAM: sent again, and the session takes fewer streams at once", async () => {
    reset();
    mode.refuseFirst = 2;
    mode.delayMs = 30;
    const events: H2Event[] = [];
    const f = h2Fetch({ upSessions: 1, upStreams: 6, tls: { ca }, onEvent: (e) => events.push(e) });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => f(`${origin}/up/${i}`, { method: "POST", body: new Uint8Array(10) }).then((r) => r.json())));
    expect(rs).toHaveLength(6);
    expect(events.filter((e) => e.ev === "retry").length).toBe(2);
    const cap = f.stats().find((s) => s.role === "up")!.cap;
    expect(cap).toBeLessThan(6);
    f.close();
  });

  it("http:// goes through the fallback fetch", async () => {
    let called = 0;
    const f = h2Fetch({ fallback: async () => (called++, new Response("ok")) });
    expect(await (await f("http://127.0.0.1:9/x")).text()).toBe("ok");
    expect(called).toBe(1);
  });

  it("abort before the answer rejects with AbortError and frees the slot", async () => {
    reset();
    mode.delayMs = 500;
    const f = h2Fetch({ tls: { ca }, downStreams: 1 });
    const ac = new AbortController();
    const p = f(`${origin}/slow`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    mode.delayMs = 5;
    expect(await (await f(`${origin}/after`)).json()).toMatchObject({ path: "/after" });
    f.close();
  });
});
