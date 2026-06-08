/**
 * DiscorDrive v4 — Secure Files Threat Model + Entity Model (gallery-compatible v2)
 * ================================================================================
 *
 * Changelog vs gallery-compatible v1:
 *   - [UPLOAD LIFECYCLE] FileRecord now carries explicit status and nullable
 *     primaryManifestBlobId so incomplete uploads are representable without
 *     overloading missing-manifest semantics.
 *   - [API BOUNDARY] The encrypted-manifest -> blobId -> ciphertext-fetch
 *     contract is now explicit in REQUIRED IMPLEMENTATION ARTIFACTS. The
 *     backend MUST accept client-presented blobId after manifest decrypt;
 *     server-side chunk enumeration is not the source of truth.
 *   - [KEY MODEL] Files-domain key wrapping is simplified from dual wrapped
 *     FEKs (content + metadata) to one wrapped root FEK plus HKDF-derived
 *     subkeys for content and metadata. Preview may still use its own wrapped
 *     key if separate policy is desired.
 *   - [V1 SCOPE] Folder shares are removed from v1 scope. ShareRecord is now
 *     file-only. Any future folder-share model belongs to a separate v2 spec.
 *
 * ---------------------------------------------------------------------------
 *
 * This file is simultaneously:
 *   (a) the authoritative security envelope for the secure file-storage layer,
 *       and
 *   (b) the TypeScript source of truth for entities that cross client/server.
 *
 * Every field MUST carry a visibility classifier. Any field without one is
 * a bug — review rejects it.
 *
 * VISIBILITY CLASSIFIERS (where the plaintext lives):
 *   @PLAIN_SERVER   Backend stores plaintext. Can read, index, sort, filter.
 *   @CIPHER_SERVER  Backend stores ciphertext only. Cannot read plaintext.
 *   @WRAPPED        @CIPHER_SERVER where the plaintext is a key.
 *   @CLIENT_ONLY    Never leaves the device. Not synced.
 *   @DERIVED        Not stored anywhere. Computed on demand.
 *
 * SIDE-CHANNEL / CAPABILITY TAGS (what plaintext presence enables):
 *   @LEAKS_*        Passive side channel — observable without active work.
 *                   e.g. @LEAKS_ACTIVITY_PATTERN, @LEAKS_LIBRARY_SIZE,
 *                        @LEAKS_CHUNK_SIZE_DISTRIBUTION.
 *   @ENABLES_*      Active attack capability — the field empowers a specific
 *                   query or access path the adversary can DRIVE, not just
 *                   observe.
 *
 * ENFORCEMENT TAGS (who actually enforces a policy field):
 *   @SERVER_ENFORCED        Server checks and can deny. Real security boundary.
 *   @SERVER_ENFORCED_SOFT   Server checks and can deny, but it's NOT a
 *                           cryptographic boundary — recipients who already
 *                           downloaded plaintext keep it.
 *   @CLIENT_ENFORCED        Client checks locally. Not a security boundary
 *                           against a determined client operator.
 *   @UX_ONLY                Display/filter hint. Zero enforcement by anyone.
 *
 * BOOKKEEPING ROLE (why a @PLAIN_SERVER field is plaintext at all):
 *   [access-control]   Server needs it to authorize and route requests.
 *   [sync]             Server needs it to route updates between devices.
 *   [revocation]       Server needs it to enforce future removal of access.
 *   [policy]           Server needs it to enforce user-chosen policy.
 *   [dedupe]           Server needs it to suppress duplicate ciphertext work.
 *   [crypto-bootstrap] Server must expose it before a client can derive keys.
 *   [ops]              Server needs it to maintain Discord transport state.
 *   [billing]          (future) server needs it for quota / billing.
 *
 * ---------------------------------------------------------------------------
 * DESIGN PRINCIPLES
 * ---------------------------------------------------------------------------
 *
 * P1. Zero-knowledge backend for file content and user metadata.
 *     Backend stores ciphertext, wrapped keys, and minimal bookkeeping. It
 *     does not see plaintext filenames, folder names, previews, or file bytes.
 *
 * P2. One account root, many domains.
 *     A single Account Root Key (ARK) protects domain keys for files,
 *     gallery, and future domains. Domain separation is cryptographic.
 *
 * P3. Discord is an untrusted ciphertext blob substrate.
 *     Discord stores encrypted chunks and reveals operational metadata, but is
 *     never entrusted with plaintext or reusable key material.
 *
 * P4. Bounded blast radius for share recipients.
 *     Share recipients never receive ARK or domain keys. They get only share-
 *     scoped unwrap material for explicitly granted file objects.
 *
 * P5. No false promises.
 *     Unlocked-device compromise, malicious client binaries, and already-
 *     downloaded recipient plaintext are out of scope and documented honestly.
 *
 * ---------------------------------------------------------------------------
 * THREAT MODEL
 * ---------------------------------------------------------------------------
 *
 * A1. Passive network observer
 *     Sees: TLS metadata, request timing, ciphertext blob sizes, rough upload /
 *           download cadence.
 *     Defended: file plaintext, filenames, folder names, previews, wrapped key
 *               plaintext, tags/notes if later added.
 *     NOT defended: activity timeline, approximate library size, approximate
 *               per-file size buckets unless padded.
 *
 * A2. Active MITM
 *     Same as A1 plus tampering.
 *     Defended (ciphertext integrity): all wrapped keys and encrypted blobs are
 *         AES-256-GCM authenticated. Tampering is detected client-side.
 *     Defended (transport): TLS protects plaintext policy fields from in-flight
 *         tampering.
 *     NOT defended by client-verifiable crypto: plaintext policy / lifecycle
 *         fields like share status, expiresAt, maxViews, deletedAt, upload
 *         status. A network MITM cannot alter them through TLS; a compromised
 *         backend can.
 *
 * A3. Malicious backend (API server, DB, and/or Discord blob transport)
 *     Sees: all @PLAIN_SERVER fields, all ciphertext blobs, wrapped ARK/domain
 *           material, Argon2 params, chunk routing metadata, share capability
 *           tokens, request patterns.
 *     Defended (directly): file plaintext, encrypted metadata plaintext,
 *           previews/thumbnails plaintext, FEK plaintext, AK_share plaintext.
 *     Defended (integrity): ciphertext tampering is observable through AEAD
 *           failures or ciphertext-hash mismatch checks when enabled.
 *     NOT defended (offline attack enabled): wrappedARKByPassword plus
 *           argon2Params enables offline guessing against password-derived KEKs.
 *     NOT defended (policy tampering): plaintext server-authoritative policy
 *           fields can be altered by a hostile backend.
 *     NOT defended (metadata): library size, object existence, chunk counts,
 *           share existence/expiry, activity timing, Discord routing records.
 *
 * A4. Compromised share recipient (link leaked, recipient device taken)
 *     Sees: only the files in that share, within the allowed permissions.
 *     Defended: everything else in the owner's vault. ARK/domain keys never
 *               leave the owner.
 *     NOT defended (by design): files explicitly shared. Revocation cannot
 *               retract plaintext already downloaded.
 *
 * A5. Stolen owner device, locked
 *     Sees: local wrapped key material, maybe biometric-wrapped ARK if enabled.
 *     Defended: all plaintext, assuming password/OS keystore protections hold.
 *
 * A6. Stolen owner device, unlocked session
 *     Sees: everything the user can see; ARK may be in memory.
 *     NOT defended: total compromise.
 *
 * A7. Malicious or unreliable Discord transport
 *     Sees: encrypted chunks, message IDs, channel IDs / webhook identities,
 *           ciphertext sizes, existence checks, fetch timing.
 *     Defended: plaintext file bytes and metadata plaintext.
 *     NOT defended: availability, deletion liveness, ciphertext traffic shape.
 *
 * A8. Compromised client binary / malware on owner device
 *     Sees: everything in active session, including entered password and
 *           decrypted plaintext at use time.
 *     NOT defended: client integrity is an assumption, not a defense.
 *
 * A9. Long-term cryptanalytic / quantum adversary
 *     NOT defended. Current wrap scheme is AES-256-GCM + HKDF + Argon2id.
 *     Post-quantum migration is deferred.
 *
 * ASSUMPTIONS:
 *   - Password entropy >= 60 bits for meaningful A3 resistance.
 *   - Argon2id params are security parameters, not UX decoration.
 *   - Client binary integrity and OS keystore integrity are assumptions.
 *   - TLS transport is working.
 *   - System clock is not adversarially skewed by multiple days for expiry.
 *
 * ---------------------------------------------------------------------------
 * Crypto envelope
 * ---------------------------------------------------------------------------
 */

