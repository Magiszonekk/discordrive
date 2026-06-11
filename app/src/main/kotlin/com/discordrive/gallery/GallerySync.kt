package com.discordrive.gallery

import com.discordrive.gallery.api.DiscorDriveClient
import com.discordrive.gallery.api.FolderManager
import com.discordrive.gallery.api.UploadEngine

/**
 * v1 sync pass: mirror every MediaStore bucket as an encrypted folder and
 * upload its assets (server-side dedupe via HMAC tokens makes re-runs cheap).
 *
 * Roadmap: local Room state, ContentObserver incremental sync, WorkManager
 * scheduling (charger+WiFi), free-up-space after health check.
 */
class GallerySync(
    private val client: DiscorDriveClient,
    private val scanner: MediaScanner,
    private val filesKey: ByteArray,
) {
    private val uploadEngine = UploadEngine(client)
    private val folderManager = FolderManager(client)

    data class Progress(val done: Int, val total: Int, val current: String, val uploaded: Int, val deduplicated: Int, val failed: Int)

    fun syncAll(onProgress: (Progress) -> Unit): Progress {
        val assets = scanner.scanAll()
        val folderIds = mutableMapOf<String, String>()
        var uploaded = 0
        var deduplicated = 0
        var failed = 0

        assets.forEachIndexed { index, asset ->
            onProgress(Progress(index, assets.size, asset.displayName, uploaded, deduplicated, failed))
            try {
                val folderId = folderIds.getOrPut(asset.bucketName) {
                    folderManager.ensureFolder(asset.bucketName, parentFolderId = null, filesKey = filesKey)
                }
                val outcome = uploadEngine.uploadFile(
                    content = scanner.readBytes(asset),
                    fileName = asset.displayName,
                    mimeType = asset.mimeType,
                    parentFolderId = folderId,
                    filesKey = filesKey,
                )
                if (outcome.deduplicated) deduplicated++ else uploaded++
            } catch (e: Exception) {
                failed++
                android.util.Log.w("GallerySync", "Upload failed for ${asset.displayName}", e)
            }
        }

        return Progress(assets.size, assets.size, "done", uploaded, deduplicated, failed)
    }
}
