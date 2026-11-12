package io.github.magiszonekk.discordrive.core

/**
 * The Gallery as one timeline of the account's photos and the phone's own, each with the state of its copy
 * (pure logic, no Android: tested on the JVM).
 *
 * A photo of the phone and its copy in the account are one tile. They are paired by the automatic copy's
 * record (MediaStore ID, size and date → the node it made), else by the same name and size (a reinstall,
 * a photo sent by Share, a copy made by another app of this account). A photo whose copy still exists but
 * is not in the list (a private album, moved to the Drive) is left out: the Gallery never shows it through
 * the back door.
 */
object GalleryBackup {
    enum class Badge {
        /** On the phone, no copy and none planned (the automatic copy is off or skips its folder). */
        LOCAL_ONLY,
        /** Waiting for the upload (the automatic copy's folder, "Copy now", a shared file in the queue). */
        QUEUED,
        /** Being sent now. */
        SENDING,
        /** The last try failed for good (not a network failure): the cause and Retry. */
        FAILED,
        /** In the account, not on this phone (another device, or removed here by "Free up space"). */
        ACCOUNT_ONLY,
        /** On the phone and in the account: the quiet default, no badge. */
        BOTH,
    }

    /** A photo or video of the phone. `taken`: ms (date taken, else modified). */
    data class Local(val mediaId: Long, val name: String, val bucket: String, val size: Long, val modified: Long, val taken: Long, val video: Boolean)
    /** The automatic copy's record of a media: what was copied, into which node. */
    data class Copied(val size: Long, val modified: Long, val node: String)
    /** A file of the upload queue (shared to the app): `error` set = failed for good. */
    data class Queued(val id: Long, val name: String, val size: Long, val error: String?)

    /**
     * One tile. `item` is the account's node, or for a photo only on the phone a stand-in node whose ID is
     * [localId] (no manifest). `error`: why the copy failed; `queueId`: its queue entry (Retry).
     */
    data class Entry(val item: IndexReplica.Child, val badge: Badge, val local: Local? = null, val error: String? = null, val queueId: Long? = null) {
        val onPhone: Boolean get() = local != null
        val inAccount: Boolean get() = item.manifestRef != null || !isLocal(item.id)
    }

    const val LOCAL_PREFIX = "local:"
    fun localId(mediaId: Long) = "$LOCAL_PREFIX$mediaId"
    fun isLocal(id: String) = id.startsWith(LOCAL_PREFIX)
    fun mediaIdOf(id: String): Long? = if (isLocal(id)) id.removePrefix(LOCAL_PREFIX).toLongOrNull() else null

    data class Input(
        /** The Gallery's media of the account as listed (private folders already left out). */
        val account: List<IndexReplica.Child>,
        /** The phone's media in the folders the Gallery shows. */
        val locals: List<Local>,
        val copied: Map<Long, Copied> = emptyMap(),
        /** The node exists outside the trash (listed or not). */
        val live: (String) -> Boolean = { false },
        val queue: List<Queued> = emptyList(),
        /** Media of the automatic copy whose last try failed (not a network failure): the cause. */
        val failed: Map<Long, String> = emptyMap(),
        val autoOn: Boolean = false,
        val autoBuckets: Set<String> = emptySet(),
        /** The file being sent now (the upload job's progress): its name, if any. */
        val sending: String? = null,
    )

