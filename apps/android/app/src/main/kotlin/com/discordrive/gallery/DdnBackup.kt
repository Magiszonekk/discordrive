package com.discordrive.gallery

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.ServiceInfo
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.github.magiszonekk.discordrive.core.FileWriter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Background upload of the phone: the automatic copy of camera folders and the queue of files the user sent
 * (Share to discordrive, Upload in Files). One WorkManager job ([DdnUploadWorker]) runs both, as a foreground
 * job (dataSync) with a notification, in runs of at most [RUN_BUDGET_MS] (Android 15 limits dataSync to 6 h a
 * day; an upload resumes with the next file, the next run is queued at once).
 *
 * Triggers: a new photo or video in MediaStore (content URI trigger), every [PERIOD_H] hours, "Copy now",
 * a file added to the queue. Constraints from the settings: Wi-Fi only, while charging only.
 * Copies go to the Gallery when the account has it: the camera's photos without an album (the timeline), other
 * folders (Screenshots, WhatsApp Images…) into the album of that name (shared by phones with the same folder).
 * Older instance: "<root>/<camera folder>" of the account, root = "Telefon – <device name>". A file is copied
 * once (remembered by its MediaStore ID, size and date; and skipped when the folder already has the same
 * name with the same size, e.g. after a reinstall).
 */
object DdnBackup {
    private const val TAG = "ddn-backup"
    const val RUN_BUDGET_MS = 30 * 60_000L
    /** A run without the foreground service (Android refused it): a plain job is stopped after 10 minutes. */
    const val PLAIN_RUN_BUDGET_MS = 8 * 60_000L
    const val PERIOD_H = 6L
    private const val PREFS = "ddn-backup"
    private const val WORK_PERIODIC = "ddn-backup-periodic"
    private const val WORK_TRIGGER = "ddn-backup-trigger"
    const val WORK_NOW = "ddn-upload-now"
    /** Every unique job that runs [DdnUploadWorker] (the state on the automatic copy screen watches them all). */
    val WORKS = listOf(WORK_NOW, WORK_PERIODIC, WORK_TRIGGER)
    const val NOTIF_CHANNEL = "ddn-upload"
    const val NOTIF_ID = 4711
    const val NOTIF_FAILED = 4712
    const val NOTIF_CHANNEL_FAILED = "ddn-upload-failed"
    /** Folders offered by default: the camera's. */
    val DEFAULT_BUCKETS = setOf("Camera")
    /** Camera folders: their photos go to the Gallery without an album (the timeline). */
    val CAMERA_BUCKETS = setOf("Camera", "DCIM", "100MEDIA", "100ANDRO")

    // ── settings ──
    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun enabled(c: Context) = prefs(c).getBoolean("on", false)
    fun wifiOnly(c: Context) = prefs(c).getBoolean("wifi", true)
    fun chargingOnly(c: Context) = prefs(c).getBoolean("charging", false)
    fun buckets(c: Context): Set<String> = prefs(c).getStringSet("buckets", null) ?: DEFAULT_BUCKETS
    fun set(c: Context, on: Boolean? = null, wifi: Boolean? = null, charging: Boolean? = null, buckets: Set<String>? = null) {
        prefs(c).edit().apply {
            on?.let { putBoolean("on", it) }; wifi?.let { putBoolean("wifi", it) }; charging?.let { putBoolean("charging", it) }
            buckets?.let { putStringSet("buckets", it) }
        }.apply()
        schedule(c)
    }
    fun rootName(deviceName: String) = "Telefon – $deviceName"

    /** Last run: when, copied, waiting, error (shown in the settings). */
    data class Status(val at: Long, val copied: Int, val waiting: Int, val error: String?)
    fun status(c: Context): Status? = prefs(c).takeIf { it.contains("st_at") }?.let { Status(it.getLong("st_at", 0), it.getInt("st_copied", 0), it.getInt("st_waiting", 0), it.getString("st_err", null)) }
    internal fun setStatus(c: Context, s: Status) = prefs(c).edit().putLong("st_at", s.at).putInt("st_copied", s.copied).putInt("st_waiting", s.waiting).putString("st_err", s.error).apply()

