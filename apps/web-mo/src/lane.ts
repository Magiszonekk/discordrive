// A second connection to Discord's CDN for the web app: this page runs in a hidden
// <iframe sandbox="allow-scripts">.
// Its origin is opaque, so Chromium keys its connections apart from the app's (Network State
// Partitioning): the same request from here goes over ANOTHER HTTP/2 / HTTP/3 connection. Discord's CDN
// answers `Origin: null` with CORS for the fragment type we use (.txt).
//
// Protocol: the parent page sends ONE MessagePort ({ ddnLane: 1 }); the app worker then sends
// { id, url } to fetch and { id, abort: true } to cancel; answers are { id, st, ttfb, buf } (the body,
// transferred, not copied) or { id, err }. Nothing else is accepted: only the parent can hand over the
// port, and only https / the configured CDN origins may be fetched (the page's CSP limits it too).

const ctl = new Map<number, AbortController>();

function serve(port: MessagePort) {
  port.onmessage = async (e: MessageEvent<{ id: number; url?: string; abort?: boolean }>) => {
    const { id, url, abort } = e.data ?? ({} as { id: number });
    if (typeof id !== "number") return;
    if (abort) return void ctl.get(id)?.abort();
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return port.postMessage({ id, err: "bad url" });
    const ac = new AbortController();
    ctl.set(id, ac);
    const t0 = performance.now();
    try {
      const r = await fetch(url, { signal: ac.signal, credentials: "omit", cache: "no-store" });
      const ttfb = Math.round((performance.now() - t0) * 10) / 10;
      const buf = await r.arrayBuffer();
      port.postMessage({ id, st: r.status, ttfb, buf }, [buf]);
    } catch (err) {
      port.postMessage({ id, err: String((err as Error)?.message ?? err).slice(0, 120), aborted: ac.signal.aborted });
    } finally {
      ctl.delete(id);
    }
  };
}

let taken = false;
addEventListener("message", (e: MessageEvent) => {
  if (taken || e.source !== parent || !e.data || e.data.ddnLane !== 1 || !e.ports[0]) return;
  taken = true;
  serve(e.ports[0]);
});
parent.postMessage({ ddnLaneReady: 1 }, "*");
