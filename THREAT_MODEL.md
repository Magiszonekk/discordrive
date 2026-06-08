# DiscorDrive v4 — Threat Model

*Architecture snapshot: 2026-06-08*

---

## 1. System Overview

DiscorDrive is an end-to-end encrypted file storage service. The server acts as a blind relay: it stores ciphertext blobs on Discord CDN and metadata it cannot decrypt. All cryptographic operations happen in the user's browser.

**Component stack:**
- **Frontend** — React SPA (browser), Service Worker for video streaming
- **API** — Node.js + GraphQL Yoga (port 3000), JWT auth
- **Database** — PostgreSQL via Prisma
- **Blob storage** — Discord webhooks (primary) or local filesystem
- **Reverse proxy** — nginx (TLS termination)

---

## 2. Assets

| Asset | Location | Sensitivity |
|---|---|---|
| File plaintext | Client browser only | Critical |
| ARK (Account Root Key) | Client memory only | Critical |
| filesKey (domain key) | Client memory only | Critical |
| Per-file FEK | Client memory / DB as `wrappedFEK` (ciphertext) | Critical |
| `linkSecret` | URL fragment only, never reaches server | Critical |
| File content ciphertext | Discord CDN | High — encrypted, but loss = permanent data loss |
| `wrappedARKByPassword` | PostgreSQL `UserCrypto` table | High — offline brute-force target |
| `encryptedName`, `encryptedMimeType` | PostgreSQL `File` table | Medium — ciphertext, leaks length |
| `capabilityToken` (HMAC-SHA256) | PostgreSQL `Share` table | Medium — revocation key for shares |
| `email`, `username` | PostgreSQL `User` table | Medium — PII |
| Argon2 params + salt | PostgreSQL `UserCrypto` table | Medium — enables offline KDF attack |
| File ownership graph | PostgreSQL (ownerUserId → fileId) | Low-Medium |
| JWT tokens | Client localStorage / memory | Medium |
| Webhook URLs | Server `.env` | High — Discord storage access |

---

## 3. Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│  USER'S BROWSER                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │  React SPA + Service Worker                      │          │
│  │  • ARK, filesKey, FEK in memory only             │          │
│  │  • All encryption/decryption here                │          │
│  │  • linkSecret never leaves this boundary         │          │
│  └──────────────────────────────────────────────────┘          │
└────────────────┬────────────────────────────────────────────────┘
                 │ TLS (nginx)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  DISCORDRIVE SERVER (untrusted for plaintext)                   │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐ │
│  │  GraphQL API (port 3000)│  │  PostgreSQL                  │ │
│  │  • JWT auth             │  │  • wrappedARK (ciphertext)   │ │
│  │  • capabilityToken      │  │  • encryptedName/mimeType    │ │
│  │  • blob routing         │  │  • wrappedFEK (ciphertext)   │ │
│  └─────────────────────────┘  │  • email (plaintext)         │ │
│                               └──────────────────────────────┘ │
└────────────────┬────────────────────────────────────────────────┘
                 │ HTTPS (Discord API)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  DISCORD CDN (untrusted for plaintext)                          │
│  • Stores AES-GCM ciphertext chunks                             │
│  • No auth on blob fetch URLs (security by obscurity of URL)    │
│  • Discord can see: chunk sizes, upload timestamps, account ID  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Threat Actors

| Actor | Capability | Goal |
|---|---|---|
| **Compromised server / malicious operator** | Full DB read, API code modification | Access file content, de-anonymize users |
| **Discord (storage provider)** | Reads all uploaded bytes | Access file content |
| **Network attacker (MitM)** | Intercepts HTTPS traffic | Steal credentials, tamper data |
| **Unauthenticated API attacker** | HTTP access to the API | Enumerate accounts, brute-force, steal shares |
| **Authenticated attacker (legitimate account)** | Valid JWT | Access other users' files |
| **Share link recipient** | Has `shareId#linkSecret` URL | Access more than what's shared |
| **Stolen JWT attacker** | Bearer token from another session | Impersonate user without their password |
| **Physical access / browser compromise** | DOM/memory access | Extract keys from browser memory |

---

## 5. Threat Analysis

### 5.1 Compromised Server / Malicious Operator

**What the server CAN see:**
- `email`, `username` in plaintext
- `wrappedARKByPassword` — offline Argon2id cracking target
- Argon2 params and salt — everything needed to mount a password attack
- `encryptedName`, `encryptedMimeType` — ciphertext, but length is visible (content-type guessing by ciphertext length patterns)
- `totalCiphertextBytes`, `chunkCount` — file size visible (12-byte IV + 16-byte auth tag overhead per chunk)
- Folder structure (parentFolderId tree) — directory hierarchy visible, folder names encrypted
- `capabilityToken` — can enumerate all share recipients and revoke shares, but cannot derive `linkSecret`
- File ownership graph (`ownerUserId → fileId`)
- Upload/access timestamps
- Discord webhook URLs, channel IDs — direct blob storage access