    private fun constraints(c: Context) = Constraints.Builder()
        .setRequiredNetworkType(if (wifiOnly(c)) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .setRequiresCharging(chargingOnly(c))
        .build()

    /** (Re)schedules the periodic run and the trigger on new media according to the settings. */
    fun schedule(c: Context) {
        val wm = WorkManager.getInstance(c)
        if (!enabled(c)) {
            wm.cancelUniqueWork(WORK_PERIODIC)
            wm.cancelUniqueWork(WORK_TRIGGER)
            return
        }
        wm.enqueueUniquePeriodicWork(
            WORK_PERIODIC, ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<DdnUploadWorker>(PERIOD_H, TimeUnit.HOURS).setConstraints(constraints(c)).build(),
        )
        armTrigger(c)
    }

    /** A one-time job that waits for a change in MediaStore (re-armed after each run). */
    internal fun armTrigger(c: Context) {
        if (!enabled(c)) return
        val cons = Constraints.Builder()
            .setRequiredNetworkType(if (wifiOnly(c)) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresCharging(chargingOnly(c))
            .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
            .addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
            .setTriggerContentUpdateDelay(30, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(5, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(c).enqueueUniqueWork(
            WORK_TRIGGER, ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<DdnUploadWorker>().setConstraints(cons).setInputData(Data.Builder().putBoolean("trigger", true).build()).build(),
        )
    }

    /** Run now (Copy now, a file queued): expedited, network only (the user asked for it). */
    fun runNow(c: Context, autoCopy: Boolean = true, manual: Boolean = false) {
        WorkManager.getInstance(c).enqueueUniqueWork(
            WORK_NOW, ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<DdnUploadWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInputData(Data.Builder().putBoolean("auto", autoCopy).putBoolean("manual", manual).build())
                .build(),
        )
    }

    // ── what was copied (MediaStore ID + size + date → node) ──
    internal class Db(c: Context) : SQLiteOpenHelper(c, "ddn-upload.db", null, 2) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE copied (media INTEGER, size INTEGER, modified INTEGER, account TEXT, node TEXT, at INTEGER, PRIMARY KEY (media, size, modified, account))")
            // The queue: files the user sent (a copy in the app's storage, or a URI the app may read for good).
            db.execSQL("CREATE TABLE queue (id INTEGER PRIMARY KEY AUTOINCREMENT, uri TEXT, local TEXT, name TEXT, size INTEGER, folder TEXT, account TEXT, error TEXT, at INTEGER, taken INTEGER)")
        }
        override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) {
            // 2: when the shared file was made (read before the copy into the outbox loses it).
            if (old < 2) db.execSQL("ALTER TABLE queue ADD COLUMN taken INTEGER")
        }

        fun isCopied(media: Long, size: Long, modified: Long, account: String): Boolean =
            readableDatabase.rawQuery("SELECT 1 FROM copied WHERE media=? AND size=? AND modified=? AND account=?", arrayOf("$media", "$size", "$modified", account)).use { it.moveToFirst() }
        fun markCopied(media: Long, size: Long, modified: Long, account: String, node: String) {
            writableDatabase.insertWithOnConflict("copied", null, ContentValues().apply {
                put("media", media); put("size", size); put("modified", modified); put("account", account); put("node", node); put("at", System.currentTimeMillis())
            }, SQLiteDatabase.CONFLICT_REPLACE)
        }
        data class CopiedRow(val size: Long, val modified: Long, val node: String)
        /** Every copied media of the account: MediaStore ID → what was copied. */
        fun copiedRows(account: String): Map<Long, CopiedRow> = readableDatabase.rawQuery("SELECT media, size, modified, node FROM copied WHERE account=?", arrayOf(account)).use { c ->
            buildMap { while (c.moveToNext()) put(c.getLong(0), CopiedRow(c.getLong(1), c.getLong(2), c.getString(3))) }
        }
        fun copiedCount(account: String): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM copied WHERE account=?", arrayOf(account)).use { it.moveToFirst(); it.getInt(0) }

        data class Queued(val id: Long, val uri: String?, val local: String?, val name: String, val size: Long, val folder: String, val error: String?, val taken: Long? = null)
        fun enqueue(uri: String?, local: String?, name: String, size: Long, folder: String, account: String, taken: Long? = null): Long =
            writableDatabase.insert("queue", null, ContentValues().apply {
                put("uri", uri); put("local", local); put("name", name); put("size", size); put("folder", folder); put("account", account); put("at", System.currentTimeMillis())
                if (taken != null) put("taken", taken)
            })
        fun queued(account: String): List<Queued> = readableDatabase.rawQuery("SELECT id, uri, local, name, size, folder, error, taken FROM queue WHERE account=? ORDER BY id", arrayOf(account)).use { c ->
            buildList { while (c.moveToNext()) add(Queued(c.getLong(0), c.getString(1), c.getString(2), c.getString(3), c.getLong(4), c.getString(5), c.getString(6), if (c.isNull(7)) null else c.getLong(7))) }
        }
        fun done(id: Long) = writableDatabase.delete("queue", "id=?", arrayOf("$id"))
        fun failed(id: Long, error: String) = writableDatabase.update("queue", ContentValues().apply { put("error", error) }, "id=?", arrayOf("$id"))
        /** Try a failed item again (its error cleared). */
        fun retry(id: Long): Int {
            // A fresh try: channels marked removed are asked again (one fixed meanwhile is used; a removed one
            // answers 404 once and is skipped again).
            io.github.magiszonekk.discordrive.core.FileWriter.dead.clear()
            return writableDatabase.update("queue", ContentValues().apply { putNull("error") }, "id=?", arrayOf("$id"))
        }
        /** Drop a failed item from the queue (its copy in the app's storage too). */
        fun drop(id: Long) {
            readableDatabase.rawQuery("SELECT local FROM queue WHERE id=?", arrayOf("$id")).use { if (it.moveToFirst()) it.getString(0)?.let { p -> java.io.File(p).delete() } }
            writableDatabase.delete("queue", "id=?", arrayOf("$id"))
        }
    }

    /**
     * The name of this phone's camera folder, as the phone shows it (the folder the automatic copy puts on the
     * Gallery's timeline): the one chosen for the copy, else the first such folder on the phone, else [fallback].
     * Reads MediaStore, so not on the main thread.
     */
    fun cameraName(c: Context, fallback: String): String {
        buckets(c).filter { it in CAMERA_BUCKETS }.minByOrNull { CAMERA_BUCKETS.indexOf(it) }?.let { return it }
        val onPhone = runCatching { allBuckets(c).keys }.getOrDefault(emptySet())
        return CAMERA_BUCKETS.firstOrNull { it in onPhone } ?: fallback
    }

    /** Media of the chosen camera folders, oldest first (what an automatic copy takes). */
    data class Media(val id: Long, val uri: Uri, val name: String, val bucket: String, val size: Long, val modified: Long, val video: Boolean)
    fun scan(c: Context, buckets: Set<String>): List<Media> {
        val out = ArrayList<Media>()
        for ((coll, video) in listOf(MediaStore.Images.Media.EXTERNAL_CONTENT_URI to false, MediaStore.Video.Media.EXTERNAL_CONTENT_URI to true)) {
            val proj = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.BUCKET_DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_MODIFIED)
            c.contentResolver.query(coll, proj, null, null, null)?.use { cur ->
                while (cur.moveToNext()) {
                    val bucket = cur.getString(2) ?: continue
                    if (bucket !in buckets) continue
                    val size = cur.getLong(3)
                    if (size <= 0) continue
                    val id = cur.getLong(0)
                    out += Media(id, ContentUris.withAppendedId(coll, id), cur.getString(1) ?: "media-$id", bucket, size, cur.getLong(4), video)
                }
            }
        }
        return out.sortedBy { it.modified }
    }

