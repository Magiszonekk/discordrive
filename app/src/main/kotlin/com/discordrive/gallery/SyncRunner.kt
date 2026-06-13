package com.discordrive.gallery

import android.content.Context
import com.discordrive.gallery.api.AiRateLimitException
import com.discordrive.gallery.api.AiVisionClient
import com.discordrive.gallery.api.DiscorDriveClient
import com.discordrive.gallery.api.EnrichmentEngine
import com.discordrive.gallery.api.EnrichmentRecord
import com.discordrive.gallery.api.FolderManager
import com.discordrive.gallery.api.UploadEngine

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
        val bytesDone: Long = 0,
    )

    fun sync(onProgress: (Progress) -> Unit): Progress = syncAssets(scanner.scanAll(), onProgress)

    /** Syncs only the given assets (a single photo or a multi-selection). */
    fun syncAssets(assets: List<MediaAsset>, onProgress: (Progress) -> Unit): Progress {
        AppLog.i("SyncRunner", "sync start: ${assets.size} assets (subset)")
        val folderIds = mutableMapOf<String, String>()
        var uploaded = 0
        var deduplicated = 0
        var skipped = 0
        var failed = 0
        var bytesDone = 0L

        // Detect stale local mappings — files the local DB marks as synced but
        // that no longer exist in the cloud (purged, or deleted on another
        // device). Validate once against the server so they are RE-UPLOADED
        // instead of silently skipped. On fetch failure (offline) we trust the
        // local map to avoid a spurious mass re-upload.
        val remoteIds: Set<String>? = if (assets.any { db.fileIdFor(it) != null }) {
            runCatching {
                client.galleryDeltaAll(null).files
                    .filter { it.status == "READY" && it.deletedAt == null }
                    .map { it.id }.toSet()
            }.getOrNull()
        } else {
            null
        }

        assets.forEachIndexed { index, asset ->
            SyncController.awaitIfPaused() // honour notification Pause/Resume
            onProgress(Progress("sync", index, assets.size, asset.displayName, uploaded, deduplicated, skipped, 0, failed, bytesDone))
            try {
                val mappedFileId = db.fileIdFor(asset)
                val stillInCloud = mappedFileId != null && (remoteIds == null || mappedFileId in remoteIds)
                if (stillInCloud) {
                    // drift repair: file moved between buckets locally → mirror in cloud
                    if (db.mappedBucketFor(asset) != asset.bucketName) {
                        val folderId = folderIds.getOrPut(asset.bucketName) {
                            folderManager.ensureFolder(asset.bucketName, parentFolderId = null, filesKey = filesKey)
                        }
                        client.moveFile(mappedFileId!!, folderId)
                        db.rememberMapping(asset, mappedFileId)
                    }
                    skipped++
                    return@forEachIndexed
                }
                if (mappedFileId != null) {
                    // stale mapping (cloud file gone) → drop it and re-upload below
                    AppLog.w("SyncRunner", "stale mapping: ${asset.displayName} (cloud file $mappedFileId gone) — re-uploading")
                    db.forgetFile(mappedFileId)
                }

                val folderId = folderIds.getOrPut(asset.bucketName) {
                    folderManager.ensureFolder(asset.bucketName, parentFolderId = null, filesKey = filesKey)
                }
                // streaming: dedupe hash + chunked upload without loading the file into memory
                val outcome = uploadEngine.uploadStream(
                    open = { scanner.openStream(asset) },
                    fileName = asset.displayName,
                    mimeType = asset.mimeType,
                    parentFolderId = folderId,
                    filesKey = filesKey,
                )
                db.rememberMapping(asset, outcome.fileId)
                if (outcome.deduplicated) {
                    deduplicated++
                } else {
                    uploaded++
                    bytesDone += asset.sizeBytes
                }
            } catch (e: Throwable) {
                // Throwable, not Exception: an OutOfMemoryError on one corrupt/huge
                // file must not kill the whole pass (the pre-0.5.0 crash loop)
                failed++
                AppLog.w("SyncRunner", "sync failed for ${asset.displayName} (${asset.sizeBytes} B, ${asset.mimeType})", e)
            }
        }

        AppLog.i("SyncRunner", "sync done: ↑$uploaded, $deduplicated dedup, $skipped skipped, $failed failed")
        return Progress("sync", assets.size, assets.size, "done", uploaded, deduplicated, skipped, 0, failed, bytesDone)
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
        val remoteFiles = client.galleryDeltaAll(null).files
            .filter { it.status == "READY" && it.deletedAt == null }
            .associateBy { it.id }
        // per-album context hints for the AI prompt (fetched once per bucket)
        val albumHints = assets.map { it.bucketName }.toSet()
            .associateWith { AlbumDescriptions.load(client, filesKey, it) }
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

                val hint = albumHints[asset.bucketName]
                lastCallAtMs = System.currentTimeMillis()
                val vision = try {
                    runVision(ai, asset, hint)
                } catch (rateLimit: AiRateLimitException) {
                    Thread.sleep(rateLimit.retryAfterSeconds.coerceAtMost(120) * 1000)
                    lastCallAtMs = System.currentTimeMillis()
                    runVision(ai, asset, hint)
                }
                val record = enrichment.buildRecord(vision, model)
                enrichment.saveEnrichment(fileId, file.wrappedFEK, filesKey, record)
                db.rememberEnrichment(fileId, record)
                analyzed++
            } catch (e: Exception) {
                failed++
                AppLog.w("SyncRunner", "AI failed for ${asset.displayName}", e)
            }
        }

        AppLog.i("SyncRunner", "ai done: $analyzed analyzed, $skipped skipped, $failed failed")
        return Progress("ai", assets.size, assets.size, "done", analyzed = analyzed, skipped = skipped, failed = failed)
    }

    /**
     * On-demand AI analysis of one already-synced asset (re)analyzes
     * unconditionally and stores the result. Throws on failure so the caller
     * can surface a message. Uses the album description as context.
     */
    fun analyzeOne(ai: AiVisionClient, model: String, asset: MediaAsset): EnrichmentRecord {
        val fileId = db.fileIdFor(asset)
            ?: throw IllegalStateException("Zdjęcie nie jest jeszcze zsynchronizowane")
        val file = client.file(fileId) ?: run {
            // stale mapping — clear it so the badge corrects and a re-sync re-uploads
            db.forgetFile(fileId)
            throw IllegalStateException("Plik zniknął z chmury — uruchom synchronizację ponownie")
        }
        val hint = AlbumDescriptions.load(client, filesKey, asset.bucketName)
        val vision = try {
            runVision(ai, asset, hint)
        } catch (rateLimit: AiRateLimitException) {
            Thread.sleep(rateLimit.retryAfterSeconds.coerceAtMost(120) * 1000)
            runVision(ai, asset, hint)
        }
        val record = enrichment.buildRecord(vision, model)
        enrichment.saveEnrichment(fileId, file.wrappedFEK, filesKey, record)
        db.rememberEnrichment(fileId, record)
        return record
    }

    /**
     * Images → single downscaled frame; videos → several frames sampled across
     * the duration, analyzed frame-by-frame (batched, requests spaced by the
     * same throttle as image calls).
     */
    private fun runVision(ai: AiVisionClient, asset: MediaAsset, hint: String?): AiVisionClient.VisionResult =
        if (asset.isVideo) {
            ai.analyzeVideo(AiImagePreparer.prepareVideoFrames(context, asset), hint, interBatchDelayMs = AI_CALL_SPACING_MS)
        } else {
            ai.analyzeImage(AiImagePreparer.prepare(context, asset), "image/jpeg", hint)
        }

    private companion object {
        const val AI_CALL_SPACING_MS = 3200L
    }
}
