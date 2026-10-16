# discordrive-next: threat model

Status: 2026-10-16. Written from the code, not from the design notes: every claim names the file
it comes from. When the code changes, this document must change with it.

An instance runs in exactly one mode, chosen at `discordrive setup` and fixed for its life
(`apps/ddn-server/src/setup.ts`, the mode is also stored in the database). The code of the other
modes is not in the build: `apps/web-mo/src/modes/` and `apps/ddn-server/src/modes/` hold one file
per mode and the build takes only one (checked by `apps/ddn-server/test/mode-bundles.test.ts`).

Contents
1. The three modes at a glance
2. Common to all modes
3. metadata only
4. e2ee
5. plain
6. Known limitations and non-goals

## 1. The three modes at a glance

| | metadata only | e2ee | plain |
|---|---|---|---|
| File contents, names, folders | encrypted in the browser | encrypted in the browser | **readable by the server** |
| Operation log payloads | AES-GCM, account key | AES-GCM, account key | **plain JSON** |
| Webhook URLs | only in the user's encrypted vault | **server** (sealed with `instance.key` at rest) | **server** |
| Encrypted pieces pass through the server | no (browser → Discord) | **yes** on upload; download from the CDN, proxy as a fallback | **yes**, and the server decrypts for thumbnails and streaming |
| Server takeover: read files | no* | no* | **yes** |
| Server takeover: delete files on Discord | no (it has no webhooks) | **yes** | **yes** |
| Stolen database (`ddn.db` alone): read files | no (with the password option: offline guessing) | no (same) | **yes** (with any Discord bot) |
| Background work without an open tab | no | yes | yes |

\* As long as the browser keeps running the genuine app. The server delivers that app, so a
taken-over server can ship a modified one that sends the keys out on the next page load (§2.10).
That holds for every mode. It is the main limit of end-to-end encryption in a web app.

## 2. Common to all modes

### 2.1 Actors

| Actor | Has | Main risk |
|---|---|---|
| Instance operator / whoever takes over the server | the process, `ddn.db`, the data directory (`config.json`, `instance.key`), the files of the web app it serves | depends on the mode (§3–§5); in every mode it can deny service and ship a modified web app (§2.10) |
| Discord | every message and attachment, uploader IPs, the accounts that own the channels and webhooks | deletes messages, bans webhooks/accounts/IPs (§2.7); sees only ciphertext (in plain too: the pieces are encrypted at rest) |
| Someone with access to a channel | reads the channel's attachments (ciphertext); with "Manage Webhooks", the webhook URLs | with a webhook URL: post and delete messages of that webhook |
| Device thief / malware on a device | the browser profile: account key, device key, local index | full access to the account (§2.4, §3.6, §4.6, §5.6) |
| Database thief | a copy of `ddn.db` (maybe of the whole data directory) | depends on the mode (§3.5, §4.5, §5.5) |
| Holder of a share link | `/s/<id>#<file key>` | that one file, until its pieces are deleted (§2.8) |
| The network | traffic between browser, server and Discord | TLS everywhere except `localhost`; the app refuses to run off-localhost without HTTPS (WebCrypto and the service worker need it) |

### 2.2 Keys and encryption

- **Account key**: 32 random bytes per account, made on the first device
  (`packages/metadata-client/src/account-key.ts`). Never sent to the server in clear in any mode.
  The pairing message carries it sealed (§2.4), and the optional password key holds it sealed (§2.5).
- **Subkeys**: HKDF-SHA256 of the account key with distinct labels `ddn-<label>-v1`: `vault`,
  `op`, `snapshot`, `device-name`, `share-note` (`account-key.ts`). Sealing = AES-256-GCM with a
  random 12-byte IV, a version byte and an AAD naming the context (account, revision, opId…), so a
  sealed blob cannot be moved to another place or account without failing to open.
