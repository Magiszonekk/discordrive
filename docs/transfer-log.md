# Transfer logs (format v1)

Diagnostics for uploads and downloads (zlecenie 2026-10-13-transfer §2): where the time goes
(the limiter, the network, the device), how often Discord answers 429, how many pieces are in
flight. Off by default everywhere.

## Turning it on and getting the file

| Where | How | File |
|---|---|---|
| Browser (every mode) | Settings → Diagnostics → **Record transfer logs** | **Download logs** gives `discordrive-transfers-<time>.jsonl.gz` (gzip when the browser can, else `.jsonl`) |
| Instance, e2ee / plain | the same switch also turns on the instance's part **for your account** (`POST /v1/diagnostics/transfer-log`); an administrator can log every account with `"transferLogs": true` in `config.json` | `<data dir>/logs/transfers-YYYY-MM-DD.jsonl` (UTC day, files 0600, oldest deleted past 200 MB). **Download logs** in the browser includes your account's server lines in the same file |
| CLI `ddn` | `--transfer-log <file>` (`--transfer-log-names` for names) | appends to `<file>` |

The browser keeps its log in OPFS (`ddn-transfer-logs/`, parts of ≤ 8 MB, ≤ 50 MB together, the
oldest part goes first); every tab writes its own parts, the download joins all of them. **Clear**
deletes the browser's parts and hides the older server lines of your account (the shared day files
of the instance are rotated, not rewritten).

The switch is remembered per browser (localStorage `ddn.transferLog`); after a reload logging
continues.

## Summary

    npm run transfer-report -- discordrive-transfers-….jsonl.gz [more files] [--bucket 10] [--csv out]
    discordrive transfer-report <files>        # same, from the instance CLI

Text on stdout: files and average speed per direction, request times (p50/p90/p99, time to first
byte), the average time per fragment split into limiter wait / requests / read / encryption / hash /
decryption / write, 429s (scope, retry_after, per channel, per minute), errors, pieces in flight
(time-weighted average and max vs the configured value), throughput per bucket in total and per
channel. CSV: `<prefix>.timeline.csv` (bucket × channel: MB/s, Mb/s, bytes, 429s) and
`<prefix>.files.csv` (one row per file).

## Privacy

Never written: webhook URLs or tokens, CDN links (only the host, `host`), signatures, file contents,
the account key. File names only with **Include file names** (`name`); otherwise only the extension
(`ext`). IDs are written (webhook, channel, upload/transfer, account on the server): they cannot be
used to post or to read without the token or the key. Error texts are scrubbed: every URL becomes
`<url:host>`, long base64/hex runs become `<long>`, ≤ 200 characters. Tests grep the logs for the
webhook tokens and URL patterns (`metadata-client/test/transfer-log.test.ts`,
`server-discord/test/transfer-logs.test.ts`, `web-mo/check.ts` step "download").

## Format

JSON Lines: one JSON object per line, UTF-8, `\n`. Times are ms since the Unix epoch with 0.1 ms
resolution; durations are ms (0.1). Sizes in bytes. **Later versions only add fields** (the logs taken
before the performance work stay comparable).

Every line:

| field | meaning |
|---|---|
| `v` | format version (1) |
| `t` | time the event was written (for `frag`/`req`/`file_end`: its end) |
| `src` | `web` (browser), `cli`, `server` (instance, e2ee/plain) |
| `ev` | event, below |
| `acct` | server lines only: the account |
| `dir` | `up` / `down` |
| `x` | transfer ID = the upload ID of the file version (the same on the client and the server, also for a download) |

### `file_start` / `file_end` (per file)

`file_start`: `size`, `n` fragments, `chunk` (plaintext fragment size), `conc` fragments in flight
allowed, `lanes` (upload: channels the store spreads over; added 2026-10-14), `mode` (`metadata-only` / `e2ee` / `plain`), `ext`, `name` (only with names on).

`file_end`: `ok`, `size`, `b` bytes done, `dur` (from start), `mbps` (MB/s, 10^6 B/s), `posts`
(upload: requests incl. retries), `err` (`aborted` for a cancel).

### `frag` (per fragment)

Upload, client: `i`, `pb` plaintext bytes, `b` ciphertext bytes, `rd` read (since 2026-10-14: until the
fragment is read and fed to the whole-file hash in order; `ph` is that hash step), `enc` AES-GCM, `hash`
SHA-256 of the ciphertext, `put` the store call (limiter + request + retries), `ph` the whole-file
plaintext hash step, `dur` total, `hook`, `ch` where it landed, `fl` fragments in flight then.

Upload, server (e2ee/plain): `budget` wait for the in-flight byte budget, `body` reading the body,
`hash` checking its SHA-256, `post` the Discord part (limiter + request + retries), `dur`, `ok`, `st`
(on failure), `hook`, `ch`, `fl`.

Download, client: `get` (link + CDN incl. retries), `hash`, `dec`, `wait` (fetched and decrypted, waiting
for the fragments before it to be written: downloads run in parallel since 2026-10-14, writes stay in order),
`wr` (write to the sink), `dur`, `b`, `pb`, `hook`, `ch`, `fl`.

### `req` (per HTTP request)