export interface UserCryptoRecord {
  userId: string;                      // @PLAIN_SERVER [access-control]
  wrappedARKByPassword: Uint8Array;    // @WRAPPED — AES-GCM(password_KEK, ARK)
  wrappedARKByRecovery: Uint8Array;    // @WRAPPED — AES-GCM(recovery_KEK, ARK)
  argon2Params: Argon2Params;          // @PLAIN_SERVER [crypto-bootstrap]
  createdAt: string;                   // @PLAIN_SERVER [sync]
  lastPasswordChangeAt: string;        // @PLAIN_SERVER [sync]
}

export interface BiometricARKWrapLocal {
  wrappedARK: Uint8Array;              // @CLIENT_ONLY
  keystoreAlias: string;               // @CLIENT_ONLY
  createdAt: string;                   // @CLIENT_ONLY
}

export interface Argon2Params {
  memoryKB: number;                    // @PLAIN_SERVER [crypto-bootstrap]
  iterations: number;                  // @PLAIN_SERVER [crypto-bootstrap]
  parallelism: number;                 // @PLAIN_SERVER [crypto-bootstrap]
  saltB64: string;                     // @PLAIN_SERVER [crypto-bootstrap]
}

export interface DomainKeyRecord {
  userId: string;                      // @PLAIN_SERVER [access-control]
  domain: DomainId;                    // @PLAIN_SERVER [sync]
  wrappedKey: Uint8Array;              // @WRAPPED — Wrap(ARK, K_domain)
  keyVersion: number;                  // @PLAIN_SERVER [sync]
  createdAt: string;                   // @PLAIN_SERVER [sync]
}