- **File key**: 32 random bytes per file version. The content key = HKDF(file key,
  `ddv4-file-content-v1`). Each piece = IV(12) ‖ AES-256-GCM(ciphertext ‖ tag), ≤ 10 MiB. The
  manifest (list of pieces with their ciphertext SHA-256) is encrypted with the same file key
  (`packages/metadata-client/src/file-crypto.ts`, `packages/processing/src/crypto.ts`,
  `FRAGMENT_FORMAT_VERSION = 1`). The file key travels only
  inside the operation payload (`manifestRef "ddn1:…"`, `drive-client.ts`).
- **Integrity on download**: each piece's ciphertext SHA-256 is checked against the manifest, and
  the whole file's plaintext SHA-256 against the version (`drive-client.ts`), on top of GCM.
- **Attachment names on Discord** are random (`<random id>.txt`, `ddn-segment.txt`,
  `ddn-pointer.txt`), never the file name (`drive-client.ts`, `snapshots.ts`,
  `packages/server-discord/src/blobs-ext.ts`).

### 2.3 Signing in (Ed25519 per device)

`packages/metadata-client/src/device-key.ts`, `node/auth.ts`.
- Every device has its own Ed25519 key pair. In the browser the private key is a non-extractable
  `CryptoKey` in IndexedDB (`apps/web-mo/src/keystore.ts`); the CLI keeps PKCS#8 in a 0600 file.
  The server stores only public keys. No password is involved.
- Sign-in = signing a random one-shot challenge (2 min) bound to the instance ID, the account and
  the device. The session token lasts 60 min and is stored as SHA-256. Adding and revoking a
  device need a fresh signature, so a stolen session token alone is not enough.
- Unauthenticated endpoints have per-IP limits (`node/ip-limit.ts`, `DEFAULT_RATE_LIMITS` in
  `node/server.ts`).
- **Accounts on one instance are separate**: each has its own account key and keys of its own
  devices. The server scopes every request to the session's account. Sign-up is `open`, `invite`
  (one-shot codes from `npm run invite`, stored as SHA-256, 7 days by default,
  `node/invites.ts`) or `closed`.

### 2.4 Devices: pairing, rescue kit, revocation

**Pairing** (`packages/metadata-client/src/pairing.ts`): the new device shows
`ddn-pair1:<pairingId>.<ECDH P-256 public key>.<its Ed25519 public key>` as a QR code or text. The
signed-in device scans it, registers the new device's public key with its own signature, derives
a key with ECDH + HKDF over the whole transcript and seals {account ID, account key, device ID}
into a one-shot mailbox on the server (deleted on first read, 10 min). Both screens then show a
6-digit code (SAS) from the same derivation.
- The server can read nothing: the bundle is sealed to the new device's public key, which came
  through the QR code, not through the server. If the server swaps the answer, the codes differ.
- The 6 digits protect against the **server**, not against someone who swaps the offer itself:
  the offer has to travel a trustworthy path (camera, own clipboard). Whoever can replace the
  offer gets the account key.
- The new device is registered **before** the codes are compared. If they differ, the user has
  to revoke it (the app says so: `joinD.rejected`).
- Pairing gives **the whole account**. It is for one's own devices only, never for another person.

**Rescue kit**: `ddn-kit3:` (metadata only: account ID + account key + the pointer's webhook URL +
pointer message ID, plus the other webhook URLs of the account while the code stays short) or
`ddn-kit2:` (e2ee/plain: account ID + account key + server address) (`snapshots.ts`). The older
metadata-only `ddn-kit1:` (one webhook) is still accepted. Pieces, snapshot segments and bases are
spread over every channel of the account, so the snapshot pointer carries a copy of the vault's
channel list (sealed with the `snapshot` subkey, like the rest of the pointer): from a kit alone a
device learns every channel and can read every file without the server. A webhook removed from the
vault can stay in older pointers and kept bases for the snapshot retention (30 days); that is the
same kind of secret the kit already holds. The device key it registers is signed with the **rescue key**, an Ed25519 key
derived from the account key (HKDF `ddn-rescue-ed25519-v1`, `device-key.ts`) whose public half was
registered with the account. Whoever holds a kit holds the account. A kit cannot be revoked (no
key rotation).

