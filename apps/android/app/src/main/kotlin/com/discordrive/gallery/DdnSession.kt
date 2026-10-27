package com.discordrive.gallery

import android.content.Context
import android.util.Log
import io.github.magiszonekk.discordrive.core.AccountState
import io.github.magiszonekk.discordrive.core.AccountSync
import io.github.magiszonekk.discordrive.core.Discord
import io.github.magiszonekk.discordrive.core.DiscordWriter
import io.github.magiszonekk.discordrive.core.FileWriter
import io.github.magiszonekk.discordrive.core.FileFormat
import io.github.magiszonekk.discordrive.core.FileReader
import io.github.magiszonekk.discordrive.core.IndexReplica
import io.github.magiszonekk.discordrive.core.InstanceApi
import io.github.magiszonekk.discordrive.core.JsEngineException
import io.github.magiszonekk.discordrive.core.TrashPolicy
import io.github.magiszonekk.discordrive.core.Vault
import io.github.magiszonekk.discordrive.syncjs.JsEngines
import io.github.magiszonekk.discordrive.syncjs.JsIndexReplica
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * The open discordrive account of this phone: the sync core's index in the JS engine (one thread owns it:
 * a QuickJS context is bound to its thread, V8 calls are serialized), the instance API, Discord reads.
 *
 * Start: the local copy of the index (files/ddn-index.json, written after each sync) is loaded first, so
 * the lists show at once without the network; then the log tail is pulled. No local copy: a join from the
 * snapshot on Discord. Every call that touches the index goes through [ix] (its thread).
 */
class DdnSession private constructor(private val app: Context, val acct: AccountState) {
    private val thread = Executors.newSingleThreadExecutor { r -> Thread(r, "ddn-index") }
    private lateinit var replica: IndexReplica
    lateinit var sync: AccountSync
        private set
    val discord = Discord(apiOrigin = testDiscordOrigin)
    /** Reads files: the vault's webhooks (metadata only) or through the instance (e2ee / plain). */
    val files: FileReader by lazy {
        if (acct.serverBlobs) FileReader(io.github.magiszonekk.discordrive.core.InstanceSource(InstanceApi(acct.serverUrl, acct.accountId, acct.deviceId, acct.device, acct.instanceId), discord))
        else FileReader(discord, { id -> webhookUrl(id) })
    }
    /** Posts to the account's channels, paced per channel (30/min, as every client). */
    val writer = DiscordWriter(apiOrigin = testDiscordOrigin)
    @Volatile var engineName: String = "?"
        private set
    @Volatile var headSeq: Long = 0
        private set
    @Volatile var lastError: String? = null

    private val localCopy = File(app.filesDir, "ddn-index.json")

    private fun webhookUrl(id: String): String =
        Vault.webhooks(sync.vault).firstOrNull { it.id == id }?.url ?: throw IllegalStateException("channel $id is not in this account's vault")

    /**
     * Run on the index thread (and wait). The V8 sandbox can die under the app (the system freezes or kills
     * it while the app is in the background: "sandbox dead", "cannot set freezer state"); then the session
     * moves to QuickJS for good (the index is rebuilt from the local copy, no network) and runs `f` again.
     */
    fun <T> ix(f: (IndexReplica) -> T): T = thread.submit(Callable {
        try {
            f(replica)
        } catch (e: JsEngineException) {
            if (engineName == "quickjs") throw e
            Log.w(TAG, "$engineName failed (${e.message}); continuing on QuickJS")
            runCatching { replica.close() }
            start(quickJsOnly = true)
            // The new sync starts with an empty vault: files are read through its webhooks.
            runCatching { sync.loadVault() }
            f(replica)
        }
    }).get()

    private fun <T> later(f: () -> T): Future<T> = thread.submit(Callable(f))

    private fun open() = later { start(quickJsOnly = false) }.get()