export type DomainId = 'files' | 'gallery';

// ===========================================================================
// Files domain
// ===========================================================================

/**
 * File object metadata visible to the backend. All user-facing metadata lives
 * in encrypted blobs; the backend sees only ciphertext references and minimal
 * operational bookkeeping.
 */
export interface FileRecord {
  id: string;                          // @PLAIN_SERVER [access-control] — opaque random ID
  ownerUserId: string;                 // @PLAIN_SERVER [access-control]
  parentFolderId: string | null;       // @PLAIN_SERVER [access-control]
                                       //   Opaque relation edge only. Folder name
                                       //   itself remains encrypted.

  dedupeTokenB64?: string;             // @PLAIN_SERVER [dedupe]
                                       // @LEAKS_SAME_USER_DUPLICATES

  // Blob / transport roots
  primaryManifestBlobId: string | null; // @PLAIN_SERVER [access-control]
                                        //   Null while upload is in-progress or
                                        //   before manifest commit completes.
  previewBlobId?: string;              // @PLAIN_SERVER [access-control]

  // Wrapped object keys
  wrappedFEK: Uint8Array;              // @WRAPPED — Wrap(K_files, FEK_root)
  wrappedFEKPreview?: Uint8Array;      // @WRAPPED — optional preview/thumbnail key

  // Minimal server-visible metadata
  status: 'uploading' | 'ready' | 'failed'; // @PLAIN_SERVER [sync] @SERVER_ENFORCED
  totalCiphertextBytes: number;        // @PLAIN_SERVER [sync]
                                       // @LEAKS_CONTENT_HINT
  chunkCount: number;                  // @PLAIN_SERVER [sync] @LEAKS_CONTENT_HINT
  createdAt: string;                   // @PLAIN_SERVER [sync] @LEAKS_ACTIVITY_PATTERN
  updatedAt: string;                   // @PLAIN_SERVER [sync]
  deletedAt: string | null;            // @PLAIN_SERVER [sync]