**Revocation** (`node/auth.ts revokeDevice`): deletes the device's public key and all its
sessions; the device can no longer sign in. **What it does not do**: the account key that device
had is not rotated. Whoever kept it (the device, or someone who copied its browser storage) can
still:
- decrypt everything they can fetch (pieces on Discord, snapshots, a copy of the log),
- register a new device with the rescue key derived from that key: `rescueAddDevice` accepts it
  (test: `packages/metadata-client/test/auth.test.ts`, "documented limit"),
- in metadata only: use the webhook URLs it knew (post and delete messages) until the webhooks are
  deleted in Discord.

Full recovery after losing a device to an attacker = a new account and uploading again (§6).

### 2.5 Optional password key

`packages/metadata-client/src/password-key.ts`, `node/password-keys.ts`. Off by default, turned on
in Settings → Security. The browser derives 32 bytes from the password with Argon2id (64 MiB,
3 passes, 4 lanes, random 16-byte salt, password ≥ 10 characters), splits them with HKDF into a
wrap key and an auth proof, and sends the server: login, parameters, the account key sealed with
the wrap key, and the proof. The server keeps SHA-256(proof), never the password or the proof.
- Online guessing: 5 failures per account per 15 min and a per-IP limit (10 burst, 5/min); an
  unknown login gets stable fake parameters (no account enumeration).
- **With the database**: unlimited offline guessing, slowed only by Argon2id. A weak password then
  gives the account key, which means the whole account in metadata only and e2ee. The UI says this
  (`pw.warn`). The login is visible to the server.
- A password sign-in registers the device through the same rescue-key path as a kit.

### 2.6 Operation log

`packages/metadata-client/src/op-crypto.ts`, `packages/sync-core/src/sequencer.ts`. The server is
the arbiter: it assigns `seq` and `serverTime` and rejects duplicate `opId`s. In clear per
operation: `opId`, `rulesVersion`, `baseSeq`, `leaseGuard` (upload IDs), `seq`, `serverTime`,
payload size. The payload (device, time, time zone, the operation) is AES-GCM with the `op` subkey
in metadata only and e2ee, with the clear fields in the AAD. In plain it is JSON (§5).
- **Usage patterns leak in every mode**: when the user is active, how many operations, how big,
  how many uploads (lease IDs, cleanup bookkeeping `gc_done`), from how many devices.
- The server cannot forge or edit an encrypted payload (an undecryptable entry becomes the same
  no-op on every replica). It can withhold entries, stop the log, or show different devices
  different logs; a gap in `seq` is detected (`LogGapError`), a consistent fork is not.

### 2.7 Discord

- Storing files on Discord is against its Terms of Service. Discord can delete messages, ban a
  webhook, an account or an IP, or change its API (`refresh-urls`, CORS, limits) at any time. The
  wizard requires accepting this (`setup.ts`, `RISK_VERSION`), the app repeats it (`hooks.tos`).
  **Discord is the only copy of the files**: keep important files somewhere else too.
- Discord sees ciphertext, sizes, times, random attachment names, the channel and webhook, and the
  uploader's IP (the user's in metadata only, the server's in e2ee/plain).
- A webhook URL is a token: it can post and delete that webhook's messages. Whoever creates the
  webhook (or has "Manage Webhooks" on the channel) knows it.
- CDN links expire (~24 h) and are refreshed with `POST /attachments/refresh-urls`. Any bot can
  refresh any attachment address (channel + attachment ID + name), even without access to the
  channel, so **an attachment address is a lasting pass to the ciphertext**. Encryption protects
  the content, not the secrecy of the address.

### 2.8 Share links

`packages/metadata-client/src/share.ts`, `node/shares.ts`. A link is `/s/<shareId>#<file key>` for
one version of one file. The part after `#` is never sent to the server. The server stores the
attachment addresses of that file and a blob sealed with the file key (name, size, SHA-256, type);
the owner's note is sealed with the account's `share-note` subkey. The recipient needs no account;
the server refreshes the CDN links (instance bot in metadata only; in e2ee/plain through the
instance, bot or webhooks). Without a bot, metadata only has no sharing (503).
- Anyone the link reaches (forwarded, browser history, a chat log) can download and decrypt the
  file.
