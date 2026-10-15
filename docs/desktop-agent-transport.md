# Desktop agent transport requirements (Node)

Status: requirements only, no code. Covers the background "ddn agent" process for
the desktop app (koncept.md §7.5.4, stage 2: web UI in a wrapper + local Node agent on
the same packages as the CLI — metadata-client, sync-core, SQLite). Scope: how the
agent talks to Discord (webhooks + CDN) over the network. Source order:
`zlecenie-2026-10-15-transfery.md` §4 (this document's mandate), koncept.md §7.5.4
(measurements and decision), `conn-bench.md` / `scripts/conn-bench.mjs` (Node
connection benchmark), `docs/evidence/2026-10-15-connections/README.md` (browser
connection experiment), `docs/transfer-log.md` (log format to reuse).

## 1. Why the agent cannot just copy the browser

The browser and a Node agent hit different ceilings on the owner's line (~110 MB/s
down / ~68 MB/s up, speed.cloudflare.com):

| path | measured | source |
|---|---|---|
| Browser download, 32 in flight, one HTTP/2 connection | ~14 MB/s for 150 s (stuck connection), then 57–77 MB/s after it was dropped | zlecenie §(browser 5.37 GB test) |
| Browser upload, one connection | ~38–40 MB/s, 0×429 | zlecenie, koncept §7.5.4 |
| Node download, ONE HTTP/2 connection, 1 minute | 112 MB/s (102% of line) | koncept §7.5.4 (second conn-bench run) |
| Node download, N HTTP/2 connections | 63 MB/s (worse) | koncept §7.5.4 |
| Node upload, one HTTP/2 connection | ~31–40 MB/s; 32×10 MiB on one connection → `RST_STREAM` (`ENHANCE_YOUR_CALM`, `INTERNAL_ERROR`) | koncept §7.5.4, conn-bench.md |
| Node upload, several separate HTTP/2 connections (`h2-N`) | 61.1 MB/s (489 Mb/s, 91% of 67.4 MB/s line), 0 errors; same 32×10 MiB all pass | koncept §7.5.4 (third conn-bench run, with a VPS proxy) |
| Node upload, split across two IPs (direct + proxy) | 42.7 + 18.3 = 61.1 MB/s total — same as one IP | koncept §7.5.4 → **no per-IP limit on upload** |
| Node upload, HTTP/1.1, N sockets (`h1-N`) | ~34.9 MB/s, within ~15% of `h2-N` | koncept §7.5.4, conn-bench.md |

Conclusion used throughout this document: **upload needs several separate
connections** (Discord/Cloudflare resets streams on one HTTP/2 connection at high
concurrency); **download is better on one connection** (more connections made it
worse in Node). The browser's 14 MB/s download case is attributed to it being stuck
on one slow/failing HTTP/2 connection to `cdn.discordapp.com`, not to a fundamental
one-connection limit — Node on one connection reached the full line.

## 2. Upload: connection pool

- MUST open a small pool of separate HTTP/2 sessions ("lanes"), one TCP connection
  per session — not one session with many concurrent streams. Suggested pool size:
  4–8 sessions, tunable.
- MUST cap concurrent large-upload streams per session (suggested 4–8). Discord resets
  streams past some concurrency on one connection (`conn-bench.md` §"Known: Node +
  one HTTP/2 connection + many large uploads": 10 of 60 posts reset on `h2-1` at 32
  concurrent, 60/60 pass on `h2-N`/`h1-N`).
- SHOULD fall back to HTTP/1.1 with N sockets per channel if HTTP/2 is unusable
  (matches the discordrive server's own approach: N sockets, ~same speed per
  `h1-N` measurement — within ~15% of `h2-N`).
- MUST target total upload throughput near the device's own upload line (observed
  ceiling with no per-IP limiting: 61.1 MB/s = 91% of a 67.4 MB/s line). Do not assume
  a fixed MB/s number — scale by the measured line/baseline (see §5).
- MUST NOT treat a single IP as rate-limited by Discord for upload: splitting traffic
  across two IPs produced the same total throughput as one IP, so there is no benefit
  in spreading uploads across source IPs.

