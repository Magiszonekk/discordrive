package com.discordrive.gallery

import com.discordrive.gallery.api.DiscorDriveClient
import com.discordrive.gallery.api.EnrichmentRecord
import com.discordrive.gallery.crypto.DdvCrypto
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.security.MessageDigest

/**
 * E2EE backup of the AI-enrichment cache as SHARDED gallery-state entries
 * (`enrichment-index:0..31`, each encryptMeta(filesKey) of {fileId → record}).
 * Per-file enrichment blobs already exist on the server, but rebuilding a new
 * device's local cache from them = one blob download per file (slow + 429);
 * the index restores it in a handful of fetches instead.
 *
 * Why shards: the server caps one gallery-state value at 4 MiB, and the
 * project's core promise is NO storage limits — with full video transcripts
 * in the records a single index would eventually hit that cap. A record
 * lives in shard sha256(fileId)[0] mod 32 (language-agnostic, so non-Kotlin
 * clients agree), which also makes writes cheap: an edit rewrites one shard,
 * not the whole index. SHARD_COUNT is fixed — changing it reshuffles every
 * record and would force a full rewrite, so it is deliberately generous.
 *
 * Migration: the legacy single `enrichment-index` key is still read (merged
 * lowest-priority) and is deleted after the first fully-successful sharded
 * sweep, so pre-0.19 backups are absorbed, not lost.
 */
object EnrichmentIndex {

    private const val LEGACY_KEY = "enrichment-index"
    private const val SHARD_PREFIX = "enrichment-index:"
    private const val SHARD_COUNT = 32
    private const val MAX_PLAINTEXT = 3_500_000 // per shard, under the 4 MiB state cap
    private val json = Json { ignoreUnknownKeys = true }
    private val serializer = MapSerializer(String.serializer(), EnrichmentRecord.serializer())

    private fun shardOf(fileId: String): Int =
        (MessageDigest.getInstance("SHA-256").digest(fileId.toByteArray(Charsets.UTF_8))[0].toInt() and 0xFF) % SHARD_COUNT

    private fun shardKey(shard: Int) = "$SHARD_PREFIX$shard"

    /** Existing index keys on the server (shards + possibly the legacy key). */
    private fun existingKeys(client: DiscorDriveClient): List<String> =
        client.galleryStateKeys(LEGACY_KEY).filter { it == LEGACY_KEY || it.startsWith(SHARD_PREFIX) }

    private fun fetch(client: DiscorDriveClient, filesKey: ByteArray, key: String): Map<String, EnrichmentRecord>? {
        val plain = runCatching {
            client.getGalleryState(key)?.valueB64?.let { DdvCrypto.decryptMeta(filesKey, it) }
        }.getOrNull() ?: return null
        return runCatching { json.decodeFromString(serializer, plain) }.getOrNull()
    }

    private fun store(client: DiscorDriveClient, filesKey: ByteArray, key: String, map: Map<String, EnrichmentRecord>): Boolean {
        val plain = json.encodeToString(serializer, map)
        if (plain.length > MAX_PLAINTEXT) {
            AppLog.w("EnrichmentIndex", "$key too large (${plain.length} B) — skipping")
            return false
        }
        return runCatching { client.setGalleryState(key, DdvCrypto.encryptMeta(filesKey, plain)) }
            .onFailure { AppLog.w("EnrichmentIndex", "store $key failed", it) }
            .isSuccess
    }

    /** Merges every cloud shard (+ legacy index) into the local cache. Returns #added. */
    fun pull(client: DiscorDriveClient, filesKey: ByteArray, db: AppDb): Int {
        val keys = runCatching { existingKeys(client) }.getOrNull() ?: return 0
        // legacy first so sharded (newer) entries win on duplicates
        val merged = HashMap<String, EnrichmentRecord>()
        for (key in keys.sortedBy { if (it == LEGACY_KEY) 0 else 1 }) {
            fetch(client, filesKey, key)?.let { merged.putAll(it) }
        }
        var added = 0
        for ((fileId, record) in merged) {
            if (db.enrichmentFor(fileId) == null) {
                db.rememberEnrichment(fileId, record)
                added++
            }
        }
        if (added > 0) AppLog.i("EnrichmentIndex", "restored $added enrichments from cloud index (${keys.size} parts)")
        return added
    }

