/**
 * DiscorDrive v4 — Threat Model + Entity Model (current-architecture draft)
 * ========================================================================
 *
 * This file is simultaneously:
 *   (a) the authoritative security envelope for the CURRENT DiscorDrive v4
 *       architecture as implemented today, and
 *   (b) a TypeScript source-of-truth sketch for entities that cross the
 *       client / API / Discord-storage boundary.
 *
 * SCOPE NOTE:
 *   This document describes the repo AS IT EXISTS NOW. It is intentionally
 *   narrower and less ambitious than the DDv4 Gallery spec. Where the current
 *   architecture is weaker, simpler, or operationally messy, this document
 *   says so explicitly instead of projecting a future-state design onto the
 *   present codebase.
 *
 * EVERY FIELD below MUST carry a visibility classifier comment. Any field
 * without one should be treated as a documentation bug.
 *
 * ---------------------------------------------------------------------------
 * VISIBILITY CLASSIFIERS (where the plaintext lives)
 * ---------------------------------------------------------------------------
 *   @PLAIN_SERVER   Backend stores plaintext and can read it.
 *   @CIPHER_SERVER  Backend stores ciphertext only.
 *   @WRAPPED        @CIPHER_SERVER where plaintext is itself key material.
 *   @CLIENT_ONLY    Never leaves the client device.
 *   @DERIVED        Computed on demand; not durably stored.
 *
 * SIDE-CHANNEL / CAPABILITY TAGS
 *   @LEAKS_*        Passive observability side-channel.
 *   @ENABLES_*      Field grants an active capability if possessed.
 *
 * ENFORCEMENT TAGS
 *   @SERVER_ENFORCED        Server can deny the action.
 *   @SERVER_ENFORCED_SOFT   Server can deny future fetches, but cannot retract
 *                           plaintext already obtained.
 *   @CLIENT_ENFORCED        Enforced only by the client.
 *   @UX_ONLY                Mere display hint.
 *
 * BOOKKEEPING ROLE
 *   [access-control]   Server needs plaintext to authorize and route requests.
 *   [sync]             Server needs plaintext for record lifecycle / listing.
 *   [policy]           Server needs plaintext to enforce a user-visible policy.
 *   [revocation]       Server needs plaintext to remove future access.
 *   [crypto-bootstrap] Server must provide plaintext bootstrap inputs for the
 *                      client to derive keys before content decrypt is possible.
 *   [integrity]        Server stores plaintext integrity metadata for checking.
 *   [ops]              Operational metadata for Discord transport / repair.
 *
 * ---------------------------------------------------------------------------
 * DESIGN PRINCIPLES (CURRENT ARCHITECTURE)
 * ---------------------------------------------------------------------------
 *
 * P1. Client-side content encryption before upload.
 *     File bytes are encrypted in the client with a per-file FEK before
 *     chunk upload to Discord-backed storage.
 *
 * P2. Password-wrapped account keying.
 *     Each user has one client-generated Master Key wrapped under a KEK
 *     derived from the login password via Argon2id.
 *
 * P3. Discord is treated as blob transport, not trust anchor.
 *     Discord stores encrypted chunks; the API + DB store metadata needed
 *     to find and reassemble them.
 *
 * P4. Share links deliberately narrow scope to one file at a time.
 *     A share link exposes only one file's wrapped FEK, not the account's
 *     Master Key and not any broader folder/account scope.
 *
 * P5. No false claims about metadata privacy.
 *     The current backend sees filenames, MIME types, sizes, timestamps,
 *     folder structure, share policies, and chunk routing metadata.
 *
 * ---------------------------------------------------------------------------
 * THREAT MODEL
 * ---------------------------------------------------------------------------
 *
 * A1. Passive network observer
 *     Sees: TLS metadata, request timing, approximate payload sizes.
 *     Defended: file plaintext, FEKs, Master Key, chunk plaintext.
 *     NOT defended: timing patterns, library growth pattern, rough upload size.
 *
 * A2. Active network MITM
 *     Defended: TLS for transport, AES-GCM auth tag for encrypted chunk and
 *               wrapped-key integrity on the client.
 *     NOT defended by client-verifiable crypto: plaintext API metadata fields
 *               such as filename, folderId, expiresAt, downloads, maxDownloads.
 *               TLS stops network tampering; a hostile backend can still lie.
 *
 * A3. Malicious backend and/or database operator
 *     Sees: all @PLAIN_SERVER fields, wrapped Master Keys, wrapped FEKs,
 *           share-link wrapped FEKs, chunk hashes, Discord message routing data.
 *     Defended directly: original file plaintext and FEK plaintext, assuming
 *                        password entropy is sufficient and Web Crypto / Argon2
 *                        primitives hold.
 *     NOT defended: offline password guessing against encryptedMasterKey using
 *                   kekSalt and the wrapped blob; filename privacy; MIME type
 *                   privacy; folder graph privacy; file size privacy; share
 *                   policy tampering; download-counter tampering.
 *
 * A4. Compromised share recipient / leaked share URL
 *     Sees: one file's wrappedFEK, file metadata returned by share info, and
 *           downloaded ciphertext chunks for that file.
 *     Defended: all other files, all other FEKs, owner's Master Key.
 *     NOT defended by design: the shared file itself.
 *
 * A5. Locked but stolen owner device
 *     Sees: whatever client state is stored locally (outside this document's
 *           current server-side scope), plus wrapped keys cached in memory or
 *           storage if the app keeps them. Protection depends on OS lockscreen
 *           and whether the app persisted decrypted keys.
 *
 * A6. Unlocked owner session / malware on active client
 *     Sees: everything the user can access, including password entry and
 *           in-memory decrypted keys. Not defended.
 *
 * A7. Malicious or unreliable Discord blob transport
 *     Sees: encrypted chunks, Discord message IDs, channel IDs, webhook usage,
 *           chunk sizes, upload/download timing.
 *     Defended: plaintext chunk contents.
 *     NOT defended: chunk existence, availability, and ciphertext replacement
 *                   attempts. Integrity detection is only partial today:
 *                   encryptedHash exists for health checks, but routine fetch
 *                   validation still relies primarily on AES-GCM failure at the
 *                   final decrypting client.
 *
 * A8. Compromised frontend binary
 *     Not defended. A malicious client can exfiltrate plaintext before encrypt,
 *     steal passwords, or leak keys after decrypt.
 *
 * ASSUMPTIONS
 *   - TLS is correctly terminated end-to-end for browser↔API traffic.
 *   - Password entropy is high enough to make offline guessing costly.
 *   - Browser Web Crypto and hash-wasm Argon2id behave as specified.
 *   - The client encrypts before upload; plaintext uploads are out of scope.
 *   - The API is trusted to map the authenticated user to the correct records.
 *
 * ---------------------------------------------------------------------------
 * CRYPTO ENVELOPE (CURRENT IMPLEMENTATION)
 * ---------------------------------------------------------------------------
 */