    /** (Re)build the index in an engine: the local copy if there is one. On the index thread. */
    private fun start(quickJsOnly: Boolean): Boolean {
        val core = JsEngines.openSyncCore(app, quickJsOnly)
        engineName = core.engine.name
        replica = JsIndexReplica(core.engine)
        val api = InstanceApi(acct.serverUrl, acct.accountId, acct.deviceId, acct.device, acct.instanceId)
        sync = AccountSync(acct, api, discord, replica, DdnAccount.vaultRevision(app))
        val loaded = runCatching {
            if (localCopy.exists()) {
                localCopy.bufferedReader().use { r -> replica.loadSnapshotText(generateSequence { val b = CharArray(256 * 1024); val n = r.read(b); if (n < 0) null else String(b, 0, n) }) }
                true
            } else false
        }.getOrElse { Log.w(TAG, "local copy unreadable, joining again: ${it.message}"); false }
        headSeq = replica.headSeq
        return loaded
    }

    /** Vault + log tail (or a join from the snapshot when there is no local copy); saves the local copy. */
    fun refresh(): Long = ix { _ ->
        try {
            if (headSeq == 0L && !localCopy.exists()) sync.join().also { j -> j.snapshotSkipped?.let { AppLog.w("DdnSession", "snapshot skipped, index from the whole log: $it") } } else {
                sync.loadVault()
                sync.pull()
            }
            DdnAccount.setVaultRevision(app, sync.vaultRevision)
            headSeq = replica.headSeq
            saveCopy()
            lastError = null
            // Whether the account has the Gallery space: asked here (off the main thread), read by the menus.
            sync.galleryAvailable()
        } catch (e: Exception) {
            lastError = e.message
            Log.w(TAG, "refresh: ${e.message}")
            // Offline: the vault is still needed to read files (last one seen).
            if (e is JsEngineException) throw e
            if (!acct.serverBlobs && Vault.webhooks(sync.vault).isEmpty()) runCatching { sync.loadVault() }
        }
        headSeq
    }

    private fun saveCopy() {
        val tmp = File(localCopy.path + ".tmp")
        tmp.bufferedWriter().use { w -> for (s in replica.snapshotText()) w.write(s) }
        tmp.renameTo(localCopy)
    }

    /**
     * The uploader of this session: fragments go out on upload threads; the operations (upload_begin,
     * upload_commit + create) run on the index thread, and the local copy is saved after each file.
     */
    fun uploader(parallel: Int = 3): FileWriter = FileWriter(writer, sync.api, { sync.writableWebhooks() }, viaInstance = acct.serverBlobs, commit = { op ->
        ix { _ -> sync.commit(op).also { headSeq = replica.headSeq; DdnAccount.setVaultRevision(app, sync.vaultRevision); saveCopy() } }
    }, parallel = parallel)

    /**
     * The Safe's tree through this session's JS engine (DdnSafe / core SafeTree): every call on the index thread,
     * so it follows the engine when the session moves to QuickJS. The account's index is not touched.
     */
    val safeReplica: IndexReplica = object : IndexReplica {
        override val rulesVersion: Int get() = ix { it.rulesVersion }
        override val headSeq: Long get() = 0
        override fun reset() {}
        override fun loadSnapshotText(slices: Sequence<String>): Long = throw UnsupportedOperationException()
        override fun apply(entries: List<kotlinx.serialization.json.JsonObject>): IndexReplica.ApplySummary = throw UnsupportedOperationException()
        override fun leaseGuard(op: kotlinx.serialization.json.JsonObject): List<String> = ix { it.leaseGuard(op) }
        override fun stateSha256(): String = throw UnsupportedOperationException()
        override fun children(parentId: String): List<IndexReplica.Child> = throw UnsupportedOperationException()
        override fun safeEmpty(): String = ix { it.safeEmpty() }
        override fun safeApply(tree: String, entry: kotlinx.serialization.json.JsonObject): String = ix { it.safeApply(tree, entry) }
        override fun safeChildren(tree: String, parentId: String): List<IndexReplica.Child> = ix { it.safeChildren(tree, parentId) }
        override fun close() {}
    }

