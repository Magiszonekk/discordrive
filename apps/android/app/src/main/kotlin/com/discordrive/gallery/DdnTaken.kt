package com.discordrive.gallery

import android.content.Context
import io.github.magiszonekk.discordrive.core.IndexReplica

/**
 * When each stored version's content was made (the manifest's takenAt: EXIF date of a photo, a file's
 * modification time), by manifestRef, in the local table of DdnAi (0 = looked at, not stored). The Gallery
 * groups and orders photos by it. This phone's uploads put it at once; photos from other devices are read
 * from their manifests in the background.
 */
object DdnTaken {
    /** Every version looked at (0 = the uploader stored no date). */
    fun takenAll(c: Context, account: String): Map<String, Long> {
        val out = HashMap<String, Long>()
        DdnAi.Db(c).readableDatabase.rawQuery("SELECT ref, at FROM taken WHERE account=?", arrayOf(account)).use { cur ->
            while (cur.moveToNext()) out[cur.getString(0)] = cur.getLong(1)
        }
        return out
    }

    fun put(c: Context, account: String, ref: String, at: Long) {
        if (at > 0) DdnAi.Db(c).putTaken(account, ref, at)
    }

    /** Reads the manifests of up to `budget` versions not looked at yet; returns how many were read. */
    fun fillMissing(c: Context, s: DdnSession, items: List<IndexReplica.Child>, budget: Int = 200): Int {
        val acct = s.acct.accountId
        val known = takenAll(c, acct)
        val db = DdnAi.Db(c)
        var reads = 0
        for (it in items) {
            if (reads >= budget) break
            val ref = it.manifestRef ?: continue
            if (ref in known) continue
            reads++
            runCatching { s.files.manifest(ref).second.takenAt ?: 0L }.onSuccess { at -> db.putTaken(acct, ref, at) }
        }
        return reads
    }
}
