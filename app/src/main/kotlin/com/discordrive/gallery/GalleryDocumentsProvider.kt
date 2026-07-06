package com.discordrive.gallery

import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Bitmap
import android.net.Uri
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.util.Size
import java.io.File
import java.io.FileNotFoundException

/**
 * Storage Access Framework face of the gallery: the app shows up as a source
 * in the system file picker (e.g. Discord → attach → Files), with albums as
 * directories and — the actual point — the AI enrichment cache backing the
 * picker's search box, so files can be found by tags/description/transcript
 * while attaching. Cloud-only items are downloaded+decrypted on open; their
 * local E2EE preview serves as the thumbnail.
 */
class GalleryDocumentsProvider : DocumentsProvider() {

    override fun onCreate(): Boolean = true

    // --- library snapshot (memoized: DocumentsUI queries in bursts) ---

    private data class Snapshot(val assets: List<MediaAsset>, val atMs: Long)

    @Volatile private var snapshot: Snapshot? = null

    private fun assets(): List<MediaAsset> {
        val cached = snapshot
        val now = System.currentTimeMillis()
        if (cached != null && now - cached.atMs < SNAPSHOT_TTL_MS) return cached.assets
        val fresh = MediaScanner(context!!).scanGallery()
        snapshot = Snapshot(fresh, now)
        return fresh
    }

    private fun docIdOf(asset: MediaAsset): String =
        asset.cloudFileId?.let { "cloud:$it" } ?: "media:${asset.id}"

    private fun assetFor(docId: String): MediaAsset? = when {
        docId.startsWith("cloud:") -> assets().find { it.cloudFileId == docId.removePrefix("cloud:") }
        docId.startsWith("media:") -> {
            val id = docId.removePrefix("media:").toLongOrNull()
            assets().find { it.cloudFileId == null && it.id == id }
        }
        else -> null
    }