    /** The folder at `path` under the root (made where missing). Returns its ID. */
    fun folderPath(path: List<String>): String = ix { _ -> path.fold("root") { parent, name -> sync.folder(name, parent) } }

    fun children(folderId: String): List<IndexReplica.Child> = ix { it.children(folderId) }
    /** The Gallery: media outside the trash, without those inside private folders of this phone (`locked`). */
    fun media(limit: Int, after: Pair<Long, String>?, locked: Set<String> = emptySet()): List<IndexReplica.Child> = ix { r ->
        // With the Gallery space (rules 4): the Gallery shows only its own photos (the Drive's stay in Files).
        val all = r.media(MEDIA_EXT, if (locked.isEmpty()) limit else limit * 2, after, if (gallerySpace) "gallery" else null)
        if (locked.isEmpty()) all else {
            val parents = HashMap<String, String?>()
            val up = { id: String -> parents.getOrPut(id) { r.node(id)?.parentId } }
            all.filter { !DdnPrivate.hidden(locked, it.parentId, up) }.take(limit)
        }
    }

    /** Every file of the account (not in the trash), newest first; files inside `locked` folders left out. */
    fun allFiles(locked: Set<String> = emptySet()): List<IndexReplica.Child> = ix { r ->
        // An empty suffix matches every name (the replica's media list without the type filter).
        val all = r.media(listOf(""), 1_000_000, null)
        if (locked.isEmpty()) all else {
            val parents = HashMap<String, String?>()
            val up = { id: String -> parents.getOrPut(id) { r.node(id)?.parentId } }
            all.filter { !DdnPrivate.hidden(locked, it.parentId, up) }
        }
    }

    /** Albums (folders with photos or videos), newest first. */
    fun albums(): List<IndexReplica.Album> = ix { it.albums(MEDIA_EXT, if (gallerySpace) "gallery" else null) }

    /**
     * The account has the Gallery space (the instance replays rules 4): the Gallery tab shows only it, uploads
     * from the Gallery, Share of photos and the automatic copy go there. Older instance: everything as before.
     */
    val gallerySpace: Boolean get() = sync.galleryAvailable()

    /**
     * The same for the UI thread: only what is known already (no network call there; [refresh] asks the
     * instance). False until then, so a menu never offers a Gallery action an older instance would refuse.
     */
    val gallerySpaceKnown: Boolean get() = sync.galleryKnown == true

    /** An album (a folder right in the Gallery) named `name`, made where missing. */
    fun galleryAlbum(name: String): String = ix { _ -> sync.folder(name, io.github.magiszonekk.discordrive.core.GALLERY_ID) }

    /** Where photos go without an album: the Gallery's root (made by the first rules-4 entry). */
    val galleryRoot: String get() = io.github.magiszonekk.discordrive.core.GALLERY_ID

    /** The media files right inside a folder, newest first. */
    fun albumMedia(folderId: String): List<IndexReplica.Child> = ix { r ->
        r.children(folderId).filter { !it.isFolder && (isImage(it.name) || isVideo(it.name)) }.sortedByDescending { it.createdAt }
    }
    fun node(id: String): IndexReplica.Child? = ix { it.node(id) }

    /**
     * Store a small extra object next to a stored version (an AI description): metadata only edits the
     * manifest's message on the account's webhook, e2ee / plain give it to the instance. False = it was there.
     */
    fun addExtra(c: IndexReplica.Child, name: String, data: ByteArray): Boolean {
        val w = io.github.magiszonekk.discordrive.core.ExtraWriter(apiOrigin = testDiscordOrigin)
        if (acct.serverBlobs) return w.addThroughInstance(sync.api, c.uploadId ?: throw IllegalStateException("no upload of ${c.id}"), name, data)
        val loc = FileFormat.decodeManifestRef(c.manifestRef!!)
        return w.addToMessage(discord, webhookUrl(loc.webhookId), loc.messageId, name, data)
    }

    // ── the trash ──
    fun trash(): List<IndexReplica.Child> = ix { it.trash() }