/**
 * User account crypto bootstrap as implemented today.
 *
 * The client derives a KEK from password + kekSalt via Argon2id, generates a
 * random AES-GCM Master Key, wraps it with that KEK, and sends only the
 * wrapping output plus bootstrap parameters to the server.
 *
 * IMPORTANT CURRENT LIMITATION:
 *   The current schema stores only `kekSalt`, `wrapIv`, and
 *   `encryptedMasterKey`. Argon2 parameters are taken from shared app config,
 *   not per-user persisted records. That means future parameter migration is an
 *   application-wide rollout concern, not a per-record negotiated property.
 */
export interface UserCryptoRecordCurrent {
  userId: string;                      // @PLAIN_SERVER [access-control]
  email: string;                       // @PLAIN_SERVER [access-control]
  username: string | null;             // @PLAIN_SERVER [access-control]
  passwordHash: string;                // @PLAIN_SERVER [access-control]
                                       //   Server uses this for login auth.
                                       //   This is NOT the KEK and does NOT
                                       //   itself decrypt content.
  kekSalt: string;                     // @PLAIN_SERVER [crypto-bootstrap]
                                       //   Base64 salt used client-side for
                                       //   Argon2id(password, salt) -> KEK.
  wrapIv: string;                      // @PLAIN_SERVER [crypto-bootstrap]
                                       //   AES-GCM IV used when wrapping the
                                       //   Master Key under the KEK.
  encryptedMasterKey: string;          // @WRAPPED — AES-GCM(KEK, MasterKey)
  createdAt: string;                   // @PLAIN_SERVER [sync]
}