  /**
   * Lifecycle invariants:
   *   - status='ready'  => primaryManifestBlobId != null
   *   - status='uploading' => primaryManifestBlobId may be null
   *   - status='failed' => object MUST NOT be treated as downloadable/shareable
   *     until a successful resume/retry transitions it to 'ready'.
   *
   * Delete invariants (one transaction with deletedAt flip):
   *   1. Remove this file from every active ShareRecord.wrappedObjectKeys[].
   *   2. Remove or tombstone folder membership edges referencing this file.
   *   3. Blob GC is separate policy (OpenDecision 7).
   */
}

/**
 * Ciphertext body decrypted under FEK_metadata, where:
 *   FEK_content  = HKDF(FEK_root, "ddv4-file-content-v1")
 *   FEK_metadata = HKDF(FEK_root, "ddv4-file-metadata-v1")
 *
 * This preserves cryptographic separation while keeping only one wrapped root
 * FEK on the server.
 */
export interface FileMetadataPlaintext {
  schemaVersion: number;
  fileName: string;                    // @CIPHER_SERVER
  mimeType: string;                    // @CIPHER_SERVER
  plaintextSizeBytes: number;          // @CIPHER_SERVER
  capturedAt?: string;                 // @CIPHER_SERVER
  description?: string;                // @CIPHER_SERVER
  tags: TimestampedTag[];              // @CIPHER_SERVER
  removedTags: TimestampedTag[];       // @CIPHER_SERVER
  favorite: boolean;                   // @CIPHER_SERVER
  hidden: boolean;                     // @CIPHER_SERVER
  provider?: ProviderInfo;             // @CIPHER_SERVER
  scalarLWW: Partial<Record<FileScalarLWWKey, string>>; // @CIPHER_SERVER
}

export type FileScalarLWWKey =
  | 'fileName'
  | 'mimeType'
  | 'plaintextSizeBytes'
  | 'capturedAt'
  | 'description'
  | 'favorite'
  | 'hidden'
  | 'provider';

export interface TimestampedTag {
  tag: string;
  at: string;
}

/**
 * Encrypted manifest describing chunk assembly. The client decrypts this
 * manifest and learns the blobIds to fetch next.
 */
export interface FileChunkManifestPlaintext {
  schemaVersion: number;
  chunkSizeBytes: number;              // @CIPHER_SERVER
  chunks: FileChunkPointer[];          // @CIPHER_SERVER
}

export interface FileChunkPointer {
  index: number;                       // @CIPHER_SERVER
  blobId: string;                      // @CIPHER_SERVER
  ciphertextSizeBytes: number;         // @CIPHER_SERVER
  ciphertextHash?: string;             // @CIPHER_SERVER
}

/**
 * Operational Discord mapping row. The backend must locate ciphertext blobs on
 * Discord, so this transport mapping is plaintext server-side.
 */
export interface BlobTransportRecord {
  blobId: string;                      // @PLAIN_SERVER [access-control]
  ownerUserId: string;                 // @PLAIN_SERVER [access-control]
  discordMessageId: string;            // @PLAIN_SERVER [ops]
  discordChannelId: string;            // @PLAIN_SERVER [ops]
  webhookId: string;                   // @PLAIN_SERVER [ops]
  ciphertextSizeBytes: number;         // @PLAIN_SERVER [ops] @LEAKS_CONTENT_HINT
  ciphertextHash?: string;             // @PLAIN_SERVER [ops]
  healthStatus?: BlobHealthStatus;     // @PLAIN_SERVER [ops]
  healthCheckedAt?: string;            // @PLAIN_SERVER [ops]
  createdAt: string;                   // @PLAIN_SERVER [ops]
}

export type BlobHealthStatus = 'healthy' | 'missing' | 'modified';