    /**
     * Uploads the local cache MERGED over the cloud shards (local wins per
     * file); only shards whose content actually changed are rewritten. The
     * merge keeps the push additive — an incomplete local cache must not
     * erase other files' analyses. Entries removed on purpose go through
     * [remove]/[removeAll], not through push.
     */
    fun push(client: DiscorDriveClient, filesKey: ByteArray, db: AppDb) {
        runCatching {
            val local = db.allEnrichments()
            if (local.isEmpty()) return
            val hadLegacy = runCatching { existingKeys(client).contains(LEGACY_KEY) }.getOrDefault(false)
            // legacy entries participate in the merge so migration can't drop them;
            // if the legacy read fails (network/decrypt) we must NOT delete it below
            val legacyRead = if (hadLegacy) fetch(client, filesKey, LEGACY_KEY) else null
            val legacy = legacyRead ?: emptyMap()

            var allOk = true
            for (shard in 0 until SHARD_COUNT) {
                val forShard = HashMap<String, EnrichmentRecord>()
                legacy.forEach { (id, r) -> if (shardOf(id) == shard) forShard[id] = r }
                local.forEach { (id, r) -> if (shardOf(id) == shard) forShard[id] = r }
                if (forShard.isEmpty()) continue
                val cloud = fetch(client, filesKey, shardKey(shard)) ?: emptyMap()
                val merged = HashMap(cloud).apply { putAll(forShard) }
                if (merged == cloud) continue
                if (!store(client, filesKey, shardKey(shard), merged)) allOk = false
            }
            // migration: drop the legacy single index once everything lives in shards
            if (hadLegacy && legacyRead != null && allOk) {
                runCatching { client.deleteGalleryState(LEGACY_KEY) }
                    .onSuccess { AppLog.i("EnrichmentIndex", "migrated legacy index to $SHARD_COUNT shards") }
            }
        }.onFailure { AppLog.w("EnrichmentIndex", "push failed", it) }
    }

    /** Deletes the given files' entries from the cloud index (after a purge / manual delete). */
    fun remove(client: DiscorDriveClient, filesKey: ByteArray, fileIds: Collection<String>) {
        runCatching {
            val ids = fileIds.toSet()
            if (ids.isEmpty()) return
            val existing = existingKeys(client).toSet()
            for ((shard, shardIds) in ids.groupBy(::shardOf)) {
                val key = shardKey(shard)
                if (key !in existing) continue
                val cloud = fetch(client, filesKey, key) ?: continue
                val remaining = cloud - shardIds.toSet()
                if (remaining.size == cloud.size) continue
                if (remaining.isEmpty()) client.deleteGalleryState(key) else store(client, filesKey, key, remaining)
            }
            if (LEGACY_KEY in existing) {
                val cloud = fetch(client, filesKey, LEGACY_KEY)
                if (cloud != null) {
                    val remaining = cloud - ids
                    if (remaining.size != cloud.size) {
                        if (remaining.isEmpty()) client.deleteGalleryState(LEGACY_KEY) else store(client, filesKey, LEGACY_KEY, remaining)
                    }
                }
            }
        }.onFailure { AppLog.w("EnrichmentIndex", "remove failed", it) }
    }

    /** Empties the whole cloud index ("wyczyść wszystkie analizy" / wipe cloud). */
    fun removeAll(client: DiscorDriveClient, filesKey: ByteArray) {
        runCatching {
            for (key in existingKeys(client)) {
                runCatching { client.deleteGalleryState(key) }
                    .onFailure { AppLog.w("EnrichmentIndex", "delete $key failed", it) }
            }
        }.onFailure { AppLog.w("EnrichmentIndex", "removeAll failed", it) }
    }
}
