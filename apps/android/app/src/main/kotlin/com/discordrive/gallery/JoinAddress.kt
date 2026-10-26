package com.discordrive.gallery

import android.content.Context
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The instance address on the join screen. The address the APK was downloaded from cannot be known on a
 * sideloaded install (Android keeps no download source outside a store), so the field holds the address used
 * last (any join, the account left on this phone), else it is empty with its hint. No instance is built in.
 */
object JoinAddress {
    private const val PREFS = "ddn-join"
    private const val KEY = "server"

    fun last(context: Context): String = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "") ?: ""
    fun remember(context: Context, url: String) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, url).apply()

    /**
     * What was typed or pasted, as https://host[:port] — a pairing link (…/#pair=…), a page of the instance or
     * a bare host give their address; text that is not one address (spaces, two values run together) gives null.
     */
    fun normalize(text: String): String? {
        val t = text.trim()
        if (t.isEmpty() || t.any { it.isWhitespace() }) return null
        val withScheme = if (t.startsWith("http://") || t.startsWith("https://")) t else "https://$t"
        val u = withScheme.toHttpUrlOrNull() ?: return null
        if (!u.host.contains('.') && u.host != "localhost") return null
        val port = if ((u.scheme == "https" && u.port == 443) || (u.scheme == "http" && u.port == 80)) "" else ":${u.port}"
        return "${u.scheme}://${u.host}$port"
    }
}