    // --- roots ---

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val cursor = MatrixCursor(projection ?: DEFAULT_ROOT_PROJECTION)
        cursor.newRow()
            .add(Root.COLUMN_ROOT_ID, ROOT_ID)
            .add(Root.COLUMN_DOCUMENT_ID, DOC_ROOT)
            .add(Root.COLUMN_TITLE, context!!.getString(R.string.app_name))
            .add(Root.COLUMN_SUMMARY, context!!.getString(R.string.saf_summary))
            .add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
            .add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_SEARCH or Root.FLAG_SUPPORTS_RECENTS)
            .add(Root.COLUMN_MIME_TYPES, "image/*\nvideo/*")
        return cursor
    }

    // --- documents ---

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
        val cursor = MatrixCursor(projection ?: DEFAULT_DOC_PROJECTION)
        when {
            documentId == DOC_ROOT -> cursor.addDirRow(DOC_ROOT, context!!.getString(R.string.app_name))
            documentId == DOC_ALL -> cursor.addDirRow(DOC_ALL, context!!.getString(R.string.saf_all_photos))
            documentId.startsWith("album:") ->
                cursor.addDirRow(documentId, Uri.decode(documentId.removePrefix("album:")))
            else -> assetFor(documentId)?.let { cursor.addAssetRow(it) }
                ?: throw FileNotFoundException("Unknown document $documentId")
        }
        return cursor
    }

    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor {
        val cursor = MatrixCursor(projection ?: DEFAULT_DOC_PROJECTION)
        if (parentDocumentId == DOC_ROOT) {
            // one-tap full library first, then the album directories
            cursor.addDirRow(DOC_ALL, context!!.getString(R.string.saf_all_photos))
            assets().map { it.bucketName }.distinct().sortedBy { it.lowercase() }.forEach { bucket ->
                cursor.addDirRow("album:${Uri.encode(bucket)}", bucket)
            }
            return cursor
        }
        if (parentDocumentId == DOC_ALL) {
            assets().sortedByDescending { it.dateAddedSec }.forEach { cursor.addAssetRow(it) }
            return cursor
        }
        if (parentDocumentId.startsWith("album:")) {
            val bucket = Uri.decode(parentDocumentId.removePrefix("album:"))
            assets().filter { it.bucketName == bucket }
                .sortedByDescending { it.dateAddedSec }
                .forEach { cursor.addAssetRow(it) }
            return cursor
        }
        throw FileNotFoundException("Not a directory: $parentDocumentId")
    }

    /**
     * Newest items for the picker's landing "Recent" grid — photos are
     * visible with thumbnails before entering any folder.
     */
    override fun queryRecentDocuments(rootId: String, projection: Array<out String>?): Cursor {
        val cursor = MatrixCursor(projection ?: DEFAULT_DOC_PROJECTION)
        assets().sortedByDescending { it.dateAddedSec }
            .take(MAX_RECENT_RESULTS)
            .forEach { cursor.addAssetRow(it) }
        return cursor
    }

    /**
     * The picker's search box, backed by the local AI cache: matches file
     * names, tags, descriptions, OCR text and video transcripts — this is
     * what makes attaching a file findable by "what's on it".
     */
    override fun querySearchDocuments(rootId: String, query: String, projection: Array<out String>?): Cursor {
        val cursor = MatrixCursor(projection ?: DEFAULT_DOC_PROJECTION)
        val q = query.trim().lowercase()
        if (q.isEmpty()) return cursor

        val db = AppDb(context!!)
        val hitFileIds = db.allEnrichments().filter { (_, record) ->
            record.description.lowercase().contains(q) ||
                record.tags.any { it.lowercase().contains(q) } ||
                record.ocrText?.lowercase()?.contains(q) == true ||
                record.transcript?.lowercase()?.contains(q) == true
        }.keys
        val hitAssetIds = hitFileIds.mapNotNull { db.assetIdForFile(it) }.toSet()

        assets().asSequence()
            .filter { asset ->
                asset.displayName.lowercase().contains(q) ||
                    asset.id in hitAssetIds ||
                    asset.cloudFileId?.let { it in hitFileIds } == true
            }
            .sortedByDescending { it.dateAddedSec }
            .take(MAX_SEARCH_RESULTS)
            .forEach { cursor.addAssetRow(it) }
        return cursor
    }

    // --- content ---

    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
        if (!mode.startsWith("r")) throw FileNotFoundException("Read-only provider")
        val asset = assetFor(documentId) ?: throw FileNotFoundException("Unknown document $documentId")
        val cloudFileId = asset.cloudFileId
            ?: return context!!.contentResolver.openFileDescriptor(asset.uri, "r")
                ?: throw FileNotFoundException("Cannot open ${asset.displayName}")
        return ParcelFileDescriptor.open(fetchCloudFile(cloudFileId, asset), ParcelFileDescriptor.MODE_READ_ONLY)
    }

    /** Downloads+decrypts a cloud-only file into the cache (reused across picks). */
    private fun fetchCloudFile(fileId: String, asset: MediaAsset): File {
        val dir = File(context!!.cacheDir, "saf").apply { mkdirs() }
        val target = File(dir, fileId.replace(Regex("[^A-Za-z0-9_-]"), "_"))
        if (target.length() > 0) return target
        if (!SessionManager.restore(context!!)) throw FileNotFoundException("Zaloguj się w DiscorDrive Gallery")
        val client = SessionManager.client ?: throw FileNotFoundException("Brak sesji")
        val filesKey = SessionManager.filesKey ?: throw FileNotFoundException("Brak klucza")
        val file = client.file(fileId) ?: throw FileNotFoundException("Plik zniknął z chmury")
        try {
            target.outputStream().use { out ->
                com.discordrive.gallery.api.UploadEngine(client).downloadToStream(file, filesKey, out)
            }
        } catch (e: Exception) {
            target.delete()
            AppLog.w("SafProvider", "cloud fetch failed for $fileId", e)
            throw FileNotFoundException("Pobieranie nie powiodło się: ${e.message}")
        }
        return target
    }

    override fun openDocumentThumbnail(documentId: String, sizeHint: android.graphics.Point, signal: CancellationSignal?): AssetFileDescriptor {
        val asset = assetFor(documentId) ?: throw FileNotFoundException("Unknown document $documentId")
        // cloud-only: the downloaded E2EE preview JPEG is exactly a thumbnail
        asset.previewPath?.let { path ->
            val f = File(path)
            if (f.exists()) {
                return AssetFileDescriptor(
                    ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY), 0, AssetFileDescriptor.UNKNOWN_LENGTH,
                )
            }
        }
        if (asset.cloudFileId != null) throw FileNotFoundException("No preview for $documentId")
        val bitmap = context!!.contentResolver.loadThumbnail(
            asset.uri, Size(sizeHint.x.coerceAtLeast(96), sizeHint.y.coerceAtLeast(96)), signal,
        )
        val cached = File(File(context!!.cacheDir, "saf-thumbs").apply { mkdirs() }, "${asset.id}.jpg")
        cached.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 82, it) }
        return AssetFileDescriptor(
            ParcelFileDescriptor.open(cached, ParcelFileDescriptor.MODE_READ_ONLY), 0, AssetFileDescriptor.UNKNOWN_LENGTH,
        )
    }

    // --- row helpers ---

    private fun MatrixCursor.addDirRow(docId: String, name: String) {
        newRow()
            .add(Document.COLUMN_DOCUMENT_ID, docId)
            .add(Document.COLUMN_DISPLAY_NAME, name)
            .add(Document.COLUMN_MIME_TYPE, Document.MIME_TYPE_DIR)
            .add(Document.COLUMN_SIZE, null)
            .add(Document.COLUMN_LAST_MODIFIED, null)
            // photos inside — DocumentsUI should open these as a thumbnail grid
            .add(Document.COLUMN_FLAGS, Document.FLAG_DIR_PREFERS_GRID)
    }

    private fun MatrixCursor.addAssetRow(asset: MediaAsset) {
        newRow()
            .add(Document.COLUMN_DOCUMENT_ID, docIdOf(asset))
            .add(Document.COLUMN_DISPLAY_NAME, asset.displayName)
            .add(Document.COLUMN_MIME_TYPE, asset.mimeType)
            .add(Document.COLUMN_SIZE, asset.sizeBytes)
            .add(Document.COLUMN_LAST_MODIFIED, asset.dateAddedSec * 1000)
            .add(
                Document.COLUMN_FLAGS,
                if (asset.cloudFileId == null || asset.previewPath != null) Document.FLAG_SUPPORTS_THUMBNAIL else 0,
            )
    }

    private companion object {
        const val ROOT_ID = "gallery"
        const val DOC_ROOT = "root"
        const val DOC_ALL = "all"
        const val SNAPSHOT_TTL_MS = 15_000L
        const val MAX_SEARCH_RESULTS = 200
        const val MAX_RECENT_RESULTS = 64 // DocumentsUI caps recents per root anyway

        val DEFAULT_ROOT_PROJECTION = arrayOf(
            Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_SUMMARY,
            Root.COLUMN_ICON, Root.COLUMN_FLAGS, Root.COLUMN_MIME_TYPES,
        )
        val DEFAULT_DOC_PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS,
        )
    }
}
