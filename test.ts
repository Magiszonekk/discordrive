/**
 * DDv4 Gallery — Threat Model + Entity Model
 * ===========================================
 *
 * This file is simultaneously:
 *   (a) the authoritative security envelope for the gallery layer, and
 *   (b) the TypeScript source of truth for entities that cross client/server.
 *
 * Every field carries a visibility classifier. Any field without one is a bug —
 * review rejects it. Classifiers:
 *
 *   @PLAIN_SERVER   Backend stores plaintext. Can read, index, sort, filter.
 *   @CIPHER_SERVER  Backend stores ciphertext only. Cannot read.
 *   @WRAPPED        @CIPHER_SERVER where the plaintext is a key.
 *   @CLIENT_ONLY    Never leaves the device. Not synced.
 *   @DERIVED        Not stored anywhere. Computed on demand.
 *   @LEAKS_*        Side-channel flag paired with @PLAIN_SERVER to warn what's visible.
 *
 * ---------------------------------------------------------------------------
 * THREAT MODEL
 * ---------------------------------------------------------------------------
 *
 * A1. Passive network observer
 *     Sees: TLS metadata, ciphertext blob sizes, request timing.
 *     Defended: file contents, keys, metadata, tags, filenames.
 *     NOT defended: timeline of activity, approximate library size.
 *
 * A2. Active MITM
 *     Same as A1 plus tampering. Defended by TLS + client-verified MACs on
 *     critical records (wrapped ARK verifier, share capabilityVerifier).
 *
 * A3. Malicious backend (our API server and/or Discord blob storage)
 *     Sees: all @PLAIN_SERVER fields, all ciphertext blobs, request patterns.
 *     Defended: plaintext of originals, thumbnails, enrichment; any key material.
 *     NOT defended: blob sizes, createdAt/updatedAt timelines, album member counts,
 *                   existence and expiry of shares, rough activity patterns.
 *     Key property: backend cannot unwrap ARK. Password never reaches server in any form.
 *
 * A4. Compromised share recipient (link leaked, or recipient's device taken
 *     after they opened the share).
 *     Sees: items in that one share, with permissions per allowOriginal / allowThumbnail
 *           / allowMetadata.
 *     Defended: everything else in owner's vault. ARK and domain keys never leave
 *               owner. This is the bounded-blast-radius property — recipient
 *               compromise !== owner compromise.
 *     NOT defended (by design): the items deliberately shared.
 *
 * A5. Stolen owner device, locked
 *     Sees: local wrapped key material.
 *     Defended: all plaintext — attacker still needs password or biometric unlock.
 *
 * A6. Stolen owner device, unlocked session
 *     Sees: everything the user can see. ARK is in memory.
 *     NOT defended: total compromise. Mitigation is OS-level (screen lock, remote
 *                   wipe). We do not pretend to defend against this.
 *
 * A7. Malicious AI provider (hybrid or external mode)
 *     Sees: only media the user's policy sends for enrichment. In external mode
 *           this is decrypted plaintext of individual items.
 *     Defended: everything else — all other items, all keys, all enrichment of
 *               non-sent items.
 *     Key property: provider mode is a labeled trust boundary. Users opt in per mode.
 *
 * A8. Long-term cryptanalytic / quantum adversary
 *     NOT defended. Current wrap scheme is AES-256-GCM + X25519/Ed25519 where
 *     asymmetric primitives apply. Post-quantum migration is an explicit future
 *     decision (see OpenDecision 10), not today.
 *
 * Assumptions:
 *   - Client binary integrity (not defending against a backdoored build).
 *   - OS keystore integrity (biometric ARK wrap relies on Android Keystore /
 *     iOS Secure Enclave).
 *   - Password entropy >= 60 bits OR biometric fallback is enrolled.
 *   - TLS transport is working.
 *   - Argon2id parameters are tuned per device class (not hardcoded).
 *   - System clock is not adversarially skewed by multiple days (expiry correctness).
 */

// ===========================================================================
// Crypto envelope
// ===========================================================================