export interface FolderRecord {
  id: string;                          // @PLAIN_SERVER [access-control]
  ownerUserId: string;                 // @PLAIN_SERVER [access-control]
  parentFolderId: string | null;       // @PLAIN_SERVER [access-control]
  encryptedBody: Uint8Array;           // @CIPHER_SERVER — folder name, notes, etc.
  wrappedFolderKey: Uint8Array;        // @WRAPPED — Wrap(K_files, K_folder)
  itemCount: number;                   // @PLAIN_SERVER [sync] @LEAKS_LIBRARY_SIZE
  createdAt: string;                   // @PLAIN_SERVER [sync]
  updatedAt: string;                   // @PLAIN_SERVER [sync]
}

export interface FolderBodyPlaintext {
  name: string;                        // @CIPHER_SERVER
  description?: string;                // @CIPHER_SERVER
}

// ===========================================================================
// Sharing (v1 = file-only)
// ===========================================================================

/**
 * ShareRecord for file-object sharing.
 *
 * LINK FORMAT — INVARIANT
 *   https://discordrive.cikowice.pl/s/<shareId>#<linkSecret>
 *
 * Capability flow mirrors the gallery model, but v1 scope is FILE-ONLY.
 * Folder shares are explicitly out of scope for this version.
 */
export interface ShareRecord {
  shareId: string;                     // @PLAIN_SERVER [access-control]
  ownerUserId: string;                 // @PLAIN_SERVER [access-control]
  capabilityToken: Uint8Array;         // @PLAIN_SERVER [access-control]
                                       // @ENABLES_CAPABILITY_ACCESS
  shareType: 'file';                   // @PLAIN_SERVER [sync]

  allowContent: boolean;               // @PLAIN_SERVER [policy] @SERVER_ENFORCED
  allowMetadata: boolean;              // @PLAIN_SERVER [policy] @SERVER_ENFORCED
  allowPreview: boolean;               // @PLAIN_SERVER [policy] @SERVER_ENFORCED

  status: 'active' | 'revoked' | 'expired'; // @PLAIN_SERVER [revocation] @SERVER_ENFORCED
  expiresAt?: string;                  // @PLAIN_SERVER [revocation] @SERVER_ENFORCED
  maxViews?: number;                   // @PLAIN_SERVER [policy] @SERVER_ENFORCED_SOFT
  viewCount: number;                   // @PLAIN_SERVER [policy]
  createdAt: string;                   // @PLAIN_SERVER [sync]
  revokedAt?: string;                  // @PLAIN_SERVER [revocation]

  grantedAccess: GrantedAccess[];
  wrappedObjectKeys: ShareWrappedObjectKey[];
}

export interface GrantedAccess {
  accessId: string;                    // @PLAIN_SERVER [access-control]
  accessType: 'public_link';           // @PLAIN_SERVER [access-control]
  wrappedAKShare: Uint8Array;          // @WRAPPED — AES-GCM(K_wrap, AK_share)
  createdAt: string;                   // @PLAIN_SERVER [sync]
  revokedAt?: string;                  // @PLAIN_SERVER [revocation]
  expiresAt?: string;                  // @PLAIN_SERVER [revocation] @SERVER_ENFORCED
}

export interface ShareWrappedObjectKey {
  fileId: string;                      // @PLAIN_SERVER [access-control]
  wrappedFEK?: Uint8Array;             // @WRAPPED — present iff allowContent or allowMetadata
  wrappedFEKPreview?: Uint8Array;      // @WRAPPED — present iff allowPreview=true
}

export interface ProviderInfo {
  mode: 'local' | 'hybrid' | 'external';
  providerName?: string;
  providerVersion?: string;
  modelName?: string;
  analyzedAt: string;
}