## 3. Download: single connection by default

- MUST download over ONE HTTP/2 connection per host by default. This reached 112
  MB/s (102% of a 110 MB/s line) for a full minute in Node; adding more connections
  measured worse (63 MB/s).
- MUST NOT default to N parallel download connections "for speed" — the evidence
  says the opposite for Node.
- MUST open a second download connection only when the stuck-connection guard (§4)
  decides the first one is stuck, never as a default parallelism strategy.

## 4. Stuck-connection guard (same rules as web)

Same mechanism and thresholds as the web app's guard (`zlecenie-2026-10-15-transfery.md`
§3), applied per connection the agent manages:

- MUST NOT use fixed MB/s thresholds. Users have very different lines.
- MUST maintain a device baseline from real transfers only (no separate speed test):
  a conservative estimate, e.g. the median of recent peak speeds, kept separately for
  upload and download, aging over time (do not assume a peak from a different network,
  e.g. home vs. mobile hotspot, still applies).
- MUST disable the guard entirely when:
  - the baseline is below ~5 MB/s (one connection already saturates a link that slow —
    nothing to gain from replacing it);
  - the connection is metered / "save data" is on (§5);
  - the user has turned the guard off in settings;
  - there is no baseline yet (new device — collect data first);
  - errors, 429s, or offline are currently happening (that is a weak link or a rate
    limit, not a stuck connection — see §2/§3 distinction in the web requirements).
- MUST detect a stuck connection only after a warm-up (~20 s), then: throughput below
  ~40% of baseline for ~30 s, with no errors and no 429s, AND a fast first byte but a
  long total fragment time (the "narrow pipe" signature: everything is sharing one
  slow connection).
- MUST test with a real, needed fragment on a fresh connection instead of aborting
  anything — the probe fragment is a fragment that was going to be fetched anyway, so
  the guard costs ~0 extra bytes.
- MUST switch only NEW requests to the new connection when it is clearly faster
  (≥ 2x the per-fragment speed of the old one); in-flight requests on the old
  connection MUST be allowed to finish there, never aborted by the guard.
- MUST treat "new connection is about the same speed" as "this is the line, not a
  stuck connection": do nothing, and do not retry the probe sooner than a few minutes.
- MUST NOT send any additional bytes beyond the one probe fragment per guard cycle.

## 5. GOAWAY / RST_STREAM / session errors

- MUST mark a session dead immediately on GOAWAY, a session-level error, or repeated
  stream resets, and MUST open a fresh session for further work instead of reusing it.
  `conn-bench` lost 111 uploads before this fix was applied — reusing a connection
  Discord has already started closing silently drops requests.
- MUST retry the in-flight fragment that was on the dead session, on a new session —
  never drop it silently.
- MUST classify `REFUSED_STREAM` / `ENHANCE_YOUR_CALM` specifically as "too many
  concurrent streams on this connection" and respond by lowering that session's
  stream cap (not by treating it as a generic network error, and not by abandoning
  the connection strategy altogether).

## 6. Weak-link mechanisms (same as web, koncept §7.5.4 reuses §2 of the order)

The agent MUST implement the same mechanisms required for the web client in
`zlecenie-2026-10-15-transfery.md` §2, applied to its own connections:

- **Adaptive in-flight window (AIMD)**, separate for upload and download: halve the
  window on network errors/timeouts, at most once per window, floor of 2; on a
  stable window with no errors, increase by 1 up to a configured (or auto) maximum.
- **Offline detection**: OS network-change events plus recognizing a run of network
  errors ⇒ pause the transfer queue, surface a "waiting for network" state, resume
  automatically when connectivity returns; retries use exponential backoff with
  jitter, never flooding requests.
- **Resume after restart**: unlike the browser (which resumes only within a page
  session unless OPFS/File System Access state exists), the agent has the files on
  disk, so it MUST persist:
  - an upload journal: which fragments have already been placed (webhook message /
    attachment reference) plus the running SHA-256 state, so a restarted upload does
    not re-send completed fragments or recompute the whole hash from scratch;
  - a download journal: which fragments have already been written, with writes going
    to the target file at the correct byte offset (not purely sequential/streamed),
    so a restarted download can skip completed fragments.