/**
 * Per-file metadata envelope.
 *
 * NOTE: unlike the stricter gallery spec, the current DiscorDrive backend sees
 * plaintext filename and MIME type. The server therefore has a materially more
 * revealing view of the user's library.
 */
export interface FileRecordCurrent {
  id: string;                          // @PLAIN_SERVER [access-control]
  userId: string;                      // @PLAIN_SERVER [access-control]
  folderId: string | null;             // @PLAIN_SERVER [sync]
  name: string;                        // @PLAIN_SERVER [sync] @LEAKS_FILENAME
  mimeType: string;                    // @PLAIN_SERVER [sync] @LEAKS_CONTENT_HINT
  size: string;                        // @PLAIN_SERVER [sync] @LEAKS_CONTENT_HINT
  chunkSize: number;                   // @PLAIN_SERVER [sync]
  chunkCount: number;                  // @PLAIN_SERVER [sync] @LEAKS_CONTENT_HINT
  encryptedFEK: string;                // @WRAPPED — AES-GCM(MasterKey, FEK)
  fekIv: string;                       // @PLAIN_SERVER [crypto-bootstrap]
                                       //   Needed to unwrap encryptedFEK.
  sha256: string | null;               // @PLAIN_SERVER [integrity]
                                       //   Hash of original plaintext file as
                                       //   provided at finalizeUpload time.
                                       //   This is sensitive content-derived
                                       //   metadata and enables exact equality
                                       //   checks if an attacker knows the file.
                                       //   Therefore treat as:
                                       //   @ENABLES_KNOWN_PLAINTEXT_CORRELATION
  thumbnailUrl: string | null;         // @PLAIN_SERVER [sync]
                                       //   Current repo stores this pointer in
                                       //   plaintext if present.
  status: 'UPLOADING' | 'READY' | 'FAILED'; // @PLAIN_SERVER [sync] @SERVER_ENFORCED
  createdAt: string;                   // @PLAIN_SERVER [sync] @LEAKS_ACTIVITY_PATTERN
}

/**
 * Discord chunk routing metadata.
 *
 * Each encrypted chunk is uploaded to Discord via webhook and tracked by the
 * API database so the system can later re-fetch, repair, or delete it.
 */
export interface ChunkRecordCurrent {
  id: string;                          // @PLAIN_SERVER [access-control]
  fileId: string;                      // @PLAIN_SERVER [access-control]
  index: number;                       // @PLAIN_SERVER [sync]
  messageId: string;                   // @PLAIN_SERVER [ops]
  channelId: string;                   // @PLAIN_SERVER [ops]
  webhookId: string;                   // @PLAIN_SERVER [ops]
  size: number;                        // @PLAIN_SERVER [ops] @LEAKS_CONTENT_HINT
  encryptedHash: string | null;        // @PLAIN_SERVER [integrity]
                                       //   Hash of encrypted bytes stored on
                                       //   Discord. Useful for health checks,
                                       //   but also a stable ciphertext handle.
  healthStatus: 'HEALTHY' | 'MISSING' | 'MODIFIED' | null; // @PLAIN_SERVER [ops]
  healthCheckedAt: string | null;      // @PLAIN_SERVER [ops]
}

/**
 * Plain folder tree. Current architecture does NOT encrypt folder names or the
 * parent/child relationship.
 */
export interface FolderRecordCurrent {
  id: string;                          // @PLAIN_SERVER [access-control]
  userId: string;                      // @PLAIN_SERVER [access-control]
  parentId: string | null;             // @PLAIN_SERVER [sync]
  name: string;                        // @PLAIN_SERVER [sync] @LEAKS_FILENAME
  createdAt: string;                   // @PLAIN_SERVER [sync] @LEAKS_ACTIVITY_PATTERN
}

