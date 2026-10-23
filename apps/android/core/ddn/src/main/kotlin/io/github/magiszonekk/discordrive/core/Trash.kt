package io.github.magiszonekk.discordrive.core

/**
 * Who empties the trash after 30 days (rule Q4, as the web and desktop clients): the main device; when no
 * device purged for 7 days, any device. Always only a fully synced device, never on a metered link, only nodes
 * more than 30 days in the trash (server time). A phone is never the main device, so it cleans only when the
 * others did not for a week. "Empty the trash" / "Delete for good" by the user is not this: it is the user's
 * own choice on this device (a purge op of the chosen nodes).
 */
object TrashPolicy {
    const val DAY_MS = 24L * 60 * 60 * 1000
    const val RETENTION_MS = 30 * DAY_MS
    const val ANY_DEVICE_AFTER_MS = 7 * DAY_MS

    sealed class Decision {
        data class Clean(val nodeIds: List<String>) : Decision()
        data class Skip(val reason: String) : Decision()
    }

    /**
     * `lastPurgeAt`: the newest purge in the log or the instance's last cleanup run (server time, null = never);
     * `logStartedAt`: the first log entry (a fresh account starts the 7-day clock there).
     */
    fun decide(
        expired: List<String>,
        now: Long,
        isPrimary: Boolean,
        fullySynced: Boolean,
        metered: Boolean,
        lastPurgeAt: Long?,
        logStartedAt: Long?,
    ): Decision {
        if (!fullySynced) return Decision.Skip("not_synced")
        if (metered) return Decision.Skip("metered")
        if (!isPrimary) {
            val since = lastPurgeAt ?: logStartedAt
            if (since == null || now - since < ANY_DEVICE_AFTER_MS) return Decision.Skip("primary_cleans")
        }
        return if (expired.isEmpty()) Decision.Skip("nothing_expired") else Decision.Clean(expired)
    }

    /** Days left before an item trashed at `trashedAt` is deleted for good (0 = due). */
    fun daysLeft(trashedAt: Long, now: Long): Int = maxOf(0, ((trashedAt + RETENTION_MS - now + DAY_MS - 1) / DAY_MS).toInt())
}
