package com.discordrive.gallery

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore

data class MediaAsset(
    val id: Long,
    val uri: Uri,
    val displayName: String,
    val bucketName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val dateAddedSec: Long,
    val isVideo: Boolean,
)

/**
 * Reads the device media library with bucket (folder) attribution — the
 * source of truth for what the sync engine mirrors into DiscorDrive.
 */
class MediaScanner(private val context: Context) {

    fun scanAll(): List<MediaAsset> =
        (scan(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, isVideo = false) +
            scan(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, isVideo = true))
            .sortedByDescending { it.dateAddedSec }

    fun findById(assetId: Long): MediaAsset? = scanAll().firstOrNull { it.id == assetId }

    private fun scan(collection: Uri, isVideo: Boolean): List<MediaAsset> {
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.BUCKET_DISPLAY_NAME,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_ADDED,
        )

        val assets = mutableListOf<MediaAsset>()
        // Note: rows with is_pending=1 are invisible here by design (e.g. files
        // adb-pushed in tests need a scan_volume call to finalize them).
        val cursor = context.contentResolver.query(collection, projection, null, null, null)
        android.util.Log.i("MediaScanner", "query $collection -> ${cursor?.count ?: "null"} rows")
        cursor?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val nameCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
            val bucketCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.BUCKET_DISPLAY_NAME)
            val mimeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
            val sizeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
            val dateCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)

            while (cursor.moveToNext()) {
                val id = cursor.getLong(idCol)
                assets += MediaAsset(
                    id = id,
                    uri = ContentUris.withAppendedId(collection, id),
                    displayName = cursor.getString(nameCol) ?: "unnamed-$id",
                    bucketName = cursor.getString(bucketCol) ?: "Unsorted",
                    mimeType = cursor.getString(mimeCol) ?: "application/octet-stream",
                    sizeBytes = cursor.getLong(sizeCol),
                    dateAddedSec = cursor.getLong(dateCol),
                    isVideo = isVideo,
                )
            }
        }
        return assets
    }

    fun readBytes(asset: MediaAsset): ByteArray =
        context.contentResolver.openInputStream(asset.uri)?.use { it.readBytes() }
            ?: throw IllegalStateException("Cannot open ${asset.uri}")

    /** Streaming access — sync MUST use this; whole-file reads OOM on large videos. */
    fun openStream(asset: MediaAsset): java.io.InputStream =
        context.contentResolver.openInputStream(asset.uri)
            ?: throw IllegalStateException("Cannot open ${asset.uri}")
}