/**
 * Share link record as implemented today.
 *
 * CURRENT MODEL:
 *   - The owner client creates a random share key.
 *   - The owner client wraps the file FEK under that share key.
 *   - The server stores the wrapped FEK plus policy metadata.
 *   - The share URL/token identifies the server-side record.
 *   - The recipient needs the out-of-band/client-provided share key material
 *     to unwrap the FEK after retrieving share info.
 *
 * IMPORTANT CURRENT LIMITATION:
 *   The repo's current implementation does not model a formal capabilityToken /
 *   wrappedAKShare flow. Access is keyed by `token`, plus optional server-side
 *   password verification. This is simpler than the newer gallery design and
 *   should be documented honestly as such.
 */
export interface ShareLinkRecordCurrent {
  token: string;                       // @PLAIN_SERVER [access-control]
                                       // @ENABLES_SHARE_LOOKUP
  fileId: string;                      // @PLAIN_SERVER [access-control]
  userId: string;                      // @PLAIN_SERVER [access-control]
  wrappedFEK: string;                  // @WRAPPED — AES-GCM(shareKey, FEK)
  wrapIv: string;                      // @PLAIN_SERVER [crypto-bootstrap]
  passwordHash: string | null;         // @PLAIN_SERVER [policy] @SERVER_ENFORCED_SOFT
                                       //   Optional server-side gate before
                                       //   returning share material / allowing
                                       //   download flow to continue.
  passwordSalt: string | null;         // @PLAIN_SERVER [crypto-bootstrap]
                                       //   CURRENT CODE NOTE: semantics are
                                       //   inconsistent / effectively unused.
                                       //   The resolver currently nulls it out.
  expiresAt: string | null;            // @PLAIN_SERVER [revocation] @SERVER_ENFORCED_SOFT
  label: string | null;                // @PLAIN_SERVER [sync]
  downloads: number;                   // @PLAIN_SERVER [policy] @SERVER_ENFORCED_SOFT
  maxDownloads: number | null;         // @PLAIN_SERVER [policy] @SERVER_ENFORCED_SOFT
  createdAt: string;                   // @PLAIN_SERVER [sync] @LEAKS_ACTIVITY_PATTERN
}

/**
 * Share info returned to recipients.
 *
 * This is narrower than the owner's full file record but still leaks plaintext
 * file metadata to the backend and any bearer of the share token.
 */
export interface ShareInfoResponseCurrent {
  fileName: string;                    // @PLAIN_SERVER [access-control] @LEAKS_FILENAME
  fileSize: string;                    // @PLAIN_SERVER [access-control] @LEAKS_CONTENT_HINT
  mimeType: string;                    // @PLAIN_SERVER [access-control] @LEAKS_CONTENT_HINT
  wrappedFEK: string;                  // @WRAPPED
  wrapIv: string;                      // @PLAIN_SERVER [crypto-bootstrap]
  isPasswordProtected: boolean;        // @PLAIN_SERVER [policy]
  chunkCount: number;                  // @PLAIN_SERVER [access-control]
  chunkSize: number;                   // @PLAIN_SERVER [access-control]
}

// ===========================================================================
// REQUIRED CURRENT-WORLD INVARIANTS
// ===========================================================================
/**
 * I1. File content MUST be encrypted before chunk upload.
 *     The FEK encrypts each chunk with AES-GCM; the output persisted to Discord
 *     includes the IV prepended to ciphertext.
 *
 * I2. encryptedFEK MUST be unwrap-able only with the user's Master Key.
 *     The backend stores the ciphertext but never receives FEK plaintext.
 *
 * I3. finalizeUpload may mark a file READY only when every expected chunk index
 *     exists in the DB for that file.
 *
 * I4. Deleting a file deletes DB metadata first and only then performs best-
 *     effort Discord message deletion in the background. Therefore DB removal
 *     is the logical source of truth; Discord physical deletion is eventual and
 *     may fail.
 *
 * I5. Share expiry / maxDownloads are server-authoritative soft policies.
 *     They can block future server-mediated retrieval but cannot claw back
 *     plaintext already downloaded by a recipient.
 *
 * I6. Health-check integrity compares downloaded encrypted bytes against the
 *     stored encryptedHash when available. This checks Discord-stored blob
 *     stability, not end-user plaintext semantics.
 */