    /** Every folder with photos or videos on the phone (for the settings), with its count. */
    fun allBuckets(c: Context): Map<String, Int> {
        val m = sortedMapOf<String, Int>()
        for (coll in listOf(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, MediaStore.Video.Media.EXTERNAL_CONTENT_URI)) {
            c.contentResolver.query(coll, arrayOf(MediaStore.MediaColumns.BUCKET_DISPLAY_NAME), null, null, null)?.use { cur ->
                while (cur.moveToNext()) cur.getString(0)?.let { m[it] = (m[it] ?: 0) + 1 }
            }
        }
        return m
    }

    /** Items of the queue that failed for good (not a network failure): shown with their cause, Retry / Remove. */
    internal fun failed(c: Context): List<Db.Queued> {
        val acct = DdnAccount.load(c)?.accountId ?: return emptyList()
        return Db(c).queued(acct).filter { it.error != null }
    }

    /** A failure in words (the server's or Discord's code stays in the log). */
    fun reason(c: Context, error: String): String = when {
        error.contains("every channel of the account answered", true) -> c.getString(R.string.ddn_fail_all_channels_gone)
        // 404 "Unknown Webhook" / 401 "Invalid Webhook Token": the webhook (or its token) is gone.
        Regex("HTTP 40[14]").containsMatchIn(error) && error.contains("discord", true) -> c.getString(R.string.ddn_fail_channel_gone)
        Regex("HTTP 403").containsMatchIn(error) && error.contains("discord", true) -> c.getString(R.string.ddn_fail_channel_denied)
        error.startsWith("need_channel") || error.contains("no channel", true) -> c.getString(R.string.ddn_fail_no_channel)
        error.contains("instance_busy") -> c.getString(R.string.ddn_fail_instance_busy)
        error.contains("No such file", true) || error.contains("FileNotFound", true) || error.contains("ENOENT") -> c.getString(R.string.ddn_fail_source_gone)
        error.contains("too large", true) || error.contains("413") -> c.getString(R.string.ddn_fail_too_large)
        else -> c.getString(R.string.ddn_fail_other)
    }

