package com.discordrive.gallery

import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Point
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.webkit.MimeTypeMap
import io.github.magiszonekk.discordrive.core.IndexReplica
import java.io.File
import java.io.FileNotFoundException

/**
 * The discordrive account in the system's file picker (Files, "Attach" in a messenger, GET_CONTENT / PICK /
 * OPEN_DOCUMENT of any app): the account's folders and files, read-only, with the stored thumbnails; opening
 * a file downloads it (decrypted, checked) into the app's cache once and hands it over. Folders inside private
 * albums of this phone are left out. No account on this phone: no root.
 */
class DdnDocumentsProvider : DocumentsProvider() {
    override fun onCreate(): Boolean = true

    private fun session(): DdnSession? = runCatching { DdnSessionDirs.cacheDir = context!!.cacheDir; DdnSession.get(context!!) }.getOrNull()

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val c = MatrixCursor(projection ?: ROOT_COLS)
        val acct = DdnAccount.load(context!!) ?: return c
        c.newRow()
            .add(Root.COLUMN_ROOT_ID, ROOT)
            .add(Root.COLUMN_DOCUMENT_ID, "root")
            .add(Root.COLUMN_TITLE, context!!.getString(R.string.ddn_saf_title))
            .add(Root.COLUMN_SUMMARY, acct.deviceName)
            .add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
            .add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_RECENTS or Root.FLAG_SUPPORTS_IS_CHILD)
        return c
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
        val c = MatrixCursor(projection ?: DOC_COLS)
        if (documentId == "root") { c.dir("root", context!!.getString(R.string.ddn_saf_title)); return c }
        if (documentId == RECENT) { c.dir(RECENT, context!!.getString(R.string.ddn_saf_recent)); return c }
        val s = session() ?: throw FileNotFoundException("no account")
        val n = s.node(documentId)?.takeIf { it.trashedAt == null } ?: throw FileNotFoundException(documentId)
        c.row(n)
        return c
    }

    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor {
        val c = MatrixCursor(projection ?: DOC_COLS)
        val s = session() ?: return c
        val locked = DdnPrivate.all(context!!)
        // The newest photos and videos first (a folder of their own at the top of the account).
        if (parentDocumentId == RECENT) { for (n in s.media(200, null, locked)) c.row(n); return c }
        if (parentDocumentId == "root") c.dir(RECENT, context!!.getString(R.string.ddn_saf_recent))
        for (n in s.children(parentDocumentId)) if (n.id !in locked) c.row(n)
        return c
    }

    /** The picker's first screen: the newest photos and videos (outside private albums). */
    override fun queryRecentDocuments(rootId: String, projection: Array<out String>?): Cursor {
        val c = MatrixCursor(projection ?: DOC_COLS)
        val s = session() ?: return c
        for (n in s.media(64, null, DdnPrivate.all(context!!))) c.row(n)
        return c
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
        if (parentDocumentId == documentId) return false
        if (parentDocumentId == RECENT) return false
        val s = session() ?: return false
        var p = s.node(documentId)?.parentId
        var guard = 0
        while (p != null && guard++ < 256) {
            if (p == parentDocumentId) return true
            if (parentDocumentId == "root" && p == "root") return true
            p = s.node(p)?.parentId
        }
        return false
    }

    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
        if (mode.contains('w')) throw FileNotFoundException("read-only")
        val s = session() ?: throw FileNotFoundException("no account")
        val n = s.node(documentId)?.takeIf { !it.isFolder && it.trashedAt == null } ?: throw FileNotFoundException(documentId)
        val ref = n.manifestRef ?: throw FileNotFoundException(documentId)
        val dir = File(context!!.cacheDir, "saf-ddn").apply { mkdirs() }
        // One file per version (the manifest reference names it): a newer version is a new file.
        val f = File(dir, key(ref))
        if (!(f.isFile && f.length() == (n.size ?: -1))) {
            val part = File(f.path + ".part")
            try {
                part.outputStream().use { out -> s.files.download(ref, n.size ?: 0, n.sha256, out) { _, _ -> if (signal?.isCanceled == true) throw FileNotFoundException("cancelled") } }
                part.renameTo(f)
            } catch (e: Exception) {
                part.delete()
                throw FileNotFoundException("download failed: ${e.message}")
            }
            trimCache(dir)
        }
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun openDocumentThumbnail(documentId: String, sizeHint: Point, signal: CancellationSignal?): AssetFileDescriptor {
        val s = session() ?: throw FileNotFoundException("no account")
        val ref = s.node(documentId)?.manifestRef ?: throw FileNotFoundException(documentId)
        val p = runCatching { s.files.preview(ref, 't') }.getOrNull() ?: throw FileNotFoundException("no thumbnail")
        val f = File(File(context!!.cacheDir, "saf-ddn-thumbs").apply { mkdirs() }, key(ref))
        if (!f.isFile) f.writeBytes(p.data)
        return AssetFileDescriptor(ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY), 0, AssetFileDescriptor.UNKNOWN_LENGTH)
    }

    /** At most 1 GB of opened files kept (the oldest go first). */
    private fun trimCache(dir: File) {
        val files = dir.listFiles()?.filter { it.isFile && !it.name.endsWith(".part") }?.sortedBy { it.lastModified() } ?: return
        var total = files.sumOf { it.length() }
        for (f in files) { if (total <= CACHE_MAX) break; total -= f.length(); f.delete() }
    }

    private fun MatrixCursor.dir(id: String, name: String) {
        newRow().add(Document.COLUMN_DOCUMENT_ID, id).add(Document.COLUMN_DISPLAY_NAME, name).add(Document.COLUMN_MIME_TYPE, Document.MIME_TYPE_DIR)
            .add(Document.COLUMN_SIZE, null).add(Document.COLUMN_LAST_MODIFIED, null).add(Document.COLUMN_FLAGS, Document.FLAG_DIR_PREFERS_GRID)
    }

    private fun MatrixCursor.row(n: IndexReplica.Child) {
        if (n.isFolder) return dir(n.id, n.name)
        val media = DdnSession.isImage(n.name) || DdnSession.isVideo(n.name)
        newRow().add(Document.COLUMN_DOCUMENT_ID, n.id).add(Document.COLUMN_DISPLAY_NAME, n.name).add(Document.COLUMN_MIME_TYPE, mimeOf(n.name))
            .add(Document.COLUMN_SIZE, n.size).add(Document.COLUMN_LAST_MODIFIED, n.createdAt.takeIf { it > 0 })
            .add(Document.COLUMN_FLAGS, if (media) Document.FLAG_SUPPORTS_THUMBNAIL else 0)
    }

    companion object {
        const val ROOT = "discordrive"
        /** The virtual folder of the newest photos and videos. */
        const val RECENT = "recent"
        private const val CACHE_MAX = 1024L * 1024 * 1024
        /** A file name for a version (its manifest reference holds the file key: never used as a name itself). */
        private fun key(ref: String) = java.security.MessageDigest.getInstance("SHA-256").digest(ref.toByteArray()).joinToString("") { "%02x".format(it) }.take(40)
        fun mimeOf(name: String): String = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
        private val ROOT_COLS = arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_SUMMARY, Root.COLUMN_ICON, Root.COLUMN_FLAGS)
        private val DOC_COLS = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS)
    }
}
