package com.discordrive.gallery

import com.discordrive.gallery.api.DiscorDriveClient
import com.discordrive.gallery.api.EnrichmentRecord
import com.discordrive.gallery.crypto.DdvCrypto
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * E2EE backup of the whole AI-enrichment cache as ONE gallery-state entry
 * (`enrichment-index`, encryptMeta(filesKey) of {fileId → record}). Per-file
 * enrichment blobs already exist on the server, but rebuilding a new device's
 * local cache from them = one blob download per file (slow + 429). This index
 * lets a new device repopulate its cache (search + tags) in a single fetch,
 * so synced photos don't need re-analyzing. Pushed when analyses change;
 * pulled (merged) on full sync.
 */
object EnrichmentIndex {

    private const val STATE_KEY = "enrichment-index"
    private const val MAX_PLAINTEXT = 3_500_000 // stay under the 4 MiB gallery-state cap
    private val json = Json { ignoreUnknownKeys = true }
    private val serializer = MapSerializer(String.serializer(), EnrichmentRecord.serializer())

    /** Uploads the current local cache as the encrypted index (last-write-wins). */
    fun push(client: DiscorDriveClient, filesKey: ByteArray, db: AppDb) {
        runCatching {
            val plain = json.encodeToString(serializer, db.allEnrichments())
            if (plain.length > MAX_PLAINTEXT) {
                AppLog.w("EnrichmentIndex", "index too large (${plain.length} B) — skipping push")
                return@runCatching
            }
            client.setGalleryState(STATE_KEY, DdvCrypto.encryptMeta(filesKey, plain))
        }.onFailure { AppLog.w("EnrichmentIndex", "push failed", it) }
    }

    /** Merges the cloud index into the local cache (fills gaps). Returns #added. */
    fun pull(client: DiscorDriveClient, filesKey: ByteArray, db: AppDb): Int {
        val plain = runCatching {
            client.getGalleryState(STATE_KEY)?.valueB64?.let { DdvCrypto.decryptMeta(filesKey, it) }
        }.getOrNull() ?: return 0
        val map = runCatching { json.decodeFromString(serializer, plain) }.getOrNull() ?: return 0
        var added = 0
        for ((fileId, record) in map) {
            if (db.enrichmentFor(fileId) == null) {
                db.rememberEnrichment(fileId, record)
                added++
            }
        }
        if (added > 0) AppLog.i("EnrichmentIndex", "restored $added enrichments from cloud index")
        return added
    }
}