export interface UserCryptoRecord {
  userId: string;                      // @PLAIN_SERVER — access control
  wrappedARKByPassword: Uint8Array;    // @WRAPPED — Wrap(password_KEK, ARK)
  wrappedARKByRecovery: Uint8Array;    // @WRAPPED — Wrap(recovery_KEK, ARK)
  argon2Params: Argon2Params;          // @PLAIN_SERVER — needed to derive KEK on client
  passwordVerifier: Uint8Array;        // @PLAIN_SERVER — e.g. HMAC of fixed string under password_KEK
  recoveryVerifier: Uint8Array;        // @PLAIN_SERVER — same idea for recovery phrase
  createdAt: string;                   // @PLAIN_SERVER
  lastPasswordChangeAt: string;        // @PLAIN_SERVER
}

/**
 * Biometric unlock is device-local only. The keystore-wrapped ARK never touches
 * the server — it's derived from the active session after a password unlock,
 * then wrapped under an OS-bound key and stashed locally.
 */
export interface BiometricARKWrapLocal {
  wrappedARK: Uint8Array;              // @CLIENT_ONLY
  keystoreAlias: string;               // @CLIENT_ONLY
  createdAt: string;                   // @CLIENT_ONLY
}

export interface Argon2Params {
  memoryKB: number;
  iterations: number;
  parallelism: number;
  saltB64: string;
}

export interface DomainKeyRecord {
  userId: string;                      // @PLAIN_SERVER
  domain: DomainId;                    // @PLAIN_SERVER — separation is non-secret
  wrappedKey: Uint8Array;              // @WRAPPED — Wrap(ARK, K_domain)
  keyVersion: number;                  // @PLAIN_SERVER — enables future rotation
  createdAt: string;                   // @PLAIN_SERVER
}

export type DomainId = 'files' | 'gallery';

// ===========================================================================
// Media item (gallery domain)
// ===========================================================================

export interface MediaItemRecord {
  id: string;                          // @PLAIN_SERVER — opaque random ID
  ownerUserId: string;                 // @PLAIN_SERVER — access control
  contentHashB64: string;              // @PLAIN_SERVER — dedupe key (BLAKE3 of plaintext)
                                       //                @LEAKS_EXACT_DUPLICATES

  // Blob references
  originalBlobId: string;              // @PLAIN_SERVER — opaque pointer
  thumbnailBlobId: string;             // @PLAIN_SERVER
  enrichmentBlobId: string;            // @PLAIN_SERVER

  // Wrapped object keys
  wrappedFEKOriginal: Uint8Array;      // @WRAPPED — Wrap(K_gallery, FEK_original)
  wrappedFEKThumbnail: Uint8Array;     // @WRAPPED
  wrappedMEKEnrichment: Uint8Array;    // @WRAPPED

  // Unavoidable server-visible metadata
  originalSizeBytes: number;           // @PLAIN_SERVER @LEAKS_CONTENT_HINT
                                       //   Mitigation: pad to 256KB (OpenDecision 7)
  thumbnailSizeBytes: number;          // @PLAIN_SERVER
  createdAt: string;                   // @PLAIN_SERVER @LEAKS_ACTIVITY_PATTERN
  updatedAt: string;                   // @PLAIN_SERVER
  deletedAt: string | null;            // @PLAIN_SERVER — soft delete, observable by sync

  thumbnailWidth: number;              // @PLAIN_SERVER @LEAKS_ASPECT_RATIO
  thumbnailHeight: number;             // @PLAIN_SERVER @LEAKS_ASPECT_RATIO
}

/**
 * Plaintext of the enrichment blob. Server never sees this shape — only the
 * ciphertext under MEK_enrichment. Cross-device sync happens via the ciphertext
 * blob; clients decrypt and apply CRDT merges locally.
 */
export interface EnrichmentRecordPlaintext {
  schemaVersion: number;
  analysisVersion: number;

  mediaKind: MediaKind;                // @CIPHER_SERVER (inside blob)
  sourceType: SourceType;              // @CIPHER_SERVER
  sourcePathHint?: string;             // @CIPHER_SERVER
  capturedAt?: string;                 // @CIPHER_SERVER — original EXIF timestamp

