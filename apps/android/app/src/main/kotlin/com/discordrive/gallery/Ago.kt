package com.discordrive.gallery

import android.content.Context

/**
 * "przed chwilą", "5 min temu", "3 godz. temu", "wczoraj", "4 dni temu", then the date — in the app's language
 * (Polish), not the system's: the system's relative time (DateUtils) follows the phone's language and mixed
 * English into a Polish screen.
 */
object Ago {
    fun of(context: Context, at: Long, now: Long = System.currentTimeMillis()): String {
        val d = (now - at).coerceAtLeast(0)
        val min = d / 60_000
        val h = d / 3_600_000
        val days = d / 86_400_000
        val r = context.resources
        return when {
            min < 1 -> r.getString(R.string.ago_now)
            min < 60 -> r.getString(R.string.ago_min, min)
            h < 24 -> r.getString(R.string.ago_hours, h)
            days == 1L -> r.getString(R.string.ago_yesterday)
            days < 7 -> context.plq(R.plurals.ago_days, days.toInt(), days.toInt())
            else -> java.text.DateFormat.getDateInstance(java.text.DateFormat.MEDIUM, java.util.Locale("pl", "PL")).format(java.util.Date(at))
        }
    }
}