**What the server CANNOT see:**
- Plaintext file content (AES-GCM ciphertext stored on Discord)
- Plaintext file names or MIME types (encrypted under FEK)
- ARK, filesKey, FEK — only ciphertext-wrapped versions
- `linkSecret` — never transmitted to the server

**Residual risk — password attack:**
The server has `wrappedARKByPassword` and the Argon2 salt. An operator can run offline Argon2id attacks. Parameters (19.5 MB / 2 iterations / 1 parallelism) are moderate; a weak password (<12 chars, no symbols) is crackable with a few hundred USD of GPU time. Strong passwords are adequately protected by the memory-hard KDF.

**Residual risk — file size fingerprinting:**
`totalCiphertextBytes` is stored in plaintext. The server can infer approximate file sizes and, for well-known file types (e.g., specific videos, documents), could correlate against known-size databases.

---

### 5.2 Discord as Storage Provider

**What Discord CAN see:**
- AES-GCM ciphertext bytes — cannot decrypt without the FEK
- Individual chunk sizes (up to 10 MB each)
- Upload timestamps and webhook account identity
- Number of chunks per file (correlatable with file size)
- CDN access logs if Discord logs blob downloads

**What Discord CANNOT see:**
- Plaintext file content
- Any metadata (name, type)
- The association between a Discord message and a DiscorDrive user (only the webhook/bot account is visible)

**Residual risk — blob URLs:**
Discord CDN URLs for uploaded attachments are not authenticated — anyone with the URL can download the ciphertext. This is mitigated by the fact that blob URLs are stored server-side and never exposed to clients directly; however, a server compromise exposes `storagePath` for all blobs.

---

### 5.3 Network Attacker

**Mitigations in place:** TLS via nginx. `linkSecret` in URL fragment (never sent in HTTP requests, not in server logs).

**Residual risk — `shareId` in path:**
`shareId` IS sent to the server and appears in nginx logs. A log-reading attacker learns which shares were accessed (but not the `linkSecret`, so they cannot derive the decryption key).

**Residual risk — JWT interception:**
A stolen JWT allows full account access (upload, download, delete) without knowing the password. An attacker with a JWT cannot decrypt files (no ARK/FEK), but can delete all files or flood storage.

---

### 5.4 Unauthenticated API Attacker

#### CRITICAL: Server-Side Password Verification Absent

**Location:** `apps/api/src/schema.ts:330`

```typescript
login: async (_parent, args: { emailOrUsername: string; password: string }) => {
  requireFullMode();
  return authResolvers.login(args.emailOrUsername); // password never passed
},
```

The server accepts **any password** for a valid email/username and returns a JWT plus `wrappedARKByPassword`. The `password` argument is silently ignored. Authentication is entirely client-side (ARK unwrap fails locally on wrong password), but:

- An attacker who knows a victim's email receives their JWT and `wrappedARKByPassword`
- They can then launch an **offline** Argon2id dictionary attack against `wrappedARKByPassword` without any server interaction or rate limiting
- With the cracked password they derive ARK → filesKey → per-file FEK → decrypt all files
- The server has no indication that anything wrong occurred

**Severity: Critical.** The server must verify a password-derived value (e.g., HMAC over a server challenge) before issuing a JWT.

#### HIGH: No Rate Limiting on GraphQL

**Location:** `apps/api/src/index.ts` — `checkRateLimit()` is imported but never invoked for the `/graphql` path.

Rate limiting only applies to `/api/blob/*` (300 req/min/IP). The GraphQL endpoint — including `login`, `register`, `accessShare` — is completely unlimited. Allows:
- Username/email enumeration via `register` (already-taken error)
- Unlimited `accessShare` calls to probe share tokens (partially mitigated by 256-bit token space)
- Account creation flooding

---

### 5.5 Authenticated Attacker (Legitimate Account)

Every GraphQL resolver that touches files/shares enforces `ownerUserId` checks:
- `getFiles(auth.userId, ...)` — WHERE clause includes userId
- `getFile(auth.userId, fileId)` — returns null if not owner
- Blob upload: ownership check on `PUT /api/blob/{blobId}`
- Blob download (share path): `blob.ownerUserId === share.ownerUserId`

**Residual risk — IDOR on `accessShare`:**
`accessShare` query takes no JWT; authentication is via `capabilityToken` only. The token is 32 bytes (256-bit HMAC-SHA256), making brute-force infeasible (~10^77 guesses). Comparison is timing-safe via `constantTimeEqual`. No IDOR risk here.

**Residual risk — health check leaks:**
`filesForHealthCheck` returns `fileName: file.id` (since plaintext names are no longer stored). A user can only query their own files. No cross-user leakage.

---

### 5.6 Share Link Recipient

A valid share link gives the recipient:
- Derived `shareWrapKey` and `shareAuthKey` from `#linkSecret` (HKDF-SHA256)
- A valid `capabilityToken` to call `accessShare`
- `wrappedAKShare` → `shareKey` → `wrappedFEK` → `rootFEK`
- Ability to decrypt `encryptedName`, `encryptedMimeType`
- Ability to download all blobs via `GET /api/share/blob/{blobId}`

