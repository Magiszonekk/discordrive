package com.discordrive.gallery

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import com.discordrive.gallery.api.EnrichmentRecord
import kotlinx.serialization.json.Json

/**
 * Local sync state:
 *  - asset_map: which local MediaStore asset is which remote file (avoids
 *    recomputing dedupe tokens / re-uploading on every pass)
 *  - enrichment: decrypted AI tags/descriptions cache for instant search
 *  - cloud_item: cloud-only files downloaded as previews (no local copy), so a
 *    previews-only library is browsable offline; the full file is fetched on tap
 */
class AppDb(context: Context) : SQLiteOpenHelper(context, "gallery.db", null, 3) {

    private val json = Json { ignoreUnknownKeys = true }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE asset_map (
                asset_id INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL,
                file_id TEXT NOT NULL,
                bucket TEXT,
                PRIMARY KEY (asset_id, size_bytes)
            )""",
        )
        db.execSQL(
            """CREATE TABLE enrichment (
                file_id TEXT PRIMARY KEY,
                record_json TEXT NOT NULL
            )""",
        )
        createCloudItemTable(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE asset_map ADD COLUMN bucket TEXT")
        }
        if (oldVersion < 3) {
            createCloudItemTable(db)
        }
    }

    private fun createCloudItemTable(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE cloud_item (
                file_id TEXT PRIMARY KEY,
                synthetic_id INTEGER NOT NULL UNIQUE,
                bucket TEXT,
                name TEXT,
                mime TEXT,
                size_bytes INTEGER,
                date_added_sec INTEGER,
                is_video INTEGER,
                preview_path TEXT
            )""",
        )
    }

    // === asset ↔ remote file mapping ===

    fun fileIdFor(asset: MediaAsset): String? =
        readableDatabase.rawQuery(
            "SELECT file_id FROM asset_map WHERE asset_id = ? AND size_bytes = ?",
            arrayOf(asset.id.toString(), asset.sizeBytes.toString()),
        ).use { if (it.moveToFirst()) it.getString(0) else null }

    /** Remote file id for any gallery item — a local mapping or a cloud-only item. */
    fun fileIdForAny(asset: MediaAsset): String? = asset.cloudFileId ?: fileIdFor(asset)

    fun rememberMapping(asset: MediaAsset, fileId: String) {
        writableDatabase.insertWithOnConflict(
            "asset_map", null,
            ContentValues().apply {
                put("asset_id", asset.id)
                put("size_bytes", asset.sizeBytes)
                put("file_id", fileId)
                put("bucket", asset.bucketName)
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    /** Bucket the asset was in when last synced (drift detection). */
    fun mappedBucketFor(asset: MediaAsset): String? =
        readableDatabase.rawQuery(
            "SELECT bucket FROM asset_map WHERE asset_id = ? AND size_bytes = ?",
            arrayOf(asset.id.toString(), asset.sizeBytes.toString()),
        ).use { if (it.moveToFirst()) it.getString(0) else null }

    /** Removes all local traces of a remote file (after purge). */
    fun forgetFile(fileId: String) {
        writableDatabase.delete("asset_map", "file_id = ?", arrayOf(fileId))
        writableDatabase.delete("enrichment", "file_id = ?", arrayOf(fileId))
    }

    fun mappedFileIds(): Set<String> =
        readableDatabase.rawQuery("SELECT file_id FROM asset_map", null).use { cursor ->
            buildSet { while (cursor.moveToNext()) add(cursor.getString(0)) }
        }

    fun assetIdForFile(fileId: String): Long? =
        readableDatabase.rawQuery(
            "SELECT asset_id FROM asset_map WHERE file_id = ?",
            arrayOf(fileId),
        ).use { if (it.moveToFirst()) it.getLong(0) else null }

    // === enrichment cache ===

    fun enrichmentFor(fileId: String): EnrichmentRecord? =
        readableDatabase.rawQuery(
            "SELECT record_json FROM enrichment WHERE file_id = ?",
            arrayOf(fileId),
        ).use { cursor ->
            if (!cursor.moveToFirst()) return null
            runCatching { json.decodeFromString(EnrichmentRecord.serializer(), cursor.getString(0)) }.getOrNull()
        }

    fun rememberEnrichment(fileId: String, record: EnrichmentRecord) {
        writableDatabase.insertWithOnConflict(
            "enrichment", null,
            ContentValues().apply {
                put("file_id", fileId)
                put("record_json", json.encodeToString(EnrichmentRecord.serializer(), record))
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    fun enrichedFileIds(): Set<String> =
        readableDatabase.rawQuery("SELECT file_id FROM enrichment", null).use { cursor ->
            buildSet { while (cursor.moveToNext()) add(cursor.getString(0)) }
        }

    /** File ids that have a cached enrichment AND are mapped to the given bucket. */
    fun enrichedFileIdsInBucket(bucket: String): Set<String> =
        readableDatabase.rawQuery(
            "SELECT e.file_id FROM enrichment e JOIN asset_map a ON a.file_id = e.file_id WHERE a.bucket = ?",
            arrayOf(bucket),
        ).use { cursor -> buildSet { while (cursor.moveToNext()) add(cursor.getString(0)) } }

    /** Removes one file's cached enrichment (keeps its asset_map mapping). */
    fun forgetEnrichment(fileId: String) {
        writableDatabase.delete("enrichment", "file_id = ?", arrayOf(fileId))
    }

    fun clearAllEnrichments() {
        writableDatabase.delete("enrichment", null, null)
    }

    fun allEnrichments(): Map<String, EnrichmentRecord> =
        readableDatabase.rawQuery("SELECT file_id, record_json FROM enrichment", null).use { cursor ->
            buildMap {
                while (cursor.moveToNext()) {
                    runCatching { json.decodeFromString(EnrichmentRecord.serializer(), cursor.getString(1)) }
                        .getOrNull()?.let { put(cursor.getString(0), it) }
                }
            }
        }

    // === cloud-only items (previews-only mode) ===

    fun rememberCloudItem(
        fileId: String,
        bucket: String,
        name: String,
        mime: String,
        sizeBytes: Long,
        dateAddedSec: Long,
        isVideo: Boolean,
        previewPath: String,
    ) {
        writableDatabase.insertWithOnConflict(
            "cloud_item", null,
            ContentValues().apply {
                put("file_id", fileId)
                put("synthetic_id", syntheticId(fileId))
                put("bucket", bucket)
                put("name", name)
                put("mime", mime)
                put("size_bytes", sizeBytes)
                put("date_added_sec", dateAddedSec)
                put("is_video", if (isVideo) 1 else 0)
                put("preview_path", previewPath)
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    /** Cloud-only items as gallery assets (uri = empty, preview backs the thumbnail). */
    fun cloudItemsAsAssets(): List<MediaAsset> =
        readableDatabase.rawQuery(
            "SELECT file_id, synthetic_id, bucket, name, mime, size_bytes, date_added_sec, is_video, preview_path FROM cloud_item",
            null,
        ).use { c ->
            buildList {
                while (c.moveToNext()) {
                    add(
                        MediaAsset(
                            id = c.getLong(1),
                            uri = Uri.EMPTY,
                            displayName = c.getString(3) ?: c.getString(0),
                            bucketName = c.getString(2) ?: "DiscorDrive",
                            mimeType = c.getString(4) ?: "application/octet-stream",
                            sizeBytes = c.getLong(5),
                            dateAddedSec = c.getLong(6),
                            isVideo = c.getInt(7) == 1,
                            cloudFileId = c.getString(0),
                            previewPath = c.getString(8),
                        ),
                    )
                }
            }
        }

    fun cloudItemFileIds(): Set<String> =
        readableDatabase.rawQuery("SELECT file_id FROM cloud_item", null).use { c ->
            buildSet { while (c.moveToNext()) add(c.getString(0)) }
        }

    /** Removes a cloud-only item (e.g. after its full file was downloaded locally). */
    fun forgetCloudItem(fileId: String) {
        writableDatabase.delete("cloud_item", "file_id = ?", arrayOf(fileId))
    }

    fun clearCloudItems() {
        writableDatabase.delete("cloud_item", null, null)
    }

    companion object {
        /**
         * Stable, strictly-negative synthetic id for a cloud-only item, derived
         * from its file id. MediaStore ids are positive, so negatives never
         * collide with local assets, and the gallery can key selection/cache by
         * the single Long [MediaAsset.id] for both kinds of item.
         */
        fun syntheticId(fileId: String): Long {
            val h = java.security.MessageDigest.getInstance("SHA-256").digest(fileId.toByteArray())
            var v = 0L
            for (i in 0 until 8) v = (v shl 8) or (h[i].toLong() and 0xff)
            return -(v and Long.MAX_VALUE) - 1
        }
    }
}
