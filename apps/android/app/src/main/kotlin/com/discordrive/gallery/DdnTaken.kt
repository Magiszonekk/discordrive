package com.discordrive.gallery

import android.content.Context
import android.database.Cursor
import com.discordrive.gallery.DdnAi
import com.discordrive.gallery.DdnSession
import io.github.magiszonekk.discordrive.core.IndexReplica

/**
 * Local cache of when each version's content was made (manifest takenAt), keyed by manifestRef.
 * - Uploads from this phone write it at once (the uploader already knows takenAt).
 * - For files from other devices a background pass reads their manifests and fills the cache.
 * - The viewer's "added" date is still createdAt; only grouping and sorting use takenAt.
 */
object DdnTaken {

    private fun db(c: Context): DdnAi.Db = DdnAi.Db(c)

    /** All known entries (including 0 = unknown). */
    fun takenAll(c: Context, account: String): Map<String, Long> {
        val out = mutableMapOf<String, Long>()
        db(c).readableDatabase.rawQuery("SELECT ref, at FROM taken WHERE account=?", arrayOf(account)).use { cur: Cursor ->
            while (cur.moveToNext()) out[cur.getString(0)] = cur.getLong(1)
        }
        return out
    }

    /** The known date for a ref (0 = not stored / not known). */
    fun dateOf(c: Context, account: String, ref: String): Long =
        db(c).readableDatabase.rawQuery("SELECT at FROM taken WHERE account=? AND ref=?", arrayOf(account, ref)).use { cur: Cursor ->
            if (cur.moveToFirst()) cur.getLong(0) else 0L
        }

    /** Write the taken date for a ref (account is the accountId). */
    fun put(c: Context, account: String, ref: String, at: Long) {
        if (at > 0) db(c).putTaken(account, ref, at)
    }

    /** Does this ref already have a known taken date? */
    fun has(c: Context, account: String, ref: String): Boolean =
        db(c).hasTaken(account, ref)

    /** Fill missing takenAt for items whose refs have no entry yet.
     *  Reads up to `budget` manifests in the background; on success records the date (0 if not in manifest).
     *  Returns how many new refs were read (including 0 results). */
    fun fillMissing(c: Context, s: DdnSession, items: List<IndexReplica.Child>, budget: Int = 200): Int {
        val acct = s.acct.accountId
        val known = takenAll(c, acct).toMutableMap()
        var reads = 0
        for (it in items) {
            if (reads >= budget) break
            val ref = it.manifestRef ?: continue
            if (known.containsKey(ref)) continue
            reads++
            runCatching { s.files.manifest(ref).second.takenAt ?: 0L }.onSuccess { at ->
                known[ref] = at
                put(c, acct, ref, at)
            }
        }
        return reads
    }
}