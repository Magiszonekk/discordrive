# DiscorDrive v4 — API client

Scripted access to a **real user account**, running alongside the web app. Both
credentials work at the same time: a script can be uploading while you browse the
same drive in the browser, and each file appears in both.

This replaces the old `how-to-use/` scripts, which targeted endpoints
(`/api/upload/:fileId/chunk/:n`, `finalizeUpload`) that no longer exist.

## Setup

1. Sign in to the web app → **Settings → API Keys → New key**.
2. Copy the secret. It is shown **once** — half of it never reaches the server, so
   nobody can display it again, not even the server operator.
3. Put it in the root `.env`:

```bash
DDV4_URL=https://discordrive.cikowice.pl
DDV4_API_KEY=ddv4_<authPart>.<cryptoPart>
```

## Usage

```bash
npx tsx examples/api-client/upload.ts ./video.mp4
npx tsx examples/api-client/upload.ts ./video.mp4 <parentFolderId>
npx tsx examples/api-client/list.ts
npx tsx examples/api-client/download.ts <fileId> ./out.mp4
```

## How the key works

The secret has two halves and they never meet on the server:

```
ddv4_<authPart>.<cryptoPart>
      │           └─ never transmitted; derives the key that opens your ARK
      └───────────── sent as X-API-Key; the server stores only its SHA-256
```

At creation the browser wraps your account key (ARK) under a key derived from
`cryptoPart` and uploads only the result. The server can hand that ciphertext back
to anyone holding `authPart`, which is safe — without `cryptoPart` it is inert.
`client.ts` splits the secret locally and only ever puts `ddv4_<authPart>` on the
wire.

Consequences worth knowing:

- **Revoking a key removes its ability to decrypt**, not just to authenticate — the
  wrapped ARK is destroyed with the row.
- **A leaked `.env` means full read/write on that account's files.** Revoke the key
  in Settings — it takes effect immediately, because revocation clears the
  validation cache in the same process. Across several API processes it would take
  up to 60 seconds for the others' caches to expire.
- **API keys cannot manage the account.** `changePassword`, `me`, `sessions` and
  `revokeSession` reject key auth, so a leaked key cannot lock you out or expose
  `wrappedARKByPassword` to an offline password attack.
- Never send the full secret as `X-API-Key`. The server detects the extra half and
  refuses the request rather than accepting a credential you have just leaked into
  request logs.

## Notes

- Chunks are 8 MiB, matching the browser, and are uploaded sequentially — a script
  racing the browser for the same sender pool gains little and risks rate limits.
- Encryption is identical to the web app's, so files cross freely between them.
- The client has no resume logic. An interrupted upload leaves an `UPLOADING` row
  that the hourly sweeper reclaims after 60 minutes of inactivity.
