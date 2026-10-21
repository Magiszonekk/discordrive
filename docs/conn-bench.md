# conn-bench: one HTTP/2 connection vs many

Question: is the browser slow because it sends every request to discord.com / cdn.discordapp.com over
**one** HTTP/2 connection? A desktop agent (or the discordrive server) uses many connections.

Run on your own computer, in the repo directory (Node 22+, nothing to install):

    npm run conn-bench -- webhooks.txt

`webhooks.txt`: your webhook URLs, one per line — **one webhook per Discord channel** (webhooks in the
same channel share its limit). Use a test server: the script posts and then deletes test messages.

First it measures the line itself (speed.cloudflare.com, 8 parallel streams, ~8 s each way) and shows every
Discord result also as **% of line**. `--no-speedtest` skips that.

Options: `--count 30` fragments per scenario, `--conc 24` in flight, `--size 10` MiB per fragment,
`--scenarios h2-1,h2-N,h1-N`, `--pause 30` s between scenarios, `--no-download`, `--keep` (do not delete).

Scenarios (same work each time: upload `count` fragments through the webhooks, then download them from
the CDN):

| name | connections | like |
|---|---|---|
| h2-1 | one HTTP/2 connection for everything | the browser (web UI) |
| h2-N | one HTTP/2 connection per lane | a desktop agent |
| h1-N | HTTP/1.1, N sockets | the discordrive server |

Reading the result: if **h2-N / h1-N are clearly faster than h2-1**, the single connection is the limit
and a desktop app helps. If all three are about equal, the limit is per IP (or the line), and more
connections will not help. Upload is also capped by Discord: ~5 MB/s per channel (shown at the start).

If attempts fail, the reasons are listed at the end (HTTP status or connection error, never a URL); a
connection that Discord closes (HTTP/2 GOAWAY) is replaced by a new one.

Output: a table, and `conn-bench-<time>.json` without tokens or URLs. Ctrl+C cleans up the messages.

## Known: Node + one HTTP/2 connection + many large uploads

Measured 2026-10-15: 32 uploads of 10 MiB at once over ONE Node HTTP/2 connection to discord.com get their
streams reset by Discord/Cloudflare (`NGHTTP2_ENHANCE_YOUR_CALM`, `NGHTTP2_INTERNAL_ERROR`; 10 of 60 posted),
while the same 32 over separate connections (`h2-N`) all go through (60/60, 0 errors). Chromium's own HTTP/2
stack does not hit this (the web app posts 32 at once on one connection without errors). So the `h2-1`
**upload** row in Node is not a fair stand-in for the browser at high concurrency — compare uploads with
`h2-N` / `h1-N`, and use `h2-1` for downloads. A desktop agent must post over several connections.

## IP test with a proxy (`--proxy`, scenario `split`)

    npm run conn-bench -- webhooks.txt --count 200 --conc 32 --scenarios h2-N,split --proxy http://user:pass@host:port

`h2-N` first measures what this IP reaches alone with all channels. `split` then posts from this IP with
~70 % of the channels/fragments and, **at the same time**, through the proxy with the other ~30 %
(`--proxy-share`). Compare "split: both IPs" with `h2-N`: clearly more → Discord's ceiling is per IP; about the
same → it is not (route, line, or a limit per Discord server — all channels are in one guild).
Downloads are not split: they already reach the line from one IP.

## Browser: HTTP/3 (QUIC) vs HTTP/2, and several connections at once

Chromium-based browsers (Chrome, Brave, Edge) reach Discord over HTTP/3 (QUIC) once Discord's `alt-svc`
tells them to. On Linux that was the main limit of the web app:

- on a 111/69 MB/s line, the real app in Brave: ~20 MB/s both ways with QUIC (the default), 67 MB/s up and
  63 MB/s down with QUIC turned off (`--disable-quic`), 32 pieces in flight;
- on a 47/43 MB/s test machine, `scripts/live-transfer-bench.mts` (1 GB): download 25.6–26.8 MB/s over h3 vs
  31.7–32.0 over h2 (automatic pieces in flight), 21 vs 31–33 with 16 in flight.

More connections do not lift the QUIC limit. `scripts/browser-conn-exp.mts --ways 1,2,3` splits 32 downloads of
10 MiB over the page, a sandboxed iframe and a credentialless iframe; each of them got its own QUIC session
(the net log shows it), yet the total stayed the same (47/43 MB/s test machine, headless Chromium 151):

| download, 32 × 10 MiB | 1 connection | 2 connections | 3 connections |
|---|---|---|---|
| HTTP/3 (default) | 10.4–11.4 MB/s | 10.9–14.1 | 10.0–10.8 |
| HTTP/2 (`--disable-quic`) | 43.4–44.3 | 30.1–45.6 | 41.3–43.6 |

So the QUIC limit is shared by the whole browser (its network process), not per connection; extra connections
would only add work. The app therefore does not spread transfers over more connections; README and Settings →
Diagnostics say how to turn QUIC off (it affects every site). The second connection (`lane.html`) stays what it
was: a way around ONE stuck connection.

Commands (a test server's webhooks; every message is deleted at the end):

    CHROMIUM_PATH=/path/to/browser npx tsx scripts/live-transfer-bench.mts webhooks.txt --mb 1000 --down auto,16 --speedtest
    CHROMIUM_PATH=/path/to/browser npx tsx scripts/live-transfer-bench.mts webhooks.txt --mb 1000 --down auto,16 --browser-args "--disable-quic"
    npx tsx scripts/browser-conn-exp.mts webhooks.txt --chrome /path/to/browser --ways 1,2,3 --protos default,h2

## Desktop agent (`scripts/desktop-bench.mts`)

The desktop app's core and transport (AppCore on the Node platform, `h2Fetch`) uploading a 2000 MB file read
from disk and downloading it to disk, against 12 channels of a test server, on a VPS (line from
speed.cloudflare.com ~41 MB/s each way at the time). conn-bench on the same line and channels just before:
upload `h2-1` 3.2 MB/s (391 stream resets), `h2-N` 39.9 MB/s; download `h2-1` 43.8 MB/s, `h2-N` 20.5 MB/s.

| agent | upload MB/s | download MB/s | stream resets | peak RSS |
|---|---|---|---|---|
| 6 sessions × 6 streams, automatic pieces in flight | 16.9 | 40.9 | many (caps fell to 1–2) | 1.97 GB |
| 6 sessions × 6 streams, 32 / 32 in flight | 24.0 | 43.8 | many | 2.02 GB |
| **1 post per session (up to 32), body sent as parts, automatic** | 18.5 (ramp 3→24 over the file; 42 MB/s peak at 24) | 41.5 | 0 | 1.21 GB |
| **1 post per session, body sent as parts, 32 / 32** | **40.6** | **45.2** | 0 | 1.51 GB |

So with the same number of pieces in flight the agent reaches what conn-bench's `h2-N` / `h2-1` do on that line
(upload 40.6 vs 39.9, download 45.2 vs 43.8). One large post per HTTP/2 session is what makes uploads work:
several posts on one session are reset by Discord the way `h2-1` is. With the automatic value a new device
starts at 3 and doubles while it measures, which a single 2 GB file at 40 MB/s barely outlasts; the agent
keeps the value it learned (`net.json` in its data folder), so the next transfer starts there.