    fun merge(inp: Input): List<Entry> {
        val byId = inp.account.associateBy { it.id }
        val claimed = HashSet<String>()
        val out = ArrayList<Entry>(inp.account.size + inp.locals.size)
        // Name + size → the account's items not paired by a record (one each, in list order).
        val twins = HashMap<Pair<String, Long>, ArrayDeque<IndexReplica.Child>>()
        val recorded = inp.locals.mapNotNullTo(HashSet()) { l -> inp.copied[l.mediaId]?.takeIf { it.size == l.size && it.modified == l.modified }?.node }
        for (c in inp.account) if (c.id !in recorded && c.size != null) twins.getOrPut(c.name to c.size!!) { ArrayDeque() }.add(c)
        val queueByKey = inp.queue.groupBy { it.name to it.size }

        for (l in inp.locals) {
            val rec = inp.copied[l.mediaId]?.takeIf { it.size == l.size && it.modified == l.modified }
            if (rec != null) {
                val node = byId[rec.node]
                if (node != null && claimed.add(node.id)) { out += Entry(node, Badge.BOTH, l); continue }
                // Copied, the copy still there but not listed (a private album, moved to the Drive): not shown.
                if (node == null && inp.live(rec.node)) continue
            }
            val twin = twins[l.name to l.size]?.let { q -> while (q.isNotEmpty() && q.first().id in claimed) q.removeFirst(); q.removeFirstOrNull() }
            if (twin != null) { claimed += twin.id; out += Entry(twin, Badge.BOTH, l); continue }
            val stand = IndexReplica.Child(localId(l.mediaId), l.name, "file", l.size, createdAt = l.taken)
            // In the upload queue ("Copy now", Share): the same name and size.
            val q = queueByKey[l.name to l.size]?.firstOrNull()
            // A copy made before and trashed since: the automatic copy does not make it again by itself.
            val auto = inp.autoOn && l.bucket in inp.autoBuckets && rec == null
            val err = inp.failed[l.mediaId]
            out += when {
                q?.error != null -> Entry(stand, Badge.FAILED, l, error = q.error, queueId = q.id)
                q == null && auto && err != null -> Entry(stand, Badge.FAILED, l, error = err)
                (q != null || auto) && inp.sending == l.name -> Entry(stand, Badge.SENDING, l, queueId = q?.id)
                q != null || auto -> Entry(stand, Badge.QUEUED, l, queueId = q?.id)
                else -> Entry(stand, Badge.LOCAL_ONLY, l)
            }
        }
        for (c in inp.account) if (c.id !in claimed) out += Entry(c, Badge.ACCOUNT_ONLY)
        return out
    }

    /** What the filter of the Gallery keeps. */
    enum class Filter { ALL, PHONE_ONLY, ACCOUNT_ONLY }
    fun filter(entries: List<Entry>, f: Filter): List<Entry> = when (f) {
        Filter.ALL -> entries
        Filter.PHONE_ONLY -> entries.filter { it.badge in PHONE_ONLY }
        Filter.ACCOUNT_ONLY -> entries.filter { it.badge == Badge.ACCOUNT_ONLY }
    }
    /** Not in the account (yet): what "Only on the phone" lists. */
    val PHONE_ONLY = setOf(Badge.LOCAL_ONLY, Badge.QUEUED, Badge.SENDING, Badge.FAILED)

    /** Why the waiting photos wait. */
    enum class Wait { QUEUE, WIFI, CHARGING }

    /** The line over the grid. */
    sealed interface Bar {
        /** The automatic copy is off: `localOnly` photos are only on the phone (0: just \"off\"). */
        data class Off(val localOnly: Int) : Bar
        /** Nothing waits. `failed`: copies that failed for good. */
        data class AllCopied(val failed: Int) : Bar
        /** A series of runs is open: `done` of `total` (the notification's count), `left` wait for `wait`. */
        data class Progress(val done: Int, val total: Int, val left: Int, val wait: Wait, val failed: Int) : Bar
        /** Photos wait, no run counted yet. */
        data class Waiting(val left: Int, val wait: Wait, val failed: Int) : Bar
    }

    /**
     * The bar's state. The numbers come from the same lasting count as the upload notification
     * ([BackupSeries]: `seriesOpen`, `done`, `total`) while a series is open; the grid's own count otherwise.
     */
    fun bar(entries: List<Entry>, autoOn: Boolean, seriesOpen: Boolean, done: Int, total: Int, wait: Wait): Bar {
        val waiting = entries.count { it.badge == Badge.QUEUED || it.badge == Badge.SENDING }
        val failed = entries.count { it.badge == Badge.FAILED }
        val localOnly = entries.count { it.badge == Badge.LOCAL_ONLY }
        return when {
            waiting == 0 && !autoOn && failed == 0 -> Bar.Off(localOnly)
            waiting == 0 -> if (autoOn) Bar.AllCopied(failed) else Bar.Off(localOnly)
            seriesOpen && total > done -> Bar.Progress(done, total, total - done, wait, failed)
            else -> Bar.Waiting(waiting, wait, failed)
        }
    }

    /** Why a photo waits now: the settings' conditions that are not met (Wi-Fi first). */
    fun waitOf(wifiOnly: Boolean, unmetered: Boolean, chargingOnly: Boolean, charging: Boolean): Wait = when {
        wifiOnly && !unmetered -> Wait.WIFI
        chargingOnly && !charging -> Wait.CHARGING
        else -> Wait.QUEUE
    }
}
