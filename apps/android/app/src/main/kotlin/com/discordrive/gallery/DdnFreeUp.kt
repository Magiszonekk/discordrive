package com.discordrive.gallery

import android.app.PendingIntent
import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import java.security.MessageDigest

/**
 * "Free up space": photos and videos of this phone that have a copy in the account can be removed from the
 * phone. A copy counts only when the automatic copy recorded it (MediaStore ID, size and date as copied),
 * that node still exists outside the trash with the same size, and its SHA-256 equals the phone file's (read
 * now, so an edited photo is never removed). The removal goes through the system's own confirmation
 * (MediaStore.createTrashRequest, Android 11+: the system trash, 30 days to undo on the phone). Android 10
 * has no such request: the screen says so.
 */
object DdnFreeUp {
    data class Item(val mediaId: Long, val uri: Uri, val name: String, val size: Long, val nodeId: String)
    data class Scan(val ready: List<Item>, val notCopied: Int, val changed: Int, val gone: Int) {
        val bytes: Long get() = ready.sumOf { it.size }
    }

    /**
     * What may go (off the main thread; reads every candidate once for its hash). `limit` caps the number
     * checked in one scan (a big camera roll goes in steps).
     */
    fun scan(c: Context, limit: Int = 2000, progress: (Int, Int) -> Unit = { _, _ -> }): Scan {
        val s = DdnSession.get(c) ?: return Scan(emptyList(), 0, 0, 0)
        val acct = s.acct.accountId
        val db = DdnBackup.Db(c)
        val copied = db.copiedRows(acct)
        val media = DdnBackup.scan(c, DdnBackup.allBuckets(c).keys)
        val ready = ArrayList<Item>()
        var notCopied = 0
        var changed = 0
        var gone = 0
        val todo = media.take(limit)
        for ((i, m) in todo.withIndex()) {
            progress(i, todo.size)
            val rec = copied[m.id]
            if (rec == null || rec.size != m.size || rec.modified != m.modified) { notCopied++; continue }
            val node = s.node(rec.node)
            if (node == null || node.trashedAt != null || node.size != m.size) { gone++; continue }
            val want = node.sha256
            val have = runCatching { sha256Of(c, m.uri) }.getOrNull()
            if (want == null || have == null || want != have) { changed++; continue }
            ready += Item(m.id, m.uri, m.name, m.size, rec.node)
        }
        return Scan(ready, notCopied, changed, gone)
    }

    private fun sha256Of(c: Context, uri: Uri): String {
        val src = if (Build.VERSION.SDK_INT >= 29) runCatching { MediaStore.setRequireOriginal(uri) }.getOrDefault(uri) else uri
        val md = MessageDigest.getInstance("SHA-256")
        (runCatching { c.contentResolver.openInputStream(src)!! }.getOrElse { c.contentResolver.openInputStream(uri)!! }).use { inp ->
            val buf = ByteArray(256 * 1024)
            while (true) { val n = inp.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** The system's confirmation for removing them (null below Android 10: not offered). */
    fun request(c: Context, items: List<Item>): PendingIntent? {
        if (items.isEmpty() || Build.VERSION.SDK_INT < 30) return null
        val uris = items.map { normalize(it.uri, it.mediaId) }
        return MediaStore.createTrashRequest(c.contentResolver, uris, true)
    }

    private fun normalize(u: Uri, id: Long): Uri = u.takeIf { it.lastPathSegment == "$id" } ?: ContentUris.withAppendedId(u, id)
}
