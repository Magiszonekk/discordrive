package com.discordrive.gallery

import android.content.Context
import com.discordrive.gallery.api.AiRateLimitException
import com.discordrive.gallery.api.AiVisionClient
import com.discordrive.gallery.api.DiscorDriveClient
import com.discordrive.gallery.api.EnrichmentEngine
import com.discordrive.gallery.api.FolderManager
import com.discordrive.gallery.api.UploadEngine
import com.discordrive.gallery.crypto.DdvCrypto

/**
 * One sync pass over the device library. Uses the local asset_map so repeat
 * runs skip already-synced assets without touching their bytes; new assets
 * fall back to the server-side dedupe token check before uploading.
 * Optionally runs AI enrichment for files that don't have it yet.
 */
class SyncRunner(
    private val context: Context,
    private val client: DiscorDriveClient,
    private val filesKey: ByteArray,
) {
    private val scanner = MediaScanner(context)
    private val db = AppDb(context)
    private val uploadEngine = UploadEngine(client)
    private val folderManager = FolderManager(client)
    private val enrichment = EnrichmentEngine(client)

    data class Progress(
        val phase: String,
        val done: Int,
        val total: Int,
        val detail: String,
        val uploaded: Int = 0,
        val deduplicated: Int = 0,
        val skipped: Int = 0,
        val analyzed: Int = 0,
        val failed: Int = 0,
    )

    fun sync(onProgress: (Progress) -> Unit): Progress {
        val assets = scanner.scanAll()
        val folderIds = mutableMapOf<String, String>()
        var uploaded = 0
        var deduplicated = 0
        var skipped = 0
        var failed = 0

        assets.forEachIndexed { index, asset ->
            onProgress(Progress("sync", index, assets.size, asset.displayName, uploaded, deduplicated, skipped, 0, failed))
            try {
                val mappedFileId = db.fileIdFor(asset)
                if (mappedFileId != null) {
                    // drift repair: file moved between buckets locally → mirror in cloud
                    if (db.mappedBucketFor(asset) != asset.bucketName) {
                        val folderId = folderIds.getOrPut(asset.bucketName) {
                            folderManager.ensureFolder(asset.bucketName, parentFolderId = null, filesKey = filesKey)
                        }
                        client.moveFile(mappedFileId, folderId)
                        db.rememberMapping(asset, mappedFileId)
                    }
                    skipped++
                    return@forEachIndexed
                }

                val content = scanner.readBytes(asset)
                val token = DdvCrypto.b64encode(DdvCrypto.deriveDedupeToken(filesKey, content))
                val existing = client.fileByDedupeToken(token)
                if (existing != null) {
                    db.rememberMapping(asset, existing.id)
                    deduplicated++
                    return@forEachIndexed
                }

                val folderId = folderIds.getOrPut(asset.bucketName) {
                    folderManager.ensureFolder(asset.bucketName, parentFolderId = null, filesKey = filesKey)
                }
                val outcome = uploadEngine.uploadFile(content, asset.displayName, asset.mimeType, folderId, filesKey)
                db.rememberMapping(asset, outcome.fileId)
                uploaded++
            } catch (e: Exception) {
                failed++
                android.util.Log.w("SyncRunner", "Sync failed for ${asset.displayName}", e)
            }
        }

        return Progress("sync", assets.size, assets.size, "done", uploaded, deduplicated, skipped, 0, failed)
    }

    /**
     * AI enrichment pass.
     * @param bucketFilter analyze only this album (null = whole library)
     * @param limit max NEW analyses this run (0 = unlimited) — for rate-limited
     *   gateways (e.g. OpenRouter free: 20/min, 2000/day)
     * Calls are spaced ~3.2s apart (≤19/min) and 429s wait + retry once.
     */
    fun aiScan(
        ai: AiVisionClient,
        model: String,
        bucketFilter: String? = null,
        limit: Int = 0,
        onProgress: (Progress) -> Unit,
    ): Progress {
        val assets = scanner.scanAll().filter { bucketFilter == null || it.bucketName == bucketFilter }
        val remoteFiles = client.galleryDelta(null).files
            .filter { it.status == "READY" && it.deletedAt == null }
            .associateBy { it.id }
        var analyzed = 0
        var skipped = 0
        var failed = 0
        var lastCallAtMs = 0L

        for ((index, asset) in assets.withIndex()) {
            if (limit > 0 && analyzed >= limit) break
            onProgress(Progress("ai", index, assets.size, asset.displayName, analyzed = analyzed, skipped = skipped, failed = failed))
            try {
                val fileId = db.fileIdFor(asset) ?: run { skipped++; null } ?: continue
                if (db.enrichmentFor(fileId) != null) { skipped++; continue }
                val file = remoteFiles[fileId] ?: run { skipped++; null } ?: continue

                // remote may already have it (other device) — cache locally
                val remote = enrichment.loadEnrichment(file, filesKey)
                if (remote != null) {
                    db.rememberEnrichment(fileId, remote)
                    skipped++
                    continue
                }

                // throttle to stay under 20 req/min gateways
                val sinceLast = System.currentTimeMillis() - lastCallAtMs
                if (sinceLast < AI_CALL_SPACING_MS) Thread.sleep(AI_CALL_SPACING_MS - sinceLast)

                val prepared = AiImagePreparer.prepare(context, asset)
                lastCallAtMs = System.currentTimeMillis()
                val vision = try {
                    ai.analyzeImage(prepared, "image/jpeg")
                } catch (rateLimit: AiRateLimitException) {
                    Thread.sleep(rateLimit.retryAfterSeconds.coerceAtMost(120) * 1000)
                    lastCallAtMs = System.currentTimeMillis()
                    ai.analyzeImage(prepared, "image/jpeg")
                }
                val record = enrichment.buildRecord(vision, model)
                enrichment.saveEnrichment(fileId, file.wrappedFEK, filesKey, record)
                db.rememberEnrichment(fileId, record)
                analyzed++
            } catch (e: Exception) {
                failed++
                android.util.Log.w("SyncRunner", "AI failed for ${asset.displayName}", e)
            }
        }

        return Progress("ai", assets.size, assets.size, "done", analyzed = analyzed, skipped = skipped, failed = failed)
    }

    private companion object {
        const val AI_CALL_SPACING_MS = 3200L
    }
}
