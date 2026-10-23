package com.discordrive.gallery

import android.content.Context

/**
 * Private albums of the discordrive account on this phone: folders the user locked here. Their photos and
 * videos are left out of the Gallery and its search; their album tile shows a lock and no cover; opening one
 * asks for the PIN (or biometrics) every time. The PIN is the app's own (the same as the phone gallery's
 * private folders, PrivateAlbums). A phone-side setting: the account and other devices are not changed (the
 * files stay where they are, encrypted as all files).
 */
object DdnPrivate {
    private fun prefs(c: Context) = c.getSharedPreferences("ddn-private", Context.MODE_PRIVATE)

    /** Locked folder IDs of this account. */
    fun all(c: Context): Set<String> {
        val acct = DdnAccount.load(c)?.accountId ?: return emptySet()
        return prefs(c).getStringSet(acct, emptySet()) ?: emptySet()
    }

    fun isPrivate(c: Context, folderId: String) = folderId in all(c)

    fun set(c: Context, folderId: String, private: Boolean) {
        val acct = DdnAccount.load(c)?.accountId ?: return
        val cur = all(c).toMutableSet()
        if (private) cur += folderId else cur -= folderId
        prefs(c).edit().putStringSet(acct, cur).apply()
    }

    /** A node is hidden when it is inside a locked folder (any depth; `parentOf` walks up). */
    fun hidden(locked: Set<String>, startParent: String?, parentOf: (String) -> String?): Boolean {
        if (locked.isEmpty()) return false
        var p = startParent
        var guard = 0
        while (p != null && guard++ < 256) {
            if (p in locked) return true
            p = parentOf(p)
        }
        return false
    }
}