- **Revoking stops new recipients only.** Whoever already has the addresses and the key keeps
  access while the pieces exist (§2.7). Full revocation = upload again with a new key and delete
  the old pieces. The app says this (`shareD.note`, `sh.hint`).
- The link never carries the account key.

### 2.9 Transfer logs

`packages/metadata-client/src/transfer-log.ts`, `apps/web-mo/src/transfer-log-opfs.ts`,
`packages/server-discord/src/transfer-logs.ts`, format in `docs/transfer-log.md`. Off by default.
Never written: webhook URLs, tokens, CDN links (host only), signatures. File names only when the
user turns on "include file names" (browser only); otherwise only the extension. Upload/webhook/
channel IDs are written (not secrets). The server log (e2ee/plain) has `acct` on every line and no
names.

### 2.10 The web app comes from the server

The browser app (JS, service worker, `lane.html`) is served by the instance itself
(`node/static.ts`). The CSP allows scripts only from the instance (`script-src 'self'`), frames
are denied except `lane.html` framed by the same origin, and `connect-src` lists only the instance
and Discord. That stops injected scripts from elsewhere. It does not protect against the instance
itself: whoever controls the server (or the files it serves) can deliver modified code, which on
the next page load reads the account key from IndexedDB (stored as raw bytes, `keystore.ts`) and
sends it out. Nothing pins or signs the app's code today. In metadata only and e2ee, "the server
cannot read your files" therefore means: **as long as the server delivers the genuine app**. A
desktop app with its own code would close this gap for its users; the web app cannot.

### 2.11 Operator and admin accounts

Two kinds of people administer an instance (`node/admin.ts`, `apps/ddn-server/src/accounts.ts`):

- **The operator**: whoever has a shell on the server. Commands `discordrive accounts | invite |
  signup` work on `ddn.db` directly (also while the server runs). Shell access is the root of
  trust: it already gives everything listed under "server takeover" for the mode (§3.4, §4.4,
  §5.4), so these commands add nothing to it.