  // CRDT-friendly tag separation. See OpenDecision 4 for the formal semantics.
  aiTags: TimestampedTag[];
  userTags: TimestampedTag[];
  removedAITags: TimestampedTag[];     // tombstones

  description?: string;
  ocrText?: string;
  transcript?: string;

  embeddingDim?: number;
  embedding?: Float32Array;            // @CIPHER_SERVER but see OpenDecision 3 re sync

  favorite: boolean;
  hidden: boolean;

  provider: ProviderInfo;
  corrections: UserCorrection[];
}

export interface TimestampedTag {
  tag: string;
  at: string;  // ISO-8601, for LWW-Element-Set merge
}

export type MediaKind =
  | 'photo' | 'video' | 'screenshot' | 'meme' | 'document' | 'unknown';

export type SourceType =
  | 'camera' | 'screenshots' | 'downloads'
  | 'messenger' | 'whatsapp' | 'telegram'
  | 'imported_manual' | 'unknown';

export interface ProviderInfo {
  mode: 'local' | 'hybrid' | 'external';
  providerName?: string;
  providerVersion?: string;
  modelName?: string;
  analyzedAt: string;
}

export interface UserCorrection {
  kind: 'tag_added' | 'tag_removed' | 'description_edited' | 'kind_changed';
  payload: unknown;
  at: string;
}

// ===========================================================================
// Albums
// ===========================================================================

export interface AlbumRecord {
  id: string;                          // @PLAIN_SERVER
  ownerUserId: string;                 // @PLAIN_SERVER

  encryptedBody: Uint8Array;           // @CIPHER_SERVER — name, cover, membership list
  wrappedAlbumKey: Uint8Array;         // @WRAPPED — Wrap(K_gallery, K_album)

  memberCount: number;                 // @PLAIN_SERVER @LEAKS_ALBUM_SIZE (accepted)
  createdAt: string;                   // @PLAIN_SERVER
  updatedAt: string;                   // @PLAIN_SERVER
}

export interface AlbumBodyPlaintext {
  name: string;
  description?: string;
  coverMediaItemId?: string;
  type: 'user' | 'smart';
  memberMediaItemIds: string[];        // for user albums
  smartRules?: SmartAlbumRules;        // for smart albums
}

export interface SmartAlbumRules {
  // v1: hardcoded presets only. Full rule DSL is post-v1 work.
  preset: 'videos' | 'screenshots' | 'memes' | 'favorites' | 'custom';
  customRulesJSON?: string;
}

// ===========================================================================
// Sharing
// ===========================================================================

/**
 * ShareRecord implements:
 *   - ADR-04: ShareRecord + GrantedAccess[] + per-share AK_share
 *   - ADR-05: album share = owner-maintained wrapped object key list
 *   - ADR-06: revocation removes server-side access material, not relying on URL secrecy
 *
 * Link format: https://discordrive.cikowice.pl/s/<shareId>#<linkSecret>
 *
 *   - <linkSecret> lives in the URL fragment. Fragments are not sent in HTTP
 *     requests, so it never reaches the server.
 *   - Server holds capabilityVerifier = H(linkSecret, serverSalt). When the
 *     client presents linkSecret-derived proof (HMAC challenge), server
 *     authorizes release of wrapped material without learning linkSecret.
 *   - Client derives a wrapping key from linkSecret and unwraps AK_share locally.
 *
 * Revocation: server flips status or deletes GrantedAccess rows. Ciphertext
 * blobs remain but the recipient can no longer obtain AK_share.
 */
export interface ShareRecord {
  shareId: string;                     // @PLAIN_SERVER — appears in URL path
  ownerUserId: string;                 // @PLAIN_SERVER

  capabilityVerifier: Uint8Array;      // @PLAIN_SERVER — zero-knowledge token verifier

  shareType: 'item' | 'album';         // @PLAIN_SERVER