- **Metered connection / save-data**: detect Windows `NetworkCostType`, Linux
  NetworkManager's `metered` property, or macOS `NWPath.isExpensive`, plus a user
  "save data" setting. When on: smaller default in-flight window, stuck-connection
  guard forced off, and no background snapshots or trash cleanup (koncept already
  specifies this for the device in general — the agent must not override it just
  because it runs when the UI is closed).

## 7. Per-channel pacing and 429 handling (unchanged)

- The Discord rate limit is per channel (~30 posts/min, roughly ~5 MB/s/channel for
  10 MiB fragments; koncept measurements, §7 of koncept.md), not per webhook. The
  agent MUST keep the same per-channel pacer/limiter design as the server and
  browser, spreading fragments across the account's channels — adding more
  connections per channel does not raise that channel's own message-rate ceiling.
- MUST handle 429s via `retry_after`; MUST treat a Cloudflare HTML 429 response (as
  opposed to Discord's own JSON 429) as a long block and back off accordingly, since
  it indicates the IP is being rate-limited by Cloudflare rather than the per-channel
  Discord limit.
- The connection pool from §2 does not replace this limiter — it is an additional,
  orthogonal layer (how many sockets move the bytes vs. how fast one channel may be
  posted to).

## 8. Transfer log and reporting

- The agent MUST emit the same transfer-log events and format (v1, see
  `docs/transfer-log.md`) as the web app, using `src: "agent"` for its own log lines
  (the log format already names `"cli"` for the CLI — the agent is a third source
  alongside it and `"web"`).
- MUST add a `conn` (connection/session id) field to `req` events so a
  `transfer-report` run over agent logs can show per-connection throughput and
  isolate a stuck connection after the fact, not just per-channel/per-fragment
  numbers.
- MUST support `transfer-report` over its own log files the same way it works over
  browser/CLI logs today (`npm run transfer-report -- <files>`).
- MUST follow the same privacy rules as `docs/transfer-log.md` §Privacy: no webhook
  URLs/tokens, no CDN links (host only), no file contents or keys, errors scrubbed.

## 9. Measurements to repeat in the agent

Before building, and again once the agent's connection pool/guard exist, repeat:

    npm run conn-bench -- webhooks.txt --count 200 --conc 32

to confirm `h2-N` upload throughput and 0-error behavior on the owner's current line,
and to re-check the per-session stream cap against any Discord-side changes.

    npx tsx scripts/browser-conn-exp.mts webhooks.txt --channel chrome --n 64 --n-up 32

to keep the browser-side baseline (single vs. two-lane download/upload) comparable
to the agent's numbers, so the app can still tell the user how much faster the
desktop agent is versus the web UI (koncept §7.5.4 decision: web UI stays, with a
note that it's slower than the desktop app).

Re-run both after any Discord/Cloudflare-side behavior change (new error codes, new
per-connection limits) since these numbers are empirical, not documented by Discord.

## 10. References

| claim | source |
|---|---|
| Stage/decision: desktop app = web UI wrapper + local Node agent, stage 2 | `koncept.md` §7.5.4 |
| Line speed, Node single/N connection results, upload RST_STREAM, no per-IP limit | `koncept.md` §7.5.4 (conn-bench runs 1–3) |
| This document's mandate and required content | `zlecenie-2026-10-15-transfery.md` §4 |
| Per-channel limit (~30/min), weak-link mechanisms (§2), stuck-connection guard rules (§3) | `zlecenie-2026-10-15-transfery.md` §2, §3 |
| conn-bench scenarios (`h2-1`/`h2-N`/`h1-N`), GOAWAY/RST_STREAM handling, 111-upload loss, proxy/IP split test | `docs/conn-bench.md` |
| Browser second-connection experiment (sandboxed iframe, HTTP/3 default, per-context connection map) | `docs/evidence/2026-10-15-connections/README.md` |
| Transfer log format, fields, privacy rules | `docs/transfer-log.md` |
