package com.discordrive.gallery

import android.content.Context
import com.discordrive.gallery.api.AiRateLimitException
import com.discordrive.gallery.api.AiVisionClient
import com.discordrive.gallery.api.DiscorDriveClient
import com.discordrive.gallery.api.EnrichmentEngine
import com.discordrive.gallery.api.EnrichmentRecord
import com.discordrive.gallery.api.FolderManager
import com.discordrive.gallery.api.UploadEngine
import com.discordrive.gallery.crypto.DdvCrypto
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

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
        val downloaded: Int = 0,
        val bytesDone: Long = 0,
    )

    fun sync(onProgress: (Progress) -> Unit): Progress {
        // Repopulate the local AI-enrichment cache from the E2EE cloud index, so a
        // new device gets all analyses without re-analyzing (and search works).
        runCatching { EnrichmentIndex.pull(client, filesKey, db) }
        return syncAssets(scanner.scanAll(), onProgress)
    }

    /**
     * Syncs the given assets, uploading [UPLOAD_CONCURRENCY] files in parallel.
     * Many small files are latency-bound (each file = a few sequential round
     * trips + Discord blob writes), so overlapping files is the real speed-up —
     * the server is built for concurrent uploads (multiple senders + limiter).
     * Counters are atomic; the per-bucket folder cache serializes folder
     * creation via computeIfAbsent. Pause + unreachable-abort still apply.
     */
    fun syncAssets(assets: List<MediaAsset>, onProgress: (Progress) -> Unit): Progress {
        AppLog.i("SyncRunner", "sync start: ${assets.size} assets, concurrency=$UPLOAD_CONCURRENCY")

        // Detect stale local mappings — files the local DB marks as synced but
        // that no longer exist in the cloud (purged / deleted elsewhere). Validate
        // once so they are RE-UPLOADED, not skipped. On fetch failure (offline) we
        // trust the local map to avoid a spurious mass re-upload.
        // Map (not just id set) so we can also see which already-synced files are
        // still missing a cloud preview and backfill it from the local original.
        val remoteFiles: Map<String, com.discordrive.gallery.api.FileDto>? =
            if (assets.any { db.fileIdFor(it) != null }) {
                runCatching {
                    client.galleryDeltaAll(null).files
                        .filter { it.status == "READY" && it.deletedAt == null }
                        .associateBy { it.id }
                }.getOrNull()
            } else {
                null
            }

        val total = assets.size
        val uploaded = AtomicInteger(0)
        val deduplicated = AtomicInteger(0)
        val skipped = AtomicInteger(0)
        val failed = AtomicInteger(0)
        val bytesDone = AtomicLong(0)
        val done = AtomicInteger(0)
        val consecutiveNetFails = AtomicInteger(0)
        val aborted = AtomicBoolean(false)
        val folderIds = ConcurrentHashMap<String, String>()

        fun report(detail: String) = onProgress(
            Progress("sync", done.get(), total, detail, uploaded.get(), deduplicated.get(), skipped.get(), 0, failed.get(), bytesDone = bytesDone.get()),
        )
        fun folderFor(bucket: String): String =
            folderIds.computeIfAbsent(bucket) { folderManager.ensureFolder(it, parentFolderId = null, filesKey = filesKey) }

        val pool = Executors.newFixedThreadPool(UPLOAD_CONCURRENCY)
        try {
            val tasks = assets.map { asset ->
                Callable {
                    if (aborted.get() || SyncController.cancelled) { done.incrementAndGet(); return@Callable }
                    SyncController.awaitIfPaused() // honour notification Pause/Resume
                    if (SyncController.cancelled) { done.incrementAndGet(); return@Callable }
                    try {
                        val mappedFileId = db.fileIdFor(asset)
                        val stillInCloud = mappedFileId != null && (remoteFiles == null || mappedFileId in remoteFiles)
                        if (stillInCloud) {
                            // drift repair: file moved between buckets locally → mirror in cloud
                            if (db.mappedBucketFor(asset) != asset.bucketName) {
                                client.moveFile(mappedFileId!!, folderFor(asset.bucketName))
                                db.rememberMapping(asset, mappedFileId)
                            }
                            // backfill a preview for files uploaded before previews existed
                            if (remoteFiles?.get(mappedFileId)?.previewBlobId == null) {
                                makeAndUploadPreview(asset, mappedFileId!!)
                            }
                            skipped.incrementAndGet()
                            consecutiveNetFails.set(0)
                            return@Callable
                        }
                        // Stale mapping: keep the AI analysis aside — the bytes don't
                        // change, so it stays valid for the re-uploaded (or, with
                        // dedupe, the very same) file. Before this, a delta glitch
                        // could silently wipe thousands of cached analyses.
                        var carriedEnrichment: EnrichmentRecord? = null
                        if (mappedFileId != null) {
                            AppLog.w("SyncRunner", "stale mapping: ${asset.displayName} (cloud file $mappedFileId gone) — re-uploading")
                            carriedEnrichment = db.enrichmentFor(mappedFileId)
                            db.forgetFile(mappedFileId)
                        }
                        val outcome = uploadEngine.uploadStream(
                            open = { scanner.openStream(asset) },
                            fileName = asset.displayName,
                            mimeType = asset.mimeType,
                            parentFolderId = folderFor(asset.bucketName),
                            filesKey = filesKey,
                        )
                        db.rememberMapping(asset, outcome.fileId)
                        if (carriedEnrichment != null && db.enrichmentFor(outcome.fileId) == null) {
                            db.rememberEnrichment(outcome.fileId, carriedEnrichment)
                        }
                        if (outcome.deduplicated) {
                            deduplicated.incrementAndGet()
                        } else {
                            uploaded.incrementAndGet()
                            bytesDone.addAndGet(asset.sizeBytes)
                            // attach an E2EE preview so this file can later be browsed
                            // offline in previews-only mode (best-effort)
                            makeAndUploadPreview(asset, outcome.fileId)
                        }
                        consecutiveNetFails.set(0)
                    } catch (e: Throwable) {
                        // Throwable, not Exception: an OutOfMemoryError on one corrupt/huge
                        // file must not kill the whole pass (the pre-0.5.0 crash loop)
                        failed.incrementAndGet()
                        AppLog.w("SyncRunner", "sync failed for ${asset.displayName} (${asset.sizeBytes} B, ${asset.mimeType})", e)
                        // Server unreachable → stop fast instead of grinding through
                        // thousands of identical network failures (slow + log spam).
                        if (isUnreachable(e)) {
                            if (consecutiveNetFails.incrementAndGet() >= NET_FAIL_ABORT && aborted.compareAndSet(false, true)) {
                                AppLog.w("SyncRunner", "aborting sync — server unreachable")
                            }
                        } else {
                            consecutiveNetFails.set(0)
                        }
                    } finally {
                        done.incrementAndGet()
                        report(asset.displayName)
                    }
                }
            }
            pool.invokeAll(tasks) // blocks until every task finishes (or aborts)
        } finally {
            pool.shutdownNow()
        }

        AppLog.i("SyncRunner", "sync done: ↑${uploaded.get()}, ${deduplicated.get()} dedup, ${skipped.get()} skipped, ${failed.get()} failed")
        return Progress("sync", total, total, "done", uploaded.get(), deduplicated.get(), skipped.get(), 0, failed.get(), bytesDone = bytesDone.get())
    }

    /**
     * Sync FROM cloud: download files that exist in the cloud but not locally
     * (e.g. on a new device) back into the device gallery (MediaStore). Files
     * already in asset_map are skipped. Honours pause/cancel.
     */
    fun downloadFromCloud(onProgress: (Progress) -> Unit): Progress {
        val remote = client.galleryDeltaAll(null).files.filter { it.status == "READY" && it.deletedAt == null }
        val have = db.mappedFileIds()
        val missing = remote.filter { it.id !in have }
        val folderNames = folderNameMap() // folderId → decrypted bucket name
        val total = missing.size
        var downloaded = 0
        var failed = 0
        var bytesDone = 0L
        AppLog.i("SyncRunner", "download from cloud: $total missing of ${remote.size}")

        for ((index, file) in missing.withIndex()) {
            SyncController.awaitIfPaused()
            if (SyncController.cancelled) break
            onProgress(Progress("download", index, total, "", failed = failed, downloaded = downloaded, bytesDone = bytesDone))
            try {
                val rootFek = DdvCrypto.unwrapRootFek(file.wrappedFEK, filesKey)
                val name = file.encryptedName?.let { DdvCrypto.decryptMeta(rootFek, it) } ?: file.id
                val mime = file.encryptedMimeType?.let { DdvCrypto.decryptMeta(rootFek, it) } ?: "application/octet-stream"
                val bucket = file.parentFolderId?.let { folderNames[it] } ?: "DiscorDrive"
                val result = CloudDownloader.writeToGallery(context, file, filesKey, name, mime, bucket, uploadEngine)
                if (result != null) {
                    db.rememberMapping(
                        MediaAsset(result.assetId, android.net.Uri.EMPTY, name, bucket, mime, result.bytes, System.currentTimeMillis() / 1000, mime.startsWith("video/")),
                        file.id,
                    )
                    downloaded++
                    bytesDone += result.bytes
                } else {
                    failed++
                }
            } catch (e: Throwable) {
                failed++
                AppLog.w("SyncRunner", "download failed for ${file.id}", e)
            }
        }
        AppLog.i("SyncRunner", "download done: $downloaded downloaded, $failed failed")
        return Progress("download", total, total, "done", failed = failed, downloaded = downloaded, bytesDone = bytesDone)
    }

    /**
     * Sync FROM cloud, previews only: downloads each cloud file's small E2EE
     * preview (not the full bytes) into app-private storage and records a
     * cloud-only gallery item, so a fresh device gets a browsable, offline
     * gallery cheaply. The full file is fetched on demand when an item is opened.
     * Files without a cloud preview (uploaded before previews existed) are
     * skipped — a "Wyślij do chmury" pass from the owning device backfills them.
     */
    fun downloadPreviewsFromCloud(onProgress: (Progress) -> Unit): Progress {
        val remote = client.galleryDeltaAll(null).files.filter { it.status == "READY" && it.deletedAt == null }
        val haveLocal = db.mappedFileIds()
        val haveCloud = db.cloudItemFileIds()
        val missing = remote.filter { it.previewBlobId != null && it.id !in haveLocal && it.id !in haveCloud }
        val folderNames = folderNameMap()
        val previewDir = java.io.File(context.filesDir, "previews").apply { mkdirs() }
        val total = missing.size
        var downloaded = 0
        var failed = 0
        AppLog.i("SyncRunner", "download previews: $total of ${remote.size} (no preview: ${remote.count { it.previewBlobId == null }})")

        for ((index, file) in missing.withIndex()) {
            SyncController.awaitIfPaused()
            if (SyncController.cancelled) break
            onProgress(Progress("preview", index, total, "", downloaded = downloaded, failed = failed))
            try {
                val bytes = uploadEngine.downloadPreview(file, filesKey) ?: run { failed++; null } ?: continue
                val rootFek = DdvCrypto.unwrapRootFek(file.wrappedFEK, filesKey)
                val name = file.encryptedName?.let { DdvCrypto.decryptMeta(rootFek, it) } ?: file.id
                val mime = file.encryptedMimeType?.let { DdvCrypto.decryptMeta(rootFek, it) } ?: "application/octet-stream"
                val bucket = file.parentFolderId?.let { folderNames[it] } ?: "DiscorDrive"
                val dateSec = runCatching { java.time.Instant.parse(file.createdAt).epochSecond }
                    .getOrDefault(System.currentTimeMillis() / 1000)
                val out = java.io.File(previewDir, file.id.replace(Regex("[^A-Za-z0-9_-]"), "_") + ".jpg")
                out.writeBytes(bytes)
                db.rememberCloudItem(
                    fileId = file.id,
                    bucket = bucket,
                    name = name,
                    mime = mime,
                    sizeBytes = file.totalCiphertextBytes.toLongOrNull() ?: 0L,
                    dateAddedSec = dateSec,
                    isVideo = mime.startsWith("video/"),
                    previewPath = out.absolutePath,
                )
                downloaded++
            } catch (e: Throwable) {
                failed++
                AppLog.w("SyncRunner", "preview download failed for ${file.id}", e)
            }
        }
        AppLog.i("SyncRunner", "previews done: $downloaded downloaded, $failed failed")
        return Progress("preview", total, total, "done", downloaded = downloaded, failed = failed)
    }

    /** Best-effort: builds a small JPEG preview from the local asset, uploads it E2EE. */
    private fun makeAndUploadPreview(asset: MediaAsset, fileId: String) {
        runCatching {
            uploadEngine.uploadPreview(fileId, AiImagePreparer.prepare(context, asset), filesKey)
        }.onFailure { AppLog.w("SyncRunner", "preview upload failed for ${asset.displayName}", it) }
    }

    /** folderId → decrypted bucket name, for restoring items into the right album. */
    private fun folderNameMap(): Map<String, String?> =
        client.folders(null).associate { f ->
            f.id to runCatching {
                val key = DdvCrypto.unwrapKeyPacked(DdvCrypto.b64decode(f.wrappedFolderKey), filesKey)
                val body = DdvCrypto.decryptMeta(key, f.encryptedBody)
                (kotlinx.serialization.json.Json.parseToJsonElement(body) as kotlinx.serialization.json.JsonObject)
                    .getValue("name").let { (it as kotlinx.serialization.json.JsonPrimitive).content }
            }.getOrNull()
        }

    /**
     * AI enrichment pass.
     * @param bucketFilter analyze only this album (null = whole library)
     * @param limit max NEW analyses this run (0 = unlimited) — for rate-limited
     *   gateways (e.g. OpenRouter free: 20/min, 2000/day)
     * @param concurrency parallel AI requests (default 1). Each worker self-spaces
     *   its calls ~3.2s apart (≤19/min), so a gateway fronting N accounts can use
     *   concurrency=N for ~N×19/min. 429s wait + retry once.
     */
    fun aiScan(
        ai: AiVisionClient,
        model: String,
        bucketFilter: String? = null,
        limit: Int = 0,
        concurrency: Int = 1,
        onProgress: (Progress) -> Unit,
    ): Progress {
        val assets = scanner.scanAll().filter { bucketFilter == null || it.bucketName == bucketFilter }
        val remoteFiles = client.galleryDeltaAll(null).files
            .filter { it.status == "READY" && it.deletedAt == null }
            .associateBy { it.id }
        // per-album context hints for the AI prompt (fetched once per bucket)
        val albumHints = assets.map { it.bucketName }.toSet()
            .associateWith { AlbumDescriptions.load(client, filesKey, it) }

        val total = assets.size
        val analyzed = AtomicInteger(0)
        val skipped = AtomicInteger(0)
        val failed = AtomicInteger(0)
        val done = AtomicInteger(0)
        val reserved = AtomicInteger(0) // NEW-analysis slots claimed against [limit]
        val cursor = AtomicInteger(0)
        val stop = AtomicBoolean(false)

        fun report(detail: String) = onProgress(
            Progress("ai", done.get(), total, detail, analyzed = analyzed.get(), skipped = skipped.get(), failed = failed.get()),
        )

        val workerCount = concurrency.coerceIn(1, 8)
        val pool = Executors.newFixedThreadPool(workerCount)
        val worker = Callable {
            var lastCallAtMs = 0L
            while (!stop.get() && !SyncController.cancelled) {
                SyncController.awaitIfPaused() // honour the notification Pause/Resume
                if (SyncController.cancelled) break
                val i = cursor.getAndIncrement()
                if (i >= assets.size) break
                val asset = assets[i]
                try {
                    val fileId = db.fileIdFor(asset)
                    if (fileId == null || db.enrichmentFor(fileId) != null) { skipped.incrementAndGet(); continue }
                    val file = remoteFiles[fileId] ?: run { skipped.incrementAndGet(); null } ?: continue

                    // remote may already have it (other device) — cache locally
                    val remote = enrichment.loadEnrichment(file, filesKey)
                    if (remote != null) {
                        db.rememberEnrichment(fileId, remote)
                        skipped.incrementAndGet()
                        continue
                    }

                    // claim a slot against the per-run limit (counts each API attempt)
                    if (limit > 0 && reserved.incrementAndGet() > limit) {
                        reserved.decrementAndGet()
                        stop.set(true)
                        break
                    }

                    // per-worker throttle (≤19/min each → ~workerCount×19/min total)
                    val sinceLast = System.currentTimeMillis() - lastCallAtMs
                    if (sinceLast < AI_CALL_SPACING_MS) Thread.sleep(AI_CALL_SPACING_MS - sinceLast)

                    val hint = albumHints[asset.bucketName]
                    val transcript = if (asset.isVideo) transcribeVideo(asset) else null
                    lastCallAtMs = System.currentTimeMillis()
                    val vision = try {
                        runVision(ai, asset, hint, transcript)
                    } catch (rateLimit: AiRateLimitException) {
                        Thread.sleep(rateLimit.retryAfterSeconds.coerceAtMost(120) * 1000)
                        lastCallAtMs = System.currentTimeMillis()
                        runVision(ai, asset, hint, transcript)
                    }
                    val record = enrichment.buildRecord(vision, model, transcript)
                    enrichment.saveEnrichment(fileId, file.wrappedFEK, filesKey, record)
                    db.rememberEnrichment(fileId, record)
                    analyzed.incrementAndGet()
                } catch (e: Exception) {
                    failed.incrementAndGet()
                    AppLog.w("SyncRunner", "AI failed for ${asset.displayName}", e)
                } finally {
                    done.incrementAndGet()
                    report(asset.displayName)
                }
            }
        }
        try {
            pool.invokeAll(List(workerCount) { worker })
        } finally {
            pool.shutdownNow()
        }

        AppLog.i("SyncRunner", "ai done: ${analyzed.get()} analyzed, ${skipped.get()} skipped, ${failed.get()} failed (x$workerCount)")
        // Back up the enrichment cache to the E2EE cloud index so other/new devices get it.
        if (analyzed.get() > 0) EnrichmentIndex.push(client, filesKey, db)
        return Progress("ai", total, total, "done", analyzed = analyzed.get(), skipped = skipped.get(), failed = failed.get())
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
        val transcript = if (asset.isVideo) transcribeVideo(asset) else null
        val vision = try {
            runVision(ai, asset, hint, transcript)
        } catch (rateLimit: AiRateLimitException) {
            Thread.sleep(rateLimit.retryAfterSeconds.coerceAtMost(120) * 1000)
            runVision(ai, asset, hint, transcript)
        }
        val record = enrichment.buildRecord(vision, model, transcript)
        enrichment.saveEnrichment(fileId, file.wrappedFEK, filesKey, record)
        db.rememberEnrichment(fileId, record)
        EnrichmentIndex.push(client, filesKey, db) // keep the E2EE cloud index current
        return record
    }

    /**
     * Images → single downscaled frame; videos → several frames sampled across
     * the duration, analyzed frame-by-frame (batched, requests spaced by the
     * same throttle as image calls). The transcript is computed by the CALLER
     * (once, outside the rate-limit retry) and stored in the record so search
     * can match spoken quotes.
     */
    private fun runVision(ai: AiVisionClient, asset: MediaAsset, hint: String?, transcript: String?): AiVisionClient.VisionResult =
        if (asset.isVideo) {
            ai.analyzeVideo(
                AiImagePreparer.prepareVideoFrames(context, asset),
                hint,
                transcript = transcript,
                interBatchDelayMs = AI_CALL_SPACING_MS,
            )
        } else {
            ai.analyzeImage(AiImagePreparer.prepare(context, asset), "image/jpeg", hint)
        }

    /** Optional audio transcript for a video, when a transcription endpoint is configured. */
    private fun transcribeVideo(asset: MediaAsset): String? {
        if (!Settings.transcriptionConfigured(context)) return null
        return runCatching {
            val audio = AudioExtractor.extractAudio(context, asset) ?: return null
            try {
                com.discordrive.gallery.api.TranscriptionClient(
                    Settings.transcriptionUrl(context),
                    Settings.transcriptionKey(context),
                    Settings.transcriptionModel(context),
                ).transcribe(audio)
            } finally {
                audio.delete()
            }
        }.onFailure { AppLog.w("SyncRunner", "transcription failed for ${asset.displayName}", it) }
            .getOrNull()?.takeIf { it.isNotBlank() }
    }

    /** True if the failure looks like the server is unreachable (no network / DNS / connect). */
    private fun isUnreachable(error: Throwable): Boolean {
        var c: Throwable? = error
        while (c != null) {
            if (c is java.net.UnknownHostException || c is java.net.ConnectException || c is java.net.SocketTimeoutException) return true
            c = c.cause
        }
        return false
    }

    private companion object {
        const val AI_CALL_SPACING_MS = 3200L
        const val NET_FAIL_ABORT = 8 // bail after this many consecutive network failures
        const val UPLOAD_CONCURRENCY = 4 // files uploaded in parallel
    }
}
