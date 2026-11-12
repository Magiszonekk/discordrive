package com.discordrive.gallery

import android.content.Context
import io.github.magiszonekk.discordrive.core.GalleryBackup
import io.github.magiszonekk.discordrive.core.IndexReplica

/**
 * The Gallery's tiles with the state of each copy: the account's photos and the phone's own (the folders
 * of the automatic copy, the camera's with the copy off), paired by [GalleryBackup.merge]. Reads MediaStore
 * and the upload's tables: not on the main thread.
 */
object DdnGalleryState {
    /** `bar` null: the phone's photos are not readable (no access given), so nothing is known about copies. */
    data class View(val entries: List<GalleryBackup.Entry>, val bar: GalleryBackup.Bar?)

    /** No badges (the default state): what the Gallery shows when the phone's photos cannot be read. */
    fun plain(account: List<IndexReplica.Child>) = View(account.map { GalleryBackup.Entry(it, GalleryBackup.Badge.BOTH) }, null)

    /** The last tiles shown (ID → entry): the viewer's Info line reads it. */
    @Volatile var last: Map<String, GalleryBackup.Entry> = emptyMap()

    /** Above this many copies to look up one by one, the whole list of files is read once instead. */
    private const val ONE_BY_ONE = 200

    fun build(c: Context, s: DdnSession, account: List<IndexReplica.Child>, sending: String?): View {
        val acct = s.acct.accountId
        val db = DdnBackup.db(c)
        val autoOn = DdnBackup.enabled(c)
        // Without access to the phone's photos nothing can be said about copies: no badges rather than wrong ones.
        if (!MediaLocation.hasMediaAccess(c)) { last = emptyMap(); return plain(account) }
        val locals = DdnBackup.scan(c, DdnBackup.galleryBuckets(c))
        val copied = db.copiedRows(acct).mapValues { (_, r) -> GalleryBackup.Copied(r.size, r.modified, r.node) }
        val listed = account.mapTo(HashSet()) { it.id }
        val unlisted = locals.mapNotNull { copied[it.id]?.node }.filter { it !in listed }
        val live: (String) -> Boolean = if (unlisted.size > ONE_BY_ONE) {
            val all = s.allFiles().mapTo(HashSet()) { it.id }
            ({ id -> id in all })
        } else ({ id -> s.node(id)?.let { it.trashedAt == null } == true })
        val queue = db.queued(acct).map { GalleryBackup.Queued(it.id, it.name, it.size, it.error) }
        val entries = GalleryBackup.merge(GalleryBackup.Input(
            account = account,
            locals = locals.map { GalleryBackup.Local(it.id, it.name, it.bucket, it.size, it.modified, it.taken, it.video) },
            copied = copied, live = live, queue = queue, failed = db.mediaErrors(acct),
            autoOn = autoOn, autoBuckets = DdnBackup.buckets(c), sending = sending,
        ))
        val series = BackupSeries.of(c)
        val bar = GalleryBackup.bar(entries, autoOn, series.open, series.done, series.total, waitNow(c))
        last = entries.associateBy { it.item.id }
        return View(entries, bar)
    }

    /** Why waiting photos wait now (the settings' conditions against the phone's network and charger). */
    fun waitNow(c: Context): GalleryBackup.Wait {
        val cm = c.getSystemService(android.net.ConnectivityManager::class.java)
        val unmetered = runCatching { cm.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true }.getOrDefault(false)
        val charging = runCatching { c.getSystemService(android.os.BatteryManager::class.java).isCharging }.getOrDefault(false)
        return GalleryBackup.waitOf(DdnBackup.wifiOnly(c), unmetered, DdnBackup.chargingOnly(c), charging)
    }