  // Permissions — server enforces release based on these
  allowOriginal: boolean;              // @PLAIN_SERVER
  allowThumbnail: boolean;             // @PLAIN_SERVER
  allowMetadata: boolean;              // @PLAIN_SERVER — default false

  status: 'active' | 'revoked' | 'expired';  // @PLAIN_SERVER
  expiresAt?: string;                  // @PLAIN_SERVER
  maxViews?: number;                   // @PLAIN_SERVER
  viewCount: number;                   // @PLAIN_SERVER

  createdAt: string;
  revokedAt?: string;

  grantedAccess: GrantedAccess[];      // v1: always length 1. Model B: multi-recipient.
  wrappedObjectKeys: ShareWrappedObjectKey[];  // re-added on album membership change
}

export interface GrantedAccess {
  accessId: string;                    // @PLAIN_SERVER
  accessType: 'public_link';           // @PLAIN_SERVER — v1 only; 'user' / 'group' future
  wrappedAKShare: Uint8Array;          // @WRAPPED
                                       //   v1: Wrap(key-from-linkSecret, AK_share)
                                       //   future: Wrap(recipientPubkey, AK_share)
  createdAt: string;
  revokedAt?: string;
  expiresAt?: string;
}

export interface ShareWrappedObjectKey {
  mediaItemId: string;                 // @PLAIN_SERVER — recipient needs it to fetch the blob
  wrappedFEKOriginal?: Uint8Array;     // @WRAPPED — Wrap(AK_share, FEK_original)
  wrappedFEKThumbnail?: Uint8Array;
  wrappedMEKEnrichment?: Uint8Array;
}

// ===========================================================================
// OPEN DECISIONS — resolve in code, not in more documents
// ===========================================================================
/**
 *  1. mediaKind visibility — currently encrypted in enrichment blob.
 *     Resolve by: building v1 grid view. If "show only videos" feels slow at
 *     5k items on mobile, move mediaKind to @PLAIN_SERVER. Otherwise keep private.
 *
 *  2. thumbnailWidth/Height — currently @PLAIN_SERVER. Accepted leak.
 *     Resolve by: shipping. Revisit only if someone demonstrates a real exploit
 *     from aspect ratios.
 *
 *  3. Semantic embedding cross-device sync — currently OFF (recompute per device).
 *     Resolve by: measuring CPU cost on the first-import flow on a 2-year-old phone.
 *     If it's >30 seconds for 1000 items, turn on encrypted embedding sync.
 *
 *  4. CRDT discipline for EnrichmentRecord — LWW-Element-Set sketched above.
 *     Resolve by: writing the merge function and unit-testing it against concurrent
 *     mobile+desktop edits. Formalize in a merge.ts module.
 *
 *  5. Recipient key persistence for Model B (future) — DO NOT pre-decide.
 *     Resolve by: waiting until Model B has a real use case. Then pick A or B
 *     based on whether the use case is "my partner's family photos" (persistent)
 *     or "one-time collaborator" (session-scoped).
 *
 *  6. Perfect Forward Secrecy for shares — currently static AK_share.
 *     Resolve by: accepting static for v1. PFS is post-v1 work if ever.
 *
 *  7. Blob size padding — currently unpadded.
 *     Resolve by: implementing 256KB padding for originals, 16KB for thumbnails
 *     BEFORE first public beta. Cheap to add now, expensive to retrofit.
 *
 *  8. Owner cross-device share awareness — needs explicit sync.
 *     Resolve by: making active_shares[] part of the startup sync payload, and
 *     having album-mutation code path check "does any active share include this album?"
 *
 *  9. Android app deep link hijacking — assetlinks.json required.
 *     Resolve by: publishing /.well-known/assetlinks.json on discordrive.cikowice.pl
 *     BEFORE shipping any share link that can be opened by the mobile app.
 *
 * 10. Quantum readiness — deferred.
 *     Resolve by: ignoring until Model B. PQ key exchange belongs there, not here.
 *
 * -------------------------------------------------------------------
 * If you find yourself writing a 7-page document about any of these,
 * stop. Write the code, find out if the question matters, then decide.
 * -------------------------------------------------------------------
 */