    /** One notification after a run that left failed items (tap: the automatic copy screen with the list). */
    internal fun notifyFailed(c: Context, n: Int) {
        val mgr = c.getSystemService(android.app.NotificationManager::class.java)
        if (n == 0) { mgr.cancel(NOTIF_FAILED); return }
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        if (mgr.getNotificationChannel(NOTIF_CHANNEL_FAILED) == null) mgr.createNotificationChannel(android.app.NotificationChannel(NOTIF_CHANNEL_FAILED, c.getString(R.string.ddn_fail_channel), android.app.NotificationManager.IMPORTANCE_DEFAULT))
        val open = android.app.PendingIntent.getActivity(c, 11, android.content.Intent(c, DdnBackupActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK), android.app.PendingIntent.FLAG_IMMUTABLE)
        mgr.notify(NOTIF_FAILED, NotificationCompat.Builder(c, NOTIF_CHANNEL_FAILED).setSmallIcon(R.drawable.ic_cloud_pending)
            .setContentTitle(c.plq(R.plurals.ddn_fail_title, n, n)).setContentText(c.getString(R.string.ddn_fail_tap))
            .setContentIntent(open).setAutoCancel(true).build())
    }

    // ── the GPS position of photos (ACCESS_MEDIA_LOCATION) ──
    const val NOTIF_LOCATION = 4713
    /** The user refused the permission (the dialog's answer): copies go without the position. */
    fun locationDeclined(c: Context) = prefs(c).getBoolean("loc_declined", false)
    fun setLocationDeclined(c: Context, v: Boolean) = prefs(c).edit().putBoolean("loc_declined", v).apply()
    /** The automatic copy may read photos now: the position is readable, or the user chose to go without it. */
    fun mayCopyMedia(c: Context) = MediaLocation.granted(c) || locationDeclined(c)

