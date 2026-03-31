# DiscorDrive v4 — Core How-to-Use

Runnable examples showing DiscorDrive used as a pure encrypted storage backend.
No frontend, no user accounts — just `API_KEY` and `MASTER_KEY`.

All scripts run with `npx tsx` and read configuration from the root `.env`.

---

## Prerequisites

### 1. Start the API in backend-only mode

```bash
# .env (root of the project)
APP_MODE=backend-only
API_KEY=my-secret-key
WEBHOOK_1=https://discord.com/api/webhooks/...
DATABASE_URL=postgresql://discordrive:discordrive@localhost:5432/discordrive
```

```bash
npm run infra:up   # start PostgreSQL
npm run db:push    # apply schema
npm run dev:api    # start API on :3000
```

### 2. Generate a Master Key (first time only)

Run any script without `MASTER_KEY` set — it will generate and print one:

```bash
npx tsx how-to-use/core/upload.ts ./any-file.txt
# MASTER_KEY not set. Generated a new one:
#   MASTER_KEY=aGVsbG8gd29ybGQ...
# Add it to your .env file and re-run.
```

Add it to `.env`:
```bash
MASTER_KEY=aGVsbG8gd29ybGQ...
```

The Master Key wraps all file encryption keys. **Keep it safe — losing it means losing access to all uploaded files.**

---

## Scripts

### Upload a file

```bash
npx tsx how-to-use/core/upload.ts ./video.mp4
```

Output:
```
Uploading: video.mp4
  Size:       234.50 MB
  Chunks:     24 × 10.0 MiB
  API:        http://localhost:3000

  File ID:    clxabc123...
  Uploading:  24/24 chunks
  Done.

  ┌──────────────────────────────────────────────────────
  │  fileId:       clxabc123...
  │  encryptedFEK: aGVsbG8gd29ybGQ...
  │  fekIv:        c29tZWl2...
  │
  │  Save these — you need them to download or share the file.
  └──────────────────────────────────────────────────────
```

Save the `fileId`, `encryptedFEK`, and `fekIv` — they are required to download or share.

---

### List files

```bash
npx tsx how-to-use/core/list.ts
```

Output:
```
  ID                            Name                            Size        Status      Created
  ──────────────────────────────────────────────────────────────────────────────
  clxabc123...                  video.mp4                       234.5 MB    READY       3/26/2026
```

---

### Download a file

```bash
npx tsx how-to-use/core/download.ts <fileId> <encryptedFEK> <fekIv> [output-path]
```

Example:
```bash
npx tsx how-to-use/core/download.ts clxabc123 "aGVsbG8..." "c29tZ..." ./video-copy.mp4
```

Output:
```
Downloading: video.mp4
  Size:    234.50 MB
  Chunks:  24
  Output:  video-copy.mp4

  Downloading: 24/24 chunks
  Integrity: ✓ PASS
  Saved to:  video-copy.mp4
```

---

### Create a share link

```bash
npx tsx how-to-use/core/share.ts <fileId> <encryptedFEK> <fekIv>
```

Output:
```
  Share link created.

  http://localhost:5173/share/clxtoken123...#aGVsbG8gd29ybGQ...

  The #fragment contains the share key — it never reaches the server.
  Anyone with this URL can download and decrypt the file.
```

The `#fragment` is the 256-bit share key. It is never sent to the server (browsers strip fragments from HTTP requests). The server only stores the FEK re-wrapped with this share key.

---

### Delete a file

```bash
npx tsx how-to-use/core/delete.ts <fileId>
```

Removes the file from the database immediately. Discord message deletion runs in the background.

---

## Stream video in the browser (Service Worker)

Open `http://localhost:5173/stream-demo.html` after starting the frontend:

```bash
npm run dev:frontend
# then open: http://localhost:5173/stream-demo.html
```

The page registers the Service Worker and streams the video directly — chunks are fetched from the API and decrypted in the SW. The decrypted bytes are never written to disk.

**Getting `fekRaw` for the stream demo:**

In your Node.js code, after generating or unwrapping the FEK:

```typescript
import { exportKey, toBase64 } from "@discordrive/processing";
const fekRaw = toBase64(await exportKey(fek));
console.log("fekRaw:", fekRaw);
```

Paste this base64 string into the stream demo form.

---

## Using DiscorDrive in another project

Install dependencies:

```bash
npm install @discordrive/processing @discordrive/config
# or if using as a git submodule, import from the monorepo directly
```

Minimal Node.js integration:

```typescript
import { generateFEK, wrapKey, encryptChunk, toBase64, fromBase64, unwrapKey, decryptChunk, importKey } from "@discordrive/processing";
import { config } from "@discordrive/config";

const BASE = "http://your-discordrive-api:3000";
const API_KEY = "your-api-key";
const headers = { "X-API-Key": API_KEY };

// Load master key from env
const masterKeyRaw = fromBase64(process.env.MASTER_KEY!);
const masterKeyBuf = masterKeyRaw.buffer.slice(masterKeyRaw.byteOffset, masterKeyRaw.byteOffset + masterKeyRaw.byteLength) as ArrayBuffer;
const masterKey = await importKey(masterKeyBuf, ["wrapKey", "unwrapKey"]);

// Generate FEK and upload
const fek = await generateFEK();
const { data, iv } = await wrapKey(fek, masterKey);

// → initUpload GraphQL mutation with toBase64(data) and toBase64(iv)
// → upload chunks: POST /api/upload/:fileId/chunk/:n with encryptChunk(chunk, fek)
// → finalizeUpload GraphQL mutation

// Download and decrypt
// → GET /api/download/:fileId/chunk/:n → arrayBuffer
// → decryptChunk(arrayBuffer, fek)
```

See the individual scripts in this folder for full working examples.

---

## Environment variables reference

| Variable | Default | Description |
|---|---|---|
| `DISCORDRIVE_URL` | `http://localhost:3000` | API server URL |
| `API_KEY` | _(empty)_ | API key for `backend-only` mode |
| `MASTER_KEY` | _(required)_ | Base64 raw 256-bit AES-GCM key |
| `FRONTEND_URL` | `http://localhost:5173` | Used in share link output |
