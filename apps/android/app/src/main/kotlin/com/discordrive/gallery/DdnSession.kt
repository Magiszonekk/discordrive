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
    val files: FileReader = FileReader(discord, { id -> webhookUrl(id) })
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
            if (headSeq == 0L && !localCopy.exists()) sync.join() else {
                sync.loadVault()
                sync.pull()
            }
            DdnAccount.setVaultRevision(app, sync.vaultRevision)
            headSeq = replica.headSeq
            saveCopy()
            lastError = null
        } catch (e: Exception) {
            lastError = e.message
            Log.w(TAG, "refresh: ${e.message}")
            // Offline: the vault is still needed to read files (last one seen).
            if (e is JsEngineException) throw e
            if (Vault.webhooks(sync.vault).isEmpty()) runCatching { sync.loadVault() }
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
    fun uploader(parallel: Int = 3): FileWriter = FileWriter(writer, sync.api, { sync.writableWebhooks() }, { op ->
        ix { _ -> sync.commit(op).also { headSeq = replica.headSeq; DdnAccount.setVaultRevision(app, sync.vaultRevision); saveCopy() } }
    }, parallel = parallel)

    /** The folder at `path` under the root (made where missing). Returns its ID. */
    fun folderPath(path: List<String>): String = ix { _ -> path.fold("root") { parent, name -> sync.folder(name, parent) } }

    fun children(folderId: String): List<IndexReplica.Child> = ix { it.children(folderId) }
    fun media(limit: Int, after: Pair<Long, String>?): List<IndexReplica.Child> = ix { it.media(MEDIA_EXT, limit, after) }
    fun node(id: String): IndexReplica.Child? = ix { it.node(id) }

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
            current?.close()
            current = null
            File(context.filesDir, "ddn-index.json").delete()
            File(context.cacheDir, "ddn-thumbs").deleteRecursively()
        }

        /** The thumbnail kind of a file for the lists ('t'), or the preview ('p'). */
        fun previewName(manifestRef: String, kind: Char) = FileFormat.PreviewKeys(FileFormat.decodeManifestRef(manifestRef).fileKey).name(kind)
    }
}
