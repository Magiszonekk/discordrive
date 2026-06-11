package com.discordrive.gallery.api

import com.discordrive.gallery.crypto.AesGcm
import com.discordrive.gallery.crypto.DdvCrypto
import com.discordrive.gallery.crypto.Hkdf
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Instant
import java.util.UUID

/**
 * Per-file AI enrichment (tags + description), stored zero-knowledge:
 * the record is encrypted under HKDF(rootFEK, "ddv4-file-enrichment-v1") and
 * uploaded as blob `{fileId}:enrichment` through the normal blob transport.
 * The server never learns what is on any photo; search happens client-side.
 */
@Serializable
data class EnrichmentRecord(
    val schemaVersion: Int = 1,
    val tags: List<String>,
    val description: String,
    val ocrText: String? = null,
    val model: String,
    val analyzedAt: String,
)

class EnrichmentEngine(private val client: DiscorDriveClient) {

    companion object {
        const val INFO_ENRICHMENT = "ddv4-file-enrichment-v1"
        fun enrichmentBlobId(fileId: String) = "$fileId:enrichment"
    }

    private val json = Json { ignoreUnknownKeys = true }

    fun hasEnrichment(fileId: String): Boolean = client.blobs.exists(enrichmentBlobId(fileId))

    fun saveEnrichment(fileId: String, wrappedFEK: String, filesKey: ByteArray, record: EnrichmentRecord) {
        val rootFek = DdvCrypto.unwrapRootFek(wrappedFEK, filesKey)
        val key = Hkdf.deriveBits(rootFek, INFO_ENRICHMENT)
        val ciphertext = AesGcm.encryptPacked(key, json.encodeToString(EnrichmentRecord.serializer(), record).toByteArray(Charsets.UTF_8))
        client.blobs.upload(enrichmentBlobId(fileId), ciphertext, uploadId = UUID.randomUUID().toString(), chunkIndex = 0, chunkCount = 1)
    }

    fun loadEnrichment(file: FileDto, filesKey: ByteArray): EnrichmentRecord? {
        val ciphertext = client.blobs.downloadOrNull(enrichmentBlobId(file.id)) ?: return null
        return runCatching {
            val rootFek = DdvCrypto.unwrapRootFek(file.wrappedFEK, filesKey)
            val key = Hkdf.deriveBits(rootFek, INFO_ENRICHMENT)
            json.decodeFromString(EnrichmentRecord.serializer(), AesGcm.decryptPacked(key, ciphertext).toString(Charsets.UTF_8))
        }.getOrNull()
    }

    fun buildRecord(vision: AiVisionClient.VisionResult, model: String): EnrichmentRecord =
        EnrichmentRecord(
            tags = vision.tags,
            description = vision.description,
            model = model,
            analyzedAt = Instant.now().toString(),
        )

    /** Case-insensitive match against tags + description. */
    fun matches(record: EnrichmentRecord, query: String): Boolean {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return false
        return record.description.lowercase().contains(q) || record.tags.any { it.contains(q) }
    }
}