**What the recipient cannot do:**
- Access files not included in the share (blob download enforces `blob.ownerUserId === share.ownerUserId` AND blob must be reachable from the manifest)
- Derive the owner's `filesKey` or ARK from share material (HKDF with domain-separated info strings)
- Create new shares or delete files (no JWT)

**Residual risk — share forwarding:**
Anyone who receives the share URL (including the fragment) gains full access. There is no IP binding or per-recipient token. `maxViews` is the only access limit, and it has a race condition (see below).

**Residual risk — view count race condition:**
`apps/api/src/resolvers/sharing.ts` — validation and `viewCount++` are two separate queries, not atomic. With `maxViews: 1`, two concurrent requests can both pass the validation check before either increments the counter.

---

### 5.7 Stolen JWT (Session Hijacking)

JWT has 7-day TTL by default. A stolen token allows:
- Listing all files (gets `encryptedName`, `encryptedMimeType`, `wrappedFEK` — all ciphertext)
- Downloading all blob ciphertext
- Deleting files
- Creating shares

**What a JWT alone cannot do:**
- Decrypt any file content or metadata (no ARK/filesKey in the token or DB in plaintext)
- A stolen JWT without the user's password is useful only for destruction (delete) or sharing forward, not for reading content

No token revocation mechanism is implemented. A compromised JWT cannot be invalidated before it expires (7 days). No refresh token pattern.

---

### 5.8 Backend-Only Mode

**Location:** `apps/api/src/middleware/auth.ts`

API key validation uses plain string comparison (`key === serverConfig.apiKey`), which is vulnerable to timing side-channel attacks. Should use `constantTimeEqual`.

Additionally, if `serverConfig.apiKey` is empty/unset, the condition `!serverConfig.apiKey || apiKey === serverConfig.apiKey` evaluates to `true` for any request — granting unrestricted access. This needs a startup assertion that `apiKey` is set when `APP_MODE=backend-only`.

---

## 6. Residual Risks Summary

| Risk | Severity | Notes |
|---|---|---|
| Server ignores password in `login` | **Critical** | Any email owner gets a JWT; offline ARK crack possible |
| No rate limiting on GraphQL | **High** | Login, register, accessShare unlimited |
| Argon2 params (19.5 MB / 2 iter) | Medium | Weak passwords crackable offline; strong passwords safe |
| JWT has no revocation | Medium | 7-day window after compromise |
| File sizes visible to server | Medium | `totalCiphertextBytes` plaintext |
| Share view count race condition | Medium | `maxViews` limit bypassable under concurrent load |
| `email`/`username` plaintext in DB | Medium | PII exposure on server compromise |
| API key not timing-safe (backend-only) | Low | Timing side-channel on comparison |
| API key bypass if empty (backend-only) | Medium | Full access if env var unset |
| Discord blob URLs unauthenticated | Low | Ciphertext only; URL is secret by obscurity |
| No forward secrecy on FEK | Low | Past ciphertext retroactively decryptable if password is cracked |
| Folder tree structure visible | Low | Depth, item count per folder |
| Upload timestamps visible | Low | Activity pattern inference |

---

## 7. What the System Gets Right

- **Zero-knowledge storage**: server has zero ability to read file content or metadata without the user's password
- **HKDF domain separation**: `"ddv4-files-share-wrap-v1"` / `"ddv4-files-share-auth-v1"` / `"ddv4-file-content-v1"` — cross-context key reuse impossible
- **Unique IVs everywhere**: `crypto.getRandomValues(new Uint8Array(12))` per operation — no IV reuse
- **Timing-safe share token comparison**: `constantTimeEqual` prevents oracle attacks on capabilityToken
- **Fragment-only linkSecret**: never reaches server, not in nginx logs
- **Opaque IDs (CUIDs)**: not guessable; no sequential enumeration
- **AES-GCM authentication tags**: any tampering with ciphertext is detected before decryption

---

## 8. Priority Recommendations

1. **[Critical]** Implement server-side password verification. Standard pattern for zero-knowledge auth: client sends `HMAC(Argon2(password, salt), "server-auth")` as a login proof; server stores and verifies this proof. The raw ARK and filesKey remain client-only.

2. **[High]** Apply rate limiting to the `/graphql` endpoint — especially the `login` and `register` mutations (e.g., 10 req/min/IP).

3. **[Medium]** Make `maxViews` check atomic: `UPDATE "Share" SET "viewCount" = "viewCount" + 1 WHERE "shareId" = $1 AND "viewCount" < "maxViews" RETURNING *`.

4. **[Medium]** Implement JWT revocation (token blocklist in Redis or short-lived tokens + refresh token rotation).

5. **[Low]** Use `constantTimeEqual` for API key comparison in backend-only mode; add startup assertion that `API_KEY` is set.
