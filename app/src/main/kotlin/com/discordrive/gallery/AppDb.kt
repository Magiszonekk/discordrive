package com.discordrive.gallery

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.discordrive.gallery.api.EnrichmentRecord
import kotlinx.serialization.json.Json

/**
 * Local sync state:
 *  - asset_map: which local MediaStore asset is which remote file (avoids
 *    recomputing dedupe tokens / re-uploading on every pass)
 *  - enrichment: decrypted AI tags/descriptions cache for instant search
 */
class AppDb(context: Context) : SQLiteOpenHelper(context, "gallery.db", null, 2) {

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
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE asset_map ADD COLUMN bucket TEXT")
        }
    }

    // === asset ↔ remote file mapping ===

    fun fileIdFor(asset: MediaAsset): String? =
        readableDatabase.rawQuery(
            "SELECT file_id FROM asset_map WHERE asset_id = ? AND size_bytes = ?",
            arrayOf(asset.id.toString(), asset.sizeBytes.toString()),
        ).use { if (it.moveToFirst()) it.getString(0) else null }

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

    fun allEnrichments(): Map<String, EnrichmentRecord> =
        readableDatabase.rawQuery("SELECT file_id, record_json FROM enrichment", null).use { cursor ->
            buildMap {
                while (cursor.moveToNext()) {
                    runCatching { json.decodeFromString(EnrichmentRecord.serializer(), cursor.getString(1)) }
                        .getOrNull()?.let { put(cursor.getString(0), it) }
                }
            }
        }
}