    /** Operations on nodes (the result's outcome: "applied", "skipped", ...); the local copy is saved after. */
    private fun op(f: () -> kotlinx.serialization.json.JsonObject): String = ix { _ ->
        val r = f()
        headSeq = replica.headSeq
        saveCopy()
        (r["outcome"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: "?"
    }
    fun moveToTrash(ids: List<String>): String = op { sync.trash(ids) }
    /** Move into a folder; into [galleryRoot] / an album = "Move to the Gallery", into a Drive folder = "Move to the Drive". */
    fun move(ids: List<String>, parentId: String): String = op { sync.move(ids, parentId) }
    fun restore(ids: List<String>): String = op { sync.restore(ids) }
    fun purge(ids: List<String>): String = op { sync.purge(ids) }

    /**
     * The 30-day trash cleanup (rule Q4) from the background job: this phone is never the main device, so it
     * purges only when no device did for 7 days, only fully synced (just pulled) and never on a metered link.
     * Returns the decision (for the log and the tests).
     */
    fun autoCleanTrash(metered: Boolean): TrashPolicy.Decision = ix { _ ->
        sync.pull()
        val gc = sync.api.gcStatus()
        val last = listOfNotNull(sync.lastPurgeAt, gc.lastRunAt).maxOrNull()
        val d = TrashPolicy.decide(replica.expiredTrash(gc.now), gc.now, isPrimary = false, fullySynced = true, metered = metered, lastPurgeAt = last, logStartedAt = sync.logStartedAt ?: gc.firstEntryAt)
        // e2ee / plain: tell the instance which uploads the index released (it deletes them 30 days later).
        if (acct.serverBlobs) runCatching {
            val from = DdnAccount.releasedUpTo(app)
            val list = replica.released(from)
            if (list.isNotEmpty()) { sync.reportReleased(list.map { it.first to it.second }); DdnAccount.setReleasedUpTo(app, list.last().third) }
        }
        if (d is TrashPolicy.Decision.Clean) {
            sync.purge(d.nodeIds)
            runCatching { sync.api.gcRecordRun() }
            headSeq = replica.headSeq
            saveCopy()
        }
        d
    }

    fun close() {
        runCatching { later { replica.close() }.get() }
        thread.shutdown()
    }

    companion object {
        private const val TAG = "ddn"
        val IMAGE_EXT = listOf(".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".bmp", ".avif")
        val VIDEO_EXT = listOf(".mp4", ".m4v", ".mov", ".webm", ".mkv", ".3gp")
        val MEDIA_EXT = IMAGE_EXT + VIDEO_EXT

        fun isImage(name: String) = IMAGE_EXT.any { name.lowercase().endsWith(it) }
        fun isVideo(name: String) = VIDEO_EXT.any { name.lowercase().endsWith(it) }

        @Volatile private var current: DdnSession? = null

        /** Tests only (instrumentation against a local fake Discord): where https://discord.com goes. Never set in the app. */
        @Volatile var testDiscordOrigin: String? = null

        /** The open session (opened on first use; null when this phone has no discordrive account). Off the main thread. */
        @Synchronized
        fun get(context: Context): DdnSession? {
            val acct = DdnAccount.load(context) ?: return null
            current?.let { if (it.acct.accountId == acct.accountId && it.acct.deviceId == acct.deviceId) return it; it.close() }
            return DdnSession(context.applicationContext, acct).also { it.open(); current = it }
        }

        @Synchronized
        fun forget(context: Context) {
            DdnSafe.forget(context)
            current?.close()
            current = null
            File(context.filesDir, "ddn-index.json").delete()
            File(context.cacheDir, "ddn-thumbs").deleteRecursively()
        }

        /** The thumbnail kind of a file for the lists ('t'), or the preview ('p'). */
        fun previewName(manifestRef: String, kind: Char) = FileFormat.PreviewKeys(FileFormat.decodeManifestRef(manifestRef).fileKey).name(kind)
    }
}
