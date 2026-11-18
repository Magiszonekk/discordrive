# `ddn serve`: local HTTP API

`ddn serve` keeps the account open in one process and answers HTTP requests from scripts and services on
the same computer (or a trusted network). It uses the same API key and profile as the `ddn` command line
(`docs/cli.md`): files are encrypted and decrypted in this process; the instance never gets a key it could
use. Machine-readable description: [`local-api.openapi.json`](local-api.openapi.json).

```sh
ddn login --key-file ~/discordrive-api-key.txt
ddn serve                     # http://127.0.0.1:7777
ddn serve --listen 127.0.0.1:8080 --parallel 4
```

Options: `--listen HOST:PORT` (default `127.0.0.1:7777`), `--token-file FILE`, `--parallel N` (uploads sent
at once, 1–16, default 2; the rest wait in order), `--transfer-log` (transfer logs, `docs/transfer-log.md`,
`src: "serve"`, without file names), `--profile`, `--gallery` is per request (`?space=gallery`).

## Security

- **Local token.** Every request needs `Authorization: Bearer <token>`. At the first start a random token is
  written to `<profile>/serve-token` (owner-only, 0600), or to `--token-file`. It only opens this service; it
  is not the API key and is never sent anywhere. Rotate it by deleting the file and restarting.
- **Address.** By default only this computer can connect. `--listen 0.0.0.0:7777` (or another address) opens it
  to the network: the log warns about it. Whoever reaches the port and has the token can read and change every
  file of the account (except the Safe). There is no TLS: use it only on a network you trust, or behind a
  reverse proxy with TLS.
- Logs (standard error, JSON lines) never contain the key or the token, and no file names.

## Endpoints

Paths are those of the Drive (`/Photos/2024/a.jpg`), `?space=gallery` for the Gallery. Where a file is named
in the URL path, either its ID (`id` from any answer) or its path works: `/v1/files/<id>` or
`/v1/files/Photos/2024/a.jpg` (URL-encoded).

| Method and path | What it does |
|---|---|
| `GET /v1/health` | `{ok, version, mode, accountId, deviceId, connected, authLost, canUpload, channels, jobs:{queued,running}}`; 503 when the key was refused |
| `GET /v1/list?path=/X&limit=500&after=CURSOR` | `{path, total, entries:[{id,name,kind,size,modifiedAt,path}], next}` (`next`: cursor of the next page or null) |
| `POST /v1/folders` `{path}` | make a folder with its parents: 201 `{…, created:true}`, 200 if it existed |
| `POST /v1/files?path=/X&name=N` body = the file | upload. Raw body (any Content-Type except multipart), streamed to a private spool file, never whole in memory. `on_conflict=rename\|replace\|skip` (default rename), `parents=1` makes the folder, `wait=1` answers when done (201, the job) — else 202 with the job and `Location: /v1/jobs/<id>` |
| `GET /v1/jobs/<id>[?wait=1]` | the job: `{id, state: queued\|running\|done\|failed\|cancelled, name, folder, size, done, result, error}`; `result` = `{id, name, path, size, sha256, skipped, replaced, resumedPieces}` |
| `DELETE /v1/jobs/<id>` | cancel a queued or running upload |
| `GET /v1/jobs` | the last jobs (up to 500 finished are kept) |
| `GET /v1/files/<id or path>` | the file. `Range: bytes=a-b` (one range; suffix `-n` and open `a-` too) → 206 with `Content-Range`, only the pieces that overlap are fetched (a video player can seek). 416 outside the file. `Accept-Ranges`, `Content-Type` by extension, `ETag` = SHA-256 of the content |
| `HEAD /v1/files/<id or path>` | the headers only |
| `GET /v1/files/<id or path>?meta=1` | `{id, name, kind, size, modifiedAt, sha256, path}` (folders too) |
| `DELETE /v1/files/<id or path>[?permanent=1]` | to the trash (30 days); `permanent=1` deletes for good |
| `POST /v1/move` `{from: path\|path[], to: folder, name?}` | move into a folder; `name` renames (one item) |
| `GET /v1/events` | Server-Sent Events: `hello`, `changed` (the file list changed, also from other devices), `job` (a job changed state), `progress` (`{id, done, size}`, at most every 0.5 s), `auth-lost` |

Errors: JSON `{error, message}` with 400 (bad request), 401 (local token), 404 (`not_found`, `no_such_folder`),
409, 413, 415 (multipart), 416, 502 (`upstream`: the instance or Discord), 503 (`key_refused`,
`no_channel_or_limit`, `stopping`).

## Limits and behaviour

- Uploads go `--parallel` at a time, in the order they arrived. Discord's limits are kept per channel as in
  the desktop app (pacing, waiting after 429).
- A failed upload sent again (the same file, folder and name) continues from the pieces already sent.
- **Stopping** (SIGTERM, SIGINT, `systemctl stop`): no new requests; uploads already sending finish; queued
  ones are cancelled (their jobs say `cancelled`, the client sends them again). A second signal stops at once.

## As a service (systemd, Linux)

`~/.config/systemd/user/ddn-serve.service`:

```ini
[Unit]
Description=discordrive-next local API (ddn serve)
After=network-online.target

[Service]
ExecStart=/usr/bin/node %h/discordrive/apps/cli/bin/ddn.mjs serve
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=300

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now ddn-serve
loginctl enable-linger "$USER"   # keep it running after logout
```

## Example

```sh
T=$(cat ~/.config/ddn/default/serve-token)
curl -s -H "Authorization: Bearer $T" localhost:7777/v1/health
curl -s -H "Authorization: Bearer $T" -X POST --data-binary @video.mp4 \
  "localhost:7777/v1/files?path=/Videos&name=video.mp4&parents=1&wait=1"
curl -s -H "Authorization: Bearer $T" -H "Range: bytes=0-1048575" \
  "localhost:7777/v1/files/Videos/video.mp4" -o first-mib.bin
```