// ===========================================================================
// REQUIRED IMPLEMENTATION ARTIFACTS (CURRENT ARCHITECTURE)
// ===========================================================================
/**
 * crypto.ts (already exists in practice under packages/processing/src/crypto.ts)
 * Responsibilities today:
 *   - Argon2id(password, salt) -> KEK
 *   - AES-GCM Master Key generation
 *   - AES-GCM key wrapping for MasterKey->FEK and shareKey->FEK
 *   - AES-GCM chunk encryption/decryption
 *   - random salt / IV / byte generation
 *   - base64 serialization helpers
 *
 * Current caveats:
 *   - HKDF-based domain separation does not exist yet.
 *   - Per-user persisted Argon2 params do not exist yet.
 *   - There is no formal server-side constant-time share capability token flow.
 *
 * health.ts
 * Responsibilities today:
 *   - Existence checks for Discord-hosted chunks
 *   - Optional encryptedHash verification
 *   - Persist healthStatus / healthCheckedAt
 *
 * sharing.ts
 * Responsibilities today:
 *   - Create / update / delete share-link records
 *   - Enforce expiresAt and maxDownloads on lookup
 *   - Verify optional share password via Argon2
 *   - Increment download counters
 *
 * Current caveat in sharing.ts:
 *   - passwordSalt handling is inconsistent in the implementation and should be
 *     considered a correctness/documentation bug, not a stable contract.
 */

// ===========================================================================
// OPEN DECISIONS / KNOWN GAPS FOR CURRENT DISCORDRIVE
// ===========================================================================
/**
 * 1. Filename privacy
 *    Current state: filenames and folder names are plaintext server-side.
 *    Resolve by: deciding whether server-side search/sort convenience is worth
 *    the privacy trade-off, or whether names must move into ciphertext.
 *
 * 2. Plaintext file hash exposure
 *    Current state: File.sha256 is stored server-side in plaintext.
 *    This enables exact known-plaintext correlation for anyone who can query
 *    or dump the DB.
 *    Resolve by: either removing it, replacing it with keyed/hash-local use,
 *    or formally accepting the leak.
 *
 * 3. Share-link password model
 *    Current state: server verifies passwordHash, but passwordSalt semantics in
 *    code are muddled and appear vestigial.
 *    Resolve by: simplifying the field model or redesigning share auth.
 *
 * 4. Share-key transport documentation
 *    Current state: FEK is wrapped under a share key client-side, but the
 *    durable model of how the recipient reliably obtains that share key is not
 *    described in one authoritative security document.
 *    Resolve by: specifying exact link format / fragment policy / recovery UX.
 *
 * 5. Metadata minimization
 *    Current state: MIME type, size, folder graph, upload times, chunk routing,
 *    and share policy are all visible to the backend.
 *    Resolve by: explicitly accepting this as product scope or reducing it.
 *
 * 6. Discord blob deletion guarantees
 *    Current state: best-effort background deletion after DB delete.
 *    Resolve by: deciding whether eventual orphaned ciphertext on Discord is an
 *    accepted operational risk.
 *
 * 7. Integrity coverage on normal download path
 *    Current state: health checks can validate encryptedHash, but regular file
 *    download correctness relies mainly on successful AES-GCM decrypt.
 *    Resolve by: deciding whether routine encryptedHash verification is needed.
 *
 * 8. Per-user Argon2 migration
 *    Current state: parameters live in app config, not per-user records.
 *    Resolve by: adding persisted params if future upgrades / device-class
 *    tuning matter.
 *
 * -------------------------------------------------------------------
 * If a future document claims stronger properties than the current code
 * actually enforces, that future document must be treated as aspirational,
 * not descriptive. This file is deliberately descriptive.
 * -------------------------------------------------------------------
 */
