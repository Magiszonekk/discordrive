package com.discordrive.gallery.crypto

import java.util.Base64

/**
 * DiscorDrive key hierarchy — Kotlin mirror of @ddv4/processing/src/crypto.ts
 * and apps/frontend/src/lib/crypto.ts. Every operation here is covered by the
 * shared test vectors (crypto-vectors.json) and MUST stay byte-compatible.
 *
 * Hierarchy:
 *   password + Argon2id ─→ arkWrapKey ──unwraps──→ ARK
 *                       └─ HKDF("ddv4-server-auth-v1") → serverAuthProof
 *   ARK (== filesKey in the current core) ──unwraps──→ per-file rootFEK
 *   rootFEK ─ HKDF("ddv4-file-content-v1")  → chunk/manifest key
 *           └ HKDF("ddv4-file-metadata-v1") → metadata key
 */
object DdvCrypto {
    const val INFO_SERVER_AUTH = "ddv4-server-auth-v1"
    const val INFO_FILE_CONTENT = "ddv4-file-content-v1"
    const val INFO_FILE_METADATA = "ddv4-file-metadata-v1"
    const val INFO_SHARE_WRAP = "ddv4-files-share-wrap-v1"
    const val INFO_SHARE_AUTH = "ddv4-files-share-auth-v1"
    const val SHARE_TOKEN_MESSAGE = "ddv4-files-share-token-v1"

    data class LoginMaterial(val arkWrapKey: ByteArray, val serverAuthProof: ByteArray)

    /** Single Argon2 run deriving both the ARK-wrapping key and the server auth proof. */
    fun deriveLoginMaterial(password: String, params: Argon2Params): LoginMaterial {
        val salt = b64decode(params.saltB64)
        val hash = Argon2.hash(password, salt, params)
        return LoginMaterial(
            arkWrapKey = hash,
            serverAuthProof = Hkdf.deriveBits(hash, INFO_SERVER_AUTH),
        )
    }

    // === Wrapping (packWrappedKey format: IV || AES-GCM(rawKeyBytes)) ===

    fun wrapKeyPacked(rawKeyToWrap: ByteArray, wrappingKey: ByteArray, iv: ByteArray = AesGcm.randomIv()): ByteArray =
        AesGcm.encryptPacked(wrappingKey, rawKeyToWrap, iv)

    fun unwrapKeyPacked(packed: ByteArray, wrappingKey: ByteArray): ByteArray =
        AesGcm.decryptPacked(wrappingKey, packed)

    fun unwrapArkWithPassword(wrappedArkPackedB64: String, arkWrapKey: ByteArray): ByteArray =
        unwrapKeyPacked(b64decode(wrappedArkPackedB64), arkWrapKey)

    fun unwrapRootFek(wrappedFekPackedB64: String, filesKey: ByteArray): ByteArray =
        unwrapKeyPacked(b64decode(wrappedFekPackedB64), filesKey)

    // === Per-file subkeys ===

    fun deriveFileContentKey(rootFek: ByteArray): ByteArray = Hkdf.deriveBits(rootFek, INFO_FILE_CONTENT)

    fun deriveFileMetadataKey(rootFek: ByteArray): ByteArray = Hkdf.deriveBits(rootFek, INFO_FILE_METADATA)

    // === Chunks (packed IV || ciphertext || tag) ===

    fun encryptChunk(plaintext: ByteArray, rootFek: ByteArray): ByteArray =
        AesGcm.encryptPacked(deriveFileContentKey(rootFek), plaintext)

    fun decryptChunk(packed: ByteArray, rootFek: ByteArray): ByteArray =
        AesGcm.decryptPacked(deriveFileContentKey(rootFek), packed)

    // === Encrypted JSON payloads (metadata / manifest) ===
    // Callers pass exact JSON strings — serialization differences between
    // platforms don't matter because only the producing side serializes.

    fun encryptFileMetadata(json: String, rootFek: ByteArray, iv: ByteArray = AesGcm.randomIv()): ByteArray =
        AesGcm.encryptPacked(deriveFileMetadataKey(rootFek), json.toByteArray(Charsets.UTF_8), iv)

    fun decryptFileMetadata(packed: ByteArray, rootFek: ByteArray): String =
        AesGcm.decryptPacked(deriveFileMetadataKey(rootFek), packed).toString(Charsets.UTF_8)

    fun encryptFileManifest(json: String, rootFek: ByteArray, iv: ByteArray = AesGcm.randomIv()): ByteArray =
        AesGcm.encryptPacked(deriveFileContentKey(rootFek), json.toByteArray(Charsets.UTF_8), iv)

    fun decryptFileManifest(packed: ByteArray, rootFek: ByteArray): String =
        AesGcm.decryptPacked(deriveFileContentKey(rootFek), packed).toString(Charsets.UTF_8)

    // === Small metadata strings (encryptMeta in the web client) ===
    // Encrypted DIRECTLY with the given key (rootFek for file name/mime,
    // folderKey for folder bodies) — not with an HKDF subkey.

    fun encryptMeta(key: ByteArray, plaintext: String, iv: ByteArray = AesGcm.randomIv()): String =
        b64encode(AesGcm.encryptPacked(key, plaintext.toByteArray(Charsets.UTF_8), iv))

    fun decryptMeta(key: ByteArray, packedB64: String): String =
        AesGcm.decryptPacked(key, b64decode(packedB64)).toString(Charsets.UTF_8)

    // === Dedupe token (mobile-only; server matches equality blindly) ===
    // HMAC(HKDF(filesKey, "ddv4-dedupe-v1"), SHA-256(content)) — equality is
    // checkable per user, content hash never leaves the device.

    const val INFO_DEDUPE = "ddv4-dedupe-v1"

    fun deriveDedupeToken(filesKey: ByteArray, content: ByteArray): ByteArray =
        deriveDedupeTokenFromDigest(filesKey, java.security.MessageDigest.getInstance("SHA-256").digest(content))

    /** Streaming variant: callers hash large content incrementally and pass the SHA-256 digest. */
    fun deriveDedupeTokenFromDigest(filesKey: ByteArray, contentSha256: ByteArray): ByteArray =
        Hkdf.hmacSha256(Hkdf.deriveBits(filesKey, INFO_DEDUPE), contentSha256)

    // === Shares ===

    fun deriveShareWrapKey(linkSecret: ByteArray): ByteArray = Hkdf.deriveBits(linkSecret, INFO_SHARE_WRAP)

    fun deriveShareAuthKey(linkSecret: ByteArray): ByteArray = Hkdf.deriveBits(linkSecret, INFO_SHARE_AUTH)

    fun deriveShareCapabilityToken(linkSecret: ByteArray): ByteArray =
        Hkdf.hmacSha256(deriveShareAuthKey(linkSecret), SHARE_TOKEN_MESSAGE.toByteArray(Charsets.UTF_8))

    // === Base64 helpers (standard alphabet, padded — same as btoa/Buffer) ===

    fun b64encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun b64decode(value: String): ByteArray = Base64.getDecoder().decode(value)
}
