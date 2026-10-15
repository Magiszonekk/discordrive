# conn-bench: one HTTP/2 connection vs many (koncept §7.5.4)

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
