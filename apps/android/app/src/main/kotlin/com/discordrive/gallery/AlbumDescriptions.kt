package com.discordrive.gallery

import com.discordrive.gallery.api.DiscorDriveClient
import com.discordrive.gallery.crypto.DdvCrypto

/**
 * Per-album (bucket) free-text descriptions, used as extra context for AI
 * tagging — e.g. "pins" → "zapisane z Pinteresta, najczęściej memy".
 *
 * Stored E2EE in gallery state (same mechanism as the diagnostic logs):
 * key `albumdesc:<bucket>`, value = encryptMeta(filesKey, text). The server
 * only ever sees ciphertext; descriptions sync across the user's devices.
 */
object AlbumDescriptions {

    private fun stateKey(bucket: String) = "albumdesc:$bucket"

    /** Returns the decrypted description, or null if unset/blank/undecryptable. */
    fun load(client: DiscorDriveClient, filesKey: ByteArray, bucket: String): String? =
        runCatching {
            client.getGalleryState(stateKey(bucket))?.valueB64
                ?.let { DdvCrypto.decryptMeta(filesKey, it) }
                ?.takeIf { it.isNotBlank() }
        }.getOrNull()

    /** Saves (or clears, when blank) the description for a bucket. */
    fun save(client: DiscorDriveClient, filesKey: ByteArray, bucket: String, text: String) {
        val trimmed = text.trim()
        // Empty string clears the hint; load() treats blank as "no context".
        client.setGalleryState(stateKey(bucket), DdvCrypto.encryptMeta(filesKey, trimmed))
    }
}