// ===========================================================================
// REQUIRED IMPLEMENTATION ARTIFACTS
// ===========================================================================
/**
 * crypto.ts — single source of truth for cryptographic operations.
 * Responsibilities:
 *   - ARK generation and wrapping
 *   - Domain key derivation / wrapping
 *   - FEK_root generation for files
 *   - HKDF subkey derivation:
 *       FEK_content  = HKDF(FEK_root, "ddv4-file-content-v1")
 *       FEK_metadata = HKDF(FEK_root, "ddv4-file-metadata-v1")
 *   - Optional preview key generation if preview gets separate sharing policy
 *   - HKDF info strings for files-domain share flow
 *   - AES-256-GCM wrap / unwrap and chunk encryption
 *   - capabilityToken derivation and constant-time compare
 *   - ciphertext hash helpers for Discord integrity checks
 *   - serialization rules for Uint8Array fields
 *
 * merge.ts — single source of truth for files metadata CRDT semantics.
 * Responsibilities:
 *   - tags / removedTags as LWW-Element-Set
 *   - scalarLWW merge for fileName, description, hidden, favorite, etc.
 *   - schemaVersion selection and future sidecar merge semantics
 *
 * transport.ts / discord-client layer
 * Responsibilities:
 *   - upload ciphertext blobs to Discord
 *   - fetch ciphertext blobs from Discord
 *   - maintain BlobTransportRecord lifecycle
 *   - perform health checks and best-effort deletion
 *
 * API boundary invariant — MUST be explicit in implementation:
 *   - The decrypted FileChunkManifestPlaintext is the authoritative source of
 *     chunk/blob ordering for a file.
 *   - The client decrypts the manifest, reads blobId values, then requests
 *     ciphertext blobs by presenting those blobIds to the backend.
 *   - The backend endpoint (e.g. GET /blob/:blobId or equivalent) MUST accept
 *     client-presented blobId and authorize/map it via BlobTransportRecord.
 *   - The backend MUST NOT be the authoritative enumerator of per-file chunk
 *     lists for download. An API like GET /file/:fileId/chunks that reveals or
 *     reconstructs chunk order server-side would violate this architecture.
 *
 * Invariants these modules enforce:
 *   - No primitive use outside crypto.ts
 *   - No HKDF info string construction outside crypto.ts
 *   - No user-facing metadata stored plaintext outside explicit @PLAIN_SERVER
 *     bookkeeping fields in this spec
 *   - No share policy flip may leave wrappedObjectKeys inconsistent with allow*
 *     flags
 *   - status='ready' files always have a non-null primaryManifestBlobId
 */

// ===========================================================================
// OPEN DECISIONS — resolve in code, not in more documents
// ===========================================================================
/**
 * 1. Folder graph leakage
 *    Current proposal keeps parentFolderId plaintext but folder names encrypted.
 *    Resolve by: deciding whether relation leakage is acceptable for v1 or if
 *    opaque encrypted tree snapshots are needed.
 *
 * 2. File-size padding
 *    Current proposal still leaks totalCiphertextBytes/chunkCount.
 *    Resolve by: implementing coarse-grained padding before first public beta.
 *
 * 3. Preview policy
 *    Current proposal allows encrypted preview sidecars with separate FEK.
 *    Resolve by: deciding whether previews are mandatory, optional, or omitted.
 *
 * 4. Dedupe scope
 *    Current proposal allows per-user keyed dedupe token.
 *    Resolve by: shipping keyed per-user dedupe or falling back to client-local
 *    duplicate suppression only.
 *
 * 5. Ciphertext-hash persistence
 *    Current proposal supports ciphertextHash in manifest / transport rows for
 *    Discord integrity checks.
 *    Resolve by: deciding whether always-on integrity verification is worth the
 *    bandwidth/CPU cost.
 *
 * 6. Blob retention after soft-delete
 *    Options: immediate GC, grace-period trash, or indefinite retention until
 *    explicit purge. Logical visibility revocation applies immediately in all
 *    cases.
 *
 * 7. Migration path from current repo
 *    Existing schema stores plaintext filename/mimeType and legacy share-link
 *    wrappedFEK rows. Resolve by: writing a migration that re-encrypts metadata,
 *    introduces ARK/domain keys, and replaces legacy share links.
 *
 * 8. Folder shares (v2 only)
 *    Explicitly OUT OF SCOPE for v1. If ever added, they require a separate
 *    spec covering snapshot vs live membership, recursive propagation of share
 *    material, move/delete semantics, and sync invariants.
 *
 * -------------------------------------------------------------------
 * If you find yourself weakening confidentiality for convenience, document the
 * leak explicitly in this file first. Unstated leaks are bugs.
 * -------------------------------------------------------------------
 */
