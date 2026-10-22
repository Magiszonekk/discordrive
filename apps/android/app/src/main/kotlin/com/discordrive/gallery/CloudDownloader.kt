package com.discordrive.gallery

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.provider.MediaStore
import com.discordrive.gallery.api.FileDto
import com.discordrive.gallery.api.UploadEngine

/**
 * Writes a cloud file back into the device gallery (MediaStore) — used by
 * "sync from cloud" to restore photos/videos on a new device. The decrypted
 * bytes are streamed straight into the MediaStore entry (no full buffering).
 */
object CloudDownloader {

    data class Result(val assetId: Long, val bytes: Long)

    /**
     * Inserts [name] into Pictures/<bucket> or Movies/<bucket> and streams the
     * decrypted file into it. Returns the new MediaStore id + byte count, or null.
     */
    fun writeToGallery(
        context: Context,
        file: FileDto,
        filesKey: ByteArray,
        name: String,
        mime: String,
        bucket: String,
        uploadEngine: UploadEngine,
    ): Result? {
        val isVideo = mime.startsWith("video/")
        val collection = if (isVideo) {
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        } else {
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }
        val relPath = (if (isVideo) "Movies/" else "Pictures/") + sanitize(bucket)

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, relPath)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(collection, values) ?: return null
        return try {
            var written = 0L
            resolver.openOutputStream(uri)?.use { out ->
                written = uploadEngine.downloadToStream(file, filesKey, out)
            } ?: error("no output stream")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            Result(ContentUris.parseId(uri), written)
        } catch (e: Throwable) {
            runCatching { resolver.delete(uri, null, null) } // drop the half-written pending entry
            AppLog.w("CloudDownloader", "download to gallery failed for $name", e)
            null
        }
    }

    private fun sanitize(bucket: String): String =
        bucket.ifBlank { "DiscorDrive" }.replace(Regex("[/\\\\:*?\"<>|]"), "_").take(64)
}