    /** "Open the app to keep the location of photos" (tap: the automatic copy screen, which asks). */
    internal fun notifyNeedLocation(c: Context) {
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        val mgr = c.getSystemService(android.app.NotificationManager::class.java)
        if (mgr.getNotificationChannel(NOTIF_CHANNEL_FAILED) == null) mgr.createNotificationChannel(android.app.NotificationChannel(NOTIF_CHANNEL_FAILED, c.getString(R.string.ddn_fail_channel), android.app.NotificationManager.IMPORTANCE_DEFAULT))
        val open = android.app.PendingIntent.getActivity(c, 12, android.content.Intent(c, DdnBackupActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK), android.app.PendingIntent.FLAG_IMMUTABLE)
        mgr.notify(NOTIF_LOCATION, NotificationCompat.Builder(c, NOTIF_CHANNEL_FAILED).setSmallIcon(R.drawable.ic_cloud_pending)
            .setContentTitle(c.getString(R.string.ddn_loc_wait)).setContentText(c.getString(R.string.ddn_loc_tap))
            .setStyle(NotificationCompat.BigTextStyle().bigText(c.getString(R.string.ddn_loc_tap)))
            .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true).build())
    }
    /** The wait is over (granted, or refused for good): its notification goes, and so does its error in the state. */
    internal fun cancelNeedLocation(c: Context) {
        c.getSystemService(android.app.NotificationManager::class.java).cancel(NOTIF_LOCATION)
        status(c)?.takeIf { it.error == c.getString(R.string.ddn_loc_wait) }?.let { setStatus(c, it.copy(error = null)) }
    }

    /** Queue files the user sent: kept in the app's storage until uploaded (a share grant ends with the share). */
    fun enqueueCopy(c: Context, source: Uri, name: String, folderId: String): Long {
        val acct = DdnAccount.load(c) ?: throw IllegalStateException("no account")
        val dir = File(c.filesDir, "outbox").apply { mkdirs() }
        val f = File.createTempFile("up-", ".bin", dir)
        // The date first: the copy in the outbox has today's mtime and the source may lose its permission.
        val taken = runCatching { DdnPictures.takenAt(c, source) }.getOrNull()
        // The original bytes: a photo keeps its GPS position (the caller asked for the permission first).
        MediaLocation.open(c, source).use { i -> f.outputStream().use { o -> i.copyTo(o, 1 shl 20) } }
        return Db(c).enqueue(null, f.path, name, f.length(), folderId, acct.accountId, taken)
    }

    internal fun log(msg: String) = Log.i(TAG, msg)

    /** One run at a time in the process (the periodic job, the trigger and "now" can start together). */
    internal val running = kotlinx.coroutines.sync.Mutex()
}