`i` fragment, `a` attempt (0 = first, >0 = retry), `k` kind, `dur` request time, `ttfb` time to the
response headers, `st` HTTP status, `b` bytes, `hook`, `ch`, `fl`.

* upload metadata only (`k` absent): the post to Discord; `lim` = ms waited in the limiter for the
  channel's token, `lst` = limiter state of the channel at that moment: `pm` messages/min, `tok`
  tokens, `blk` ms still blocked after a 429, `q` requests queued.
* upload e2ee/plain, client `k: "server"`: the PUT to the instance (round trip incl. its Discord post).
* upload server `k: "discord"`: `lim`, `lst`, `egress` (wait of the IP budget).
* download `k: "cdn"` (`host`; metadata only also `lk` = where its link came from: `hit` fetched ahead
  and ready, `wait` its request was on the way, `miss` fetched by this read; `lw` = ms this read waited
  for the link), `k: "proxy"` (through the instance). Logs written before 2026-10-16 have `k: "link"`
  requests here instead (the link was fetched inside the download slot).
* a failure: `err` (scrubbed), and for a 429: `st: 429`, `ra` retry_after ms, `scope`
  (`shared` = the channel limit, `user` = the webhook bucket), `glob`, `cf: true` for a Cloudflare
  block of the IP.

### Network

* `req` (download `k: "cdn"`): `ln` = which connection the request used when there are two (0 = the
  app's own fetch, 1 = a sandboxed iframe of the app, which gets its own connection).
* `file_start`: `win` pieces in flight allowed right now by the adaptive window (≤ `conc`), `lanes`
  (download: connections available), `lean: true` when "Save data" / a metered link limits it to 2,
  `auto: true` when the number of pieces in flight is automatic (measured, see `tune`).
* `link` (metadata only, download): a fresh CDN link fetched AHEAD of the read that needs it (GET of the
  message through its webhook): `i`, `hook`, `ch`, `dur`, `ttfb`, `st`, `q` link requests still queued,
  `act` in flight; a failure has `err` (429: `st`, `ra`, `scope`). At most 8 at once, ~2.5/s per webhook
  to start (Discord: 5 per webhook, ~1–2 s reset), slower after a 429.
* `tune`: the automatic number of pieces in flight changed: `dir`, `from`, `to`, `why` = `try` (a step
  up from a measured value), `gain` (it was ≥ 10 % faster: next step), `flat` (it was not: back),
  `try-fewer` / `fewer` / `worse` (uploads: one step down, kept when as fast), `errors` (network errors
  cut it), `cap` (bound lowered: memory, 2 per channel for uploads); `an`/`ab` pieces and bytes/s of the
  accepted value, `mn`/`mb` of the value just measured. Measured again every minute.
* `win`: the window of one direction changed: `dir`, `lim` new limit, `max`, `why` = `net` / `timeout`
  (halved after a network error, once per loss event) or `ok` (+1 after steady answers).
* `gate`: no-network gate: `st` = `down` (`why: "errors"`, 3 network errors in a row) / `offline`
  (`why: "event"`, the browser's offline event) / `probe` (`n`: one request to test the network) /
  `open` (`why` = `answer` / `online`, `waited` ms without network).
* `guard`: stuck-connection guard (downloads): `st` = `detect` (`thr` bytes/s of everything on the
  connection over the last 30 s, `base` the device's usual speed, `dur`/`ttfb` median piece time and
  first byte), `probe` (`from`, `to` connection, one needed piece goes on the other one), `switch` (the
  probe was clearly faster: new requests use `to`; `probe` its speed), `line` (as slow: it is the line,
  nothing changes, next check ≥ 5 min later), `fail` (the probe piece failed).
* `resume`: a transfer continued after a reload: `dir`, `have` fragments already done, `n` total.

The report (`npm run transfer-report`) has a **Network** section: window cuts and the lowest window,
time without network and probes, the guard's steps with speeds, requests and MB per connection, resumes;
a **Links ahead** section (link requests, how many reads found their link ready, the share of slot time
spent waiting for a link) and an **Automatic pieces in flight** section (every change with its reason
and the speeds it compared).

### Other

* `manifest` (download): `dur` loading + decrypting the manifest.
* `links` (e2ee/plain download): `n` links refreshed in one call, `dur`; server: `via` bot/webhook.
* `commit` (upload): `dur` finalize + the log commit.

### Example

    {"v":1,"t":1760450401234.5,"src":"web","ev":"file_start","dir":"up","x":"q8…","size":12582912,"n":2,"chunk":10485732,"conc":2,"mode":"metadata-only","ext":"bin"}
    {"v":1,"t":1760450401897.1,"src":"web","ev":"req","dir":"up","x":"q8…","i":0,"a":0,"hook":"1550000000000000101","ch":"1550000000000000101","b":10485760,"lim":0.2,"lst":{"pm":30,"tok":3,"blk":0,"q":0},"fl":2,"dur":601.3,"ttfb":600.9,"st":200}
    {"v":1,"t":1760450401899.0,"src":"web","ev":"frag","dir":"up","x":"q8…","i":0,"pb":10485732,"b":10485760,"rd":9.1,"enc":21.4,"hash":30.2,"put":601.9,"ph":1.2,"dur":664.3,"hook":"1550000000000000101","ch":"1550000000000000101","fl":2}
