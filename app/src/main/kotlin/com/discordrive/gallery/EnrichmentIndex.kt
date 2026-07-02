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

    /**
     * Uploads the local cache MERGED over the cloud index (local wins per file).
     * The merge is what makes the push additive: a device whose local cache is
     * incomplete (fresh install, cache partially dropped) must not erase other
     * files' analyses from the shared index. Entries removed on purpose go
     * through [remove]/[removeAll], not through push.
     */
    fun push(client: DiscorDriveClient, filesKey: ByteArray, db: AppDb) {
        runCatching {
            val merged = HashMap(fetchCloudIndex(client, filesKey) ?: emptyMap())
            merged.putAll(db.allEnrichments())
            val plain = json.encodeToString(serializer, merged)
            if (plain.length > MAX_PLAINTEXT) {
                AppLog.w("EnrichmentIndex", "index too large (${plain.length} B) — skipping push")
                return@runCatching
            }
            client.setGalleryState(STATE_KEY, DdvCrypto.encryptMeta(filesKey, plain))
        }.onFailure { AppLog.w("EnrichmentIndex", "push failed", it) }
    }

    /** Deletes the given files' entries from the cloud index (after a purge / manual delete). */
    fun remove(client: DiscorDriveClient, filesKey: ByteArray, fileIds: Collection<String>) {
        runCatching {
            val index = fetchCloudIndex(client, filesKey) ?: return
            val remaining = index.filterKeys { it !in fileIds.toSet() }
            if (remaining.size == index.size) return
            client.setGalleryState(STATE_KEY, DdvCrypto.encryptMeta(filesKey, json.encodeToString(serializer, remaining)))
        }.onFailure { AppLog.w("EnrichmentIndex", "remove failed", it) }
    }

    /** Empties the cloud index ("wyczyść wszystkie analizy" / wipe cloud). */
    fun removeAll(client: DiscorDriveClient, filesKey: ByteArray) {
        runCatching {
            client.setGalleryState(STATE_KEY, DdvCrypto.encryptMeta(filesKey, json.encodeToString(serializer, emptyMap())))
        }.onFailure { AppLog.w("EnrichmentIndex", "removeAll failed", it) }
    }

    private fun fetchCloudIndex(client: DiscorDriveClient, filesKey: ByteArray): Map<String, EnrichmentRecord>? {
        val plain = runCatching {
            client.getGalleryState(STATE_KEY)?.valueB64?.let { DdvCrypto.decryptMeta(filesKey, it) }
        }.getOrNull() ?: return null
        return runCatching { json.decodeFromString(serializer, plain) }.getOrNull()
    }

    /** Merges the cloud index into the local cache (fills gaps). Returns #added. */
    fun pull(client: DiscorDriveClient, filesKey: ByteArray, db: AppDb): Int {
        val map = fetchCloudIndex(client, filesKey) ?: return 0
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