/** The upload job: the queue first (the user is waiting for it), then the automatic copy. */
class DdnUploadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    private var line = ""
    /** This run's files (status, what is left). */
    private var done = 0
    private var total = 0
    /** What the notification counts: the whole series of runs (see [BackupSeries]). */
    private val series by lazy { BackupSeries.of(applicationContext) }
    private var shown = BackupSeries.State(0, 0)

    /** The notification: foreground once at the start, then kept current by [FgNotice] (see there why). */
    private val notice = FgNotice(this, DdnBackup.NOTIF_ID) { ongoing -> notification(ongoing) }

    // Asked before the run starts (an expedited job on older Android): the series as it stands, not "0 of 0".
    override suspend fun getForegroundInfo(): ForegroundInfo {
        shown = if (series.open) series.state() else BackupSeries.State(0, 0)
        return notice.info()
    }

    private fun notification(ongoing: Boolean): android.app.Notification {
        val c = applicationContext
        val mgr = c.getSystemService(android.app.NotificationManager::class.java)
        if (mgr.getNotificationChannel(DdnBackup.NOTIF_CHANNEL) == null) {
            mgr.createNotificationChannel(android.app.NotificationChannel(DdnBackup.NOTIF_CHANNEL, c.getString(R.string.ddn_up_channel), android.app.NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        }
        return NotificationCompat.Builder(c, DdnBackup.NOTIF_CHANNEL)
            .setSmallIcon(R.drawable.ic_sync)
            .setContentTitle(c.getString(R.string.ddn_up_title, shown.done, shown.total))
            .setContentText(line)
            .setProgress(maxOf(shown.total, 1), shown.done, shown.total == 0)
            .setOngoing(ongoing).setOnlyAlertOnce(true)
            .build()
    }

    private fun show(text: String, force: Boolean = false) {
        line = text
        notice.update(force)
        publish()
    }

    /** One file done (sent, or already in the account): the series counts it. */
    private fun step() {
        done++
        shown = series.step()
        show(line)
    }

    private fun publish() = setProgressAsync(Data.Builder().putInt("done", shown.done).putInt("total", shown.total).putString("line", line).build())

    override suspend fun doWork(): Result = DdnBackup.running.withLockFun { work() }

    private suspend inline fun <T> kotlinx.coroutines.sync.Mutex.withLockFun(crossinline f: suspend () -> T): T { lock(); try { return f() } finally { unlock() } }

    private suspend fun work(): Result = withContext(Dispatchers.IO) {
        val c = applicationContext
        val t0 = System.currentTimeMillis()
        // "Copy now" copies the chosen folders also with the automatic copy off (the user asked for it).
        val auto = inputData.getBoolean("auto", true) && (DdnBackup.enabled(c) || inputData.getBoolean("manual", false))
        val db = DdnBackup.Db(c)
        var copied = 0
        var err: String? = null
        var waiting = 0
        try {
            val s = DdnSession.get(c) ?: return@withContext Result.success()
            s.refresh()
            val acct = s.acct.accountId
            val up = s.uploader()
            val queue = db.queued(acct).filter { it.error == null }
            // Without ACCESS_MEDIA_LOCATION the system hands out photos with the position zeroed and a copy would
            // keep them so: the automatic copy waits (a notification asks to open the app, which asks for it),
            // unless the user refused it (then the copies are without the position, as chosen).
            val noLocation = auto && MediaLocation.hasMediaAccess(c) && !DdnBackup.mayCopyMedia(c)
            if (noLocation) DdnBackup.notifyNeedLocation(c) else DdnBackup.cancelNeedLocation(c)
            val media = if (auto && !noLocation) DdnBackup.scan(c, DdnBackup.buckets(c)).filter { !db.isCopied(it.id, it.size, it.modified, acct) } else emptyList()
            if (noLocation) err = c.getString(R.string.ddn_loc_wait)
            total = queue.size + media.size
            shown = series.start(acct, total)
            line = c.getString(R.string.ddn_up_starting)
            // Started in the background (the trigger on new photos), Android may refuse the foreground service:
            // then the run is a plain job, which Android stops after ~10 minutes, so it takes a shorter budget.
            if (!notice.start()) budget = DdnBackup.PLAIN_RUN_BUDGET_MS
            publish()
            for (q in queue) {
                if (isStopped || System.currentTimeMillis() - t0 > budget) break
                show(q.name)
                try {
                    val local = q.local?.let(::File)
                    val open = { local?.inputStream() ?: c.contentResolver.openInputStream(Uri.parse(q.uri))!! }
                    val pics = if (DdnSession.isImage(q.name) || DdnSession.isVideo(q.name)) runCatching { picturesOf(c, local, q.uri) }.getOrDefault(emptyList()) else emptyList()
                    val taken = q.taken ?: q.uri?.let { u -> runCatching { DdnPictures.takenAt(c, Uri.parse(u)) }.getOrNull() }
                    up.upload(open, q.size, q.name, q.folder, pics, progress = { a, b -> progress(q.name, a, b) }, cancelled = { isStopped }, takenAt = taken)
                    db.done(q.id)
                    local?.delete()
                    copied++
                    step()
                } catch (e: FileWriter.Cancelled) {
                    break
                } catch (e: Exception) {
                    DdnBackup.log("queue ${q.name}: ${e.message}")
                    // A network failure is tried again in the next run; anything else stays with its error.
                    if (e !is java.io.IOException) db.failed(q.id, e.message ?: e.javaClass.simpleName)
                    err = e.message
                }
            }
            if (media.isNotEmpty()) {
                val root = DdnBackup.rootName(s.acct.deviceName)
                val toGallery = s.gallerySpace
                val folders = HashMap<String, String>()
                for (m in media) {
                    if (isStopped || System.currentTimeMillis() - t0 > budget) break
                    show(m.name)
                    try {
                        val folder = folders.getOrPut(m.bucket) {
                            when {
                                !toGallery -> s.folderPath(listOf(root, m.bucket))
                                m.bucket in DdnBackup.CAMERA_BUCKETS -> s.galleryRoot
                                else -> s.galleryAlbum(m.bucket)
                            }
                        }
                        // Already there (a reinstall, another copy of the app): the same name with the same size.
                        val have = s.children(folder).firstOrNull { !it.isFolder && it.name == m.name && it.size == m.size }
                        if (have != null) {
                            db.markCopied(m.id, m.size, m.modified, acct, have.id)
                        } else {
                            // The original bytes, with the GPS position (the run waits for the permission, see below).
                            val src = MediaLocation.original(c, m.uri)
                            val open = { MediaLocation.open(c, m.uri) }
                            val pics = runCatching { DdnPictures.make(c.contentResolver, m.uri) }.getOrDefault(emptyList())
                            val taken = runCatching { DdnPictures.takenAt(c, src) }.getOrNull() ?: (m.modified * 1000).takeIf { it > 0 }
                            val r = up.upload(open, m.size, m.name, folder, pics, progress = { a, b -> progress(m.name, a, b) }, cancelled = { isStopped }, takenAt = taken)
                            db.markCopied(m.id, m.size, m.modified, acct, r.nodeId)
                            copied++
                        }
                        step()
                    } catch (e: FileWriter.Cancelled) {
                        break
                    } catch (e: Exception) {
                        DdnBackup.log("copy ${m.name}: ${e.message}")
                        err = e.message
                        if (e is java.io.IOException || e.message?.startsWith("need_channel") == true) break
                    }
                }
            }
            waiting = total - done
            series.end(waiting)
            DdnBackup.log("run: copied $copied, waiting $waiting, ${System.currentTimeMillis() - t0} ms")
        } catch (e: Exception) {
            err = e.message
            DdnBackup.log("run failed: ${e.message}")
        } finally {
            notice.end()
            DdnBackup.setStatus(c, DdnBackup.Status(System.currentTimeMillis(), copied, waiting, err))
            runCatching { DdnBackup.notifyFailed(c, DdnBackup.failed(c).size) }
            if (inputData.getBoolean("trigger", false)) DdnBackup.armTrigger(c)
        }
        // More left (the run's time budget, a network failure): the next run right away, as a new job.
        if (waiting > 0 && !isStopped) {
            if (err != null && copied == 0) return@withContext Result.retry()
            DdnBackup.runNow(c, auto)
        }
        Result.success()
    }

    private var budget = DdnBackup.RUN_BUDGET_MS
    private var lastShown = 0L
    private fun progress(name: String, sent: Long, size: Long) {
        val t = System.currentTimeMillis()
        if (t - lastShown < 1000) return
        lastShown = t
        show("$name · ${sent * 100 / maxOf(size, 1)}%")
    }

    private fun picturesOf(c: Context, local: File?, uri: String?): List<io.github.magiszonekk.discordrive.core.FileWrite.Picture> {
        if (uri != null) return DdnPictures.make(c.contentResolver, Uri.parse(uri))
        if (local == null) return emptyList()
        return DdnPictures.fromFile(local)
    }
}