- **Admin accounts**: ordinary accounts with the admin flag (`accounts.admin` in `ddn.db`). The
  flag is set only from the server (`discordrive accounts admin <id> on`, or setup's "make the
  first account the admin"); an admin may then grant it to other accounts. The server checks the
  flag on **every** `/v1/admin/...` call (`node/server.ts` `adminRoute`); a regular account gets
  403, a blocked one has no session (401) and cannot sign in (403 `account_blocked`). Deleting an
  account, granting or removing the flag and revoking another account's device need a fresh
  Ed25519 signature of the admin's device over the action and its target
  (`authMessage.adminAction`), so a stolen session token or an open tab alone cannot do them. The
  last admin cannot lose the flag from the panel, only from the server.

What an admin sees is what the server stores anyway, never more: account and device IDs,
creation and last-activity times, how many devices, sizes (bytes of the operation log, the
vault, share links; in e2ee/plain also the bytes of the account's pieces on the instance's
channels), the invite note the account was created with, the admin and blocked flags, invite
codes (as IDs: only their SHA-256 is stored, a code is shown once when made), the pool and the
administrative log. Device names stay sealed with the account key.

| | metadata only | e2ee | plain |
|---|---|---|---|
| File names, folders, file keys | not on the server, not in the panel | not on the server (encrypted in the browser), not in the panel | on the server (§5.1) but **not shown** in the panel; the operator can read them from the data directory |
| Webhooks | not on the server (vault sealed with the account key) | the pool and own channels are on the server (sealed with `instance.key`); the panel shows the pool's labels and usage, never URLs | as e2ee |
| What "delete account" deletes | the account's rows on the server (log, devices, vault, sessions, shares, password key); **nothing on Discord**: the files are on the user's own channels and the user can restore the account from the rescue kit on another instance | the rows **and** the account's pieces and snapshot chain on the instance's channels, deleted in the background by the running server (`account_deletions`, resumed after a restart or a Discord outage); irreversible, the rescue kit cannot bring the files back | as e2ee, plus the server's replica of the account's index and its thumbnails |

Blocking keeps every piece of data: the account's sessions are deleted, its open notification
sockets closed and long-polls released at once (a CLI change is noticed through SQLite's
`data_version` within about two seconds), sign-in, rescue-kit device registration, the password
sign-in and the account's share links are refused until it is unblocked. Every administrative
change is written to `admin_log` (actor = admin account ID or `operator`, action, target, time).

What this does not protect against: an admin can block or delete any other account (that is the
point), and a malicious operator is still the server itself (§2.10, the takeover sections).

## 3. metadata only

The server is a cache of encrypted data plus the order arbiter (`node/server.ts`,
`apps/ddn-server/src/modes/metadata-only.ts` adds nothing).

### 3.1 What the server sees in clear
- Accounts (ID, rescue public key, creation time), devices (public key, when, added by which
  device; names are sealed), sessions (hash), challenges, invite hashes.
- Log envelopes (§2.6), the vault blob's size and revision, pairing mailbox messages (opaque),
  cleanup bookkeeping (finished upload IDs, last run).
- For shared files only: their attachment addresses (§2.8).
- With the password option: the login, Argon2id parameters, the sealed key and the verifier
  (§2.5).
- Request IPs (rate limits in memory; the app writes no access log).

### 3.2 Webhooks
Not known to the server. They live in the user's vault, one blob sealed with the `vault` subkey and
AAD `ddn-vault-v1|<account>|<revision>` (`vault.ts`); the server stores the blob and a revision
number. A client refuses an older revision than it has seen. In the browser that memory lasts for
the page session only (`WebhookVault` built without a stored revision in
`apps/web-mo/src/modes/metadata-only.ts`); the CLI keeps it in `seen.json`.

### 3.3 Does data pass through the server
No. The browser encrypts and posts each piece straight to the user's webhook and downloads from
Discord's CDN (`discord-transport.ts`, CSP `connect-src`). The server never receives a piece or a
webhook. Snapshots (encrypted log segments and tree bases, `snapshots.ts`) are written to Discord
by the main tab.

### 3.4 Server takeover
- **Read**: nothing from what it stores (no keys, no webhooks, no names). It can ship a modified
  app (§2.10). With the password option: offline guessing (§2.5).
- **Delete**: the log, vault, devices and shares on the server, not the files on Discord. The
  pieces and the snapshot chain stay on the user's channels. Rebuilding the tree from Discord
  without the server exists as a library function with a test (`snapshots.ts`,
  `packages/metadata-client/test/snapshots.test.ts`) but not in the app yet. The kit names only
  the pointer's webhook, so today it is enough for that only when the account has one channel.
- **Tamper**: cannot forge operations or the vault (AES-GCM with AAD). It can replay an old vault
  to a freshly opened tab (§3.2), withhold or fork the log (§2.6), or insert a device row into its
  own database: that device could sign in but decrypts nothing, and its operations would be no-ops.
- **Deny service**: yes. Without the server there is no sync, no sign-in and no new device.

### 3.5 Theft of the server database
`ddn.db` gives no file content, names or webhooks: only the metadata of §3.1 and the attachment
addresses of shared files (ciphertext without the key from the link). With the password option,
offline guessing of the account key. The rest of the data directory: `config.json` holds the
instance bot token (0600), which refreshes attachment links but decrypts nothing.

### 3.6 Device takeover
The browser profile holds the account key (raw, IndexedDB), the device key (usable, not readable),
the decrypted tree in OPFS (names, file keys), unfinished-upload journals with their file keys
(`resume-idb.ts`) and, through the vault, the webhook URLs. That is the whole account: read all
files, change and delete them, delete messages on Discord through the webhooks. Revoke the device
(§2.4), then delete and recreate the webhooks in Discord; the key itself stays valid.

### 3.7 What this mode does not protect
Usage patterns (§2.6); the user's IP towards Discord; a modified app delivered by the server
(§2.10); the account against anyone holding the account key, a rescue kit or a weak password with
the database; files against Discord deleting them; background work (snapshots and cleanup run only
while a tab is open).

## 4. e2ee

The server holds the webhooks and moves the encrypted pieces, so it can work without an open tab
(`packages/server-discord`, `apps/ddn-server/src/modes/e2ee.ts`, `apps/web-mo/src/modes/e2ee.ts`).
Contents, names and the log stay encrypted with keys the server does not have.

### 4.1 What the server sees in clear
Everything of §3.1 except the vault (none in this mode: `/v1/vault` answers 404), plus:
- every piece on its way to Discord: account, upload ID, index, size, ciphertext SHA-256, time,
  and where it landed (webhook, channel, message, attachment, random name) in `s_blobs`
  (`packages/server-discord/src/channels.ts`);
- upload states (`s_uploads`), the account's own channels (labels, channel IDs), snapshot pointer
  locations (`s_snapshots`, `<dataDir>/snapshots.json`), per-account usage.
It does not see names, the tree, file keys or contents: operations stay sealed with the account
key, and manifests with the file key.

### 4.2 Webhooks
Known to the server: the instance pool from `setup` and the channels a user adds in Settings →
Channels (the URL goes to the server once). At rest they are sealed with AES-256-GCM under a key
derived from `<dataDir>/instance.key` (separate 0600 file), AAD = webhook ID + scope
(`instance-hooks.ts`). No API returns a URL; errors are redacted (`sender.ts`). The browser never
sees a webhook after pasting it.

### 4.3 Does data pass through the server
Uploads: yes. Each encrypted piece goes `PUT /v1/uploads/<U>/blobs/<i>`, the server checks the
lease and the hash and posts it (`server-blobs.ts`, `blobs-ext.ts`). Downloads: straight from the
CDN with links the server refreshes (`POST /v1/blobs/urls`); `GET /v1/blobs/<attachment>` proxies
the ciphertext when the CDN is not reachable. Snapshots: the server writes a chain of encrypted log
segments per account, sealed with HKDF(instance key, `snapshot|<account>`); the entries inside
keep their payloads sealed with the account key (`snapshots-ext.ts`). There are no tree bases (the
server does not know the tree).

### 4.4 Server takeover
- **Read**: no contents or names from what it holds or sees (§4.1). It can ship a modified app
  (§2.10); password option: offline guessing (§2.5).
- **Delete**: **yes, everything on Discord**. It holds every webhook of the pool and of the users'
  own channels and can delete all messages. Discord is the only copy.
- **Tamper**: it cannot forge operations. A swapped or corrupted piece is detected on download
  (ciphertext hash in the encrypted manifest, GCM, whole-file SHA-256), so the result is a failed
  download, not wrong content. Log withholding or forks as in §2.6.
- **Deny service**: yes, and more than in metadata only: every upload and every link refresh goes
  through it.

### 4.5 Theft of the server database
`ddn.db` alone: the webhooks are sealed with `instance.key`, which is not in the database; metadata
as in §4.1; attachment addresses of every piece (ciphertext, which any bot can fetch, §2.7, but no
file keys). **With the whole data directory** (`instance.key` too): the webhooks, meaning
deleting or posting on every channel of the instance. Contents stay encrypted. Password option:
offline guessing (§2.5).

### 4.6 Device takeover
As §3.6 (account key, tree, file keys), except that the device never holds webhook URLs: it cannot
delete messages on Discord directly, only through the server's API while its session is valid
(deleting files, which the server then cleans up after retention). Revocation ends that; the
account key stays valid (§2.4).

### 4.7 What this mode does not protect
Everything in §3.7, plus: the files against the operator (it can delete all of them); finer usage
patterns (per piece: size, time, channel); the users' IPs are hidden from Discord but the server's
is shared by everyone, so a Discord ban of the instance's IP or pool webhooks hits all users of the
instance.

## 5. plain

e2ee without end-to-end encryption of the metadata: the server reads the log and keeps its own
copy of every account's tree, which gives thumbnails, previews, Range streaming and search on the
server (`packages/server-discord/src/plain-ext.ts`, `packages/metadata-client/src/plain-ops.ts`).

### 5.1 What the server sees in clear
Everything. The operation payloads are JSON bound to their envelope by a `bind` field, not
encrypted and not authenticated (`PlainOpCodec`). The server applies them to a replica per
account (`<dataDir>/replicas/`), so it knows names, folders, sizes, hashes and **file keys**; it
decrypts manifests and pieces for thumbnails (cached in `<dataDir>/thumbs/`) and streaming
(`/v1/plain/file`), and searches by name. The pieces on Discord are still encrypted with the file
key (at rest), so Discord and channel members see only ciphertext. What stays sealed
with the account key: device names, share notes, the password key.

### 5.2 Webhooks
As e2ee (§4.2).

### 5.3 Does data pass through the server
As e2ee (§4.3), plus the server downloads and decrypts pieces itself (thumbnails, streaming,
previews). The server writes tree bases too (it knows the tree).

### 5.4 Server takeover
- **Read**: everything, directly.
- **Delete**: everything on Discord (§4.4).
- **Tamper**: yes. It can write any operation into the log (the `bind` field is not a MAC) and
  clients apply it; it can serve any content to its own streaming endpoint. Downloads in the
  browser still check the hashes in the manifest, but the server knows the file key and can make a
  new consistent manifest.
- **Deny service**: yes (§4.4).

### 5.5 Theft of the server database
**Enough to read every file.** The `log` table holds the operations in clear, including file keys
and manifest locations; `s_blobs` holds the attachment address of every piece. Any Discord bot can
refresh those addresses (§2.7). With the data directory: also the webhooks (§4.5) and the
thumbnails.

### 5.6 Device takeover
As e2ee (§4.6). The server already sees everything, so a stolen device adds the account key
(device names, share notes) and a session.

### 5.7 What this mode does not protect
Confidentiality against the operator, a server intruder or a database thief: none. Choose plain
only for an instance you run yourself, or where the operator is trusted with the contents. Everything in §4.7 applies too.

## 6. Known limitations and non-goals

- **No account key rotation.** Revoking a device or losing a rescue kit does not invalidate the
  account key; whoever has it can read the account and register a new device with the rescue key
  (§2.4, test in `auth.test.ts`). Recovery = new account + upload again.
- **The web app is delivered by the server** (§2.10). No code signing or pinning.
- **Usage patterns are not hidden** (§2.6): counts, sizes, times, devices. There is no padding of
  sizes.
- **Discord**: Terms of Service, deletions, bans, API changes; it is the only copy of the files
  (§2.7). Attachment addresses are lasting passes to the ciphertext.
- **Share revocation is limited** (§2.8).
- **Pairing trusts the path of the offer** (QR/clipboard), and the new device is registered
  before the codes are compared (§2.4).
- **The account key sits in the browser as raw bytes** (IndexedDB), so any script running on the
  instance's origin can read it. There is no app lock or local passphrase.
- **The password option makes the database an offline guessing target** (§2.5).
- **metadata only**: the vault rollback guard lasts one page session in the browser (§3.2);
  rebuilding from Discord without the server is not in the app and the kit is complete only with
  one webhook (§3.4).
- **e2ee / plain**: the operator can delete everything on Discord (§4.4); one server IP and one
  pool for all users (§4.7).
- **plain**: the server and a database thief read everything (§5).
- **Shared folders between accounts do not exist and are not planned.** Another person gets their own account. Pairing is never a way to share: it hands
  over the whole account.
- Out of scope here: the operator's host security, TLS termination and reverse proxy
  configuration (`apps/ddn-server/README.md`), physical security of devices.