    /** The bar over the grid in words. */
    fun barText(c: Context, b: GalleryBackup.Bar): String {
        val nf = java.text.NumberFormat.getIntegerInstance(java.util.Locale.forLanguageTag("pl-PL"))
        fun n(v: Int) = nf.format(v.toLong()).replace('\u00a0', ' ')
        fun waits(left: Int, w: GalleryBackup.Wait) = c.plq(when (w) {
            GalleryBackup.Wait.WIFI -> R.plurals.ddn_gb_wait_wifi
            GalleryBackup.Wait.CHARGING -> R.plurals.ddn_gb_wait_charging
            GalleryBackup.Wait.QUEUE -> R.plurals.ddn_gb_wait_queue
        }, left, n(left))
        fun failed(f: Int) = if (f > 0) " · " + c.plq(R.plurals.ddn_gb_failed, f, f) else ""
        return when (b) {
            is GalleryBackup.Bar.Off -> if (b.localOnly > 0) c.plq(R.plurals.ddn_gb_off, b.localOnly, n(b.localOnly)) else c.getString(R.string.ddn_gb_off_none)
            is GalleryBackup.Bar.AllCopied -> c.getString(R.string.ddn_gb_all) + failed(b.failed)
            is GalleryBackup.Bar.Progress -> c.getString(R.string.ddn_gb_progress, n(b.done), n(b.total)) + " · " + waits(b.left, b.wait) + failed(b.failed)
            is GalleryBackup.Bar.Waiting -> waits(b.left, b.wait) + failed(b.failed)
        }
    }

    /** The viewer's Info line about the copy (null: nothing known about this file). */
    fun infoLine(c: Context, id: String): String? {
        val e = last[id] ?: return null
        val fmt = java.text.SimpleDateFormat("d.MM HH:mm", java.util.Locale.forLanguageTag("pl-PL"))
        return when (e.badge) {
            GalleryBackup.Badge.BOTH, GalleryBackup.Badge.ACCOUNT_ONLY -> {
                val at = e.item.createdAt.takeIf { it > 0 }?.let { fmt.format(java.util.Date(it)) }
                val yes = if (at != null) c.getString(R.string.ddn_gb_info_yes_at, at) else c.getString(R.string.ddn_gb_info_yes)
                if (e.badge == GalleryBackup.Badge.ACCOUNT_ONLY) c.getString(R.string.ddn_gb_info_account_only) else yes
            }
            GalleryBackup.Badge.QUEUED, GalleryBackup.Badge.SENDING -> c.getString(R.string.ddn_gb_info_waiting, waitWords(c, waitNow(c)))
            GalleryBackup.Badge.FAILED -> c.getString(R.string.ddn_gb_info_failed, e.error?.let { DdnBackup.reason(c, it) } ?: "")
            GalleryBackup.Badge.LOCAL_ONLY -> c.getString(R.string.ddn_gb_info_no)
        }
    }

    private fun waitWords(c: Context, w: GalleryBackup.Wait) = c.getString(when (w) {
        GalleryBackup.Wait.WIFI -> R.string.ddn_gb_why_wifi
        GalleryBackup.Wait.CHARGING -> R.string.ddn_gb_why_charging
        GalleryBackup.Wait.QUEUE -> R.string.ddn_gb_why_queue
    })

    /** The badge's icon and whether its circle is the error's colour (null: no badge). */
    fun icon(b: GalleryBackup.Badge): Int? = when (b) {
        GalleryBackup.Badge.LOCAL_ONLY -> R.drawable.ic_cobalt_cloud_off
        GalleryBackup.Badge.QUEUED, GalleryBackup.Badge.SENDING -> R.drawable.ic_cobalt_cloud_upload
        GalleryBackup.Badge.FAILED -> R.drawable.ic_cobalt_cloud_alert
        GalleryBackup.Badge.ACCOUNT_ONLY -> R.drawable.ic_cobalt_cloud
        GalleryBackup.Badge.BOTH -> null
    }

    /** The badge in words (TalkBack, the legend). */
    fun words(c: Context, b: GalleryBackup.Badge): String = c.getString(when (b) {
        GalleryBackup.Badge.LOCAL_ONLY -> R.string.ddn_gb_badge_local
        GalleryBackup.Badge.QUEUED -> R.string.ddn_gb_badge_queued
        GalleryBackup.Badge.SENDING -> R.string.ddn_gb_badge_sending
        GalleryBackup.Badge.FAILED -> R.string.ddn_gb_badge_failed
        GalleryBackup.Badge.ACCOUNT_ONLY -> R.string.ddn_gb_badge_account
        GalleryBackup.Badge.BOTH -> R.string.ddn_gb_badge_both
    })

    // ── the one-time legend ──
    private fun prefs(c: Context) = c.getSharedPreferences("ddn-gallery", Context.MODE_PRIVATE)
    fun legendSeen(c: Context) = prefs(c).getBoolean("legend_seen", false)
    fun setLegendSeen(c: Context) = prefs(c).edit().putBoolean("legend_seen", true).apply()
}
