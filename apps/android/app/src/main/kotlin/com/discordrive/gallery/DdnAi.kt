package com.discordrive.gallery

import android.content.Context
import android.content.pm.ServiceInfo
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.github.magiszonekk.discordrive.core.AiDescriber
import io.github.magiszonekk.discordrive.core.AiException
import io.github.magiszonekk.discordrive.core.Describe
import io.github.magiszonekk.discordrive.core.FileFormat
import io.github.magiszonekk.discordrive.core.IndexReplica
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

/**
 * AI descriptions of the account's photos (search by what is on them), with the user's own endpoint in the
 * OpenAI format. Off by default. The settings (address, key, model) live in the account's encrypted vault in
 * metadata only (other devices use them); e2ee / plain have no vault of the account, there they stay on this
 * phone (encrypted with the Android keystore). Pictures go to the endpoint downscaled (long side 1024, from the
 * stored preview or thumbnail when there is one); the description is stored encrypted with the file's key next
 * to its thumbnail (Describe), and in a local table for search. Photos of private albums are left out unless
 * the user allows them separately.
 */
object DdnAi {
    private fun prefs(c: Context) = c.getSharedPreferences("ddn-ai", Context.MODE_PRIVATE)
    private const val SECRET = "ddn-ai-config"
    const val WORK_PERIODIC = "ddn-ai-periodic"
    const val WORK_NOW = "ddn-ai-now"
    const val NOTIF_ID = 4711
    /** One description at a time, at most this many per minute (endpoint limits; the background stays light). */
    const val PER_MIN = 12
    /** One run's work at most (WorkManager gives ~10 min). */
    const val RUN_BUDGET_MS = 8 * 60_000L

    fun enabled(c: Context) = prefs(c).getBoolean("on", false)
    fun wifiOnly(c: Context) = prefs(c).getBoolean("wifi", true)
    fun chargingOnly(c: Context) = prefs(c).getBoolean("charging", true)
    fun privateAllowed(c: Context) = prefs(c).getBoolean("private", false)

    fun set(c: Context, on: Boolean? = null, wifi: Boolean? = null, charging: Boolean? = null, private: Boolean? = null) {
        prefs(c).edit().apply {
            on?.let { putBoolean("on", it) }; wifi?.let { putBoolean("wifi", it) }
            charging?.let { putBoolean("charging", it) }; private?.let { putBoolean("private", it) }
        }.apply()
        schedule(c)
    }

    // ── the endpoint settings ──

    /** Metadata only: from the vault (the account's); else this phone's copy. */
    fun config(c: Context, s: DdnSession? = DdnSession.get(c)): Describe.AiConfig? {
        if (s != null && !s.acct.serverBlobs) runCatching { Describe.configOf(s.sync.vault) }.getOrNull()?.let { return it }
        val t = SecureStore(c).getString(SECRET) ?: return null
        return runCatching { Describe.configOf(io.github.magiszonekk.discordrive.core.json.parseToJsonElement(t) as kotlinx.serialization.json.JsonObject) }.getOrNull()
    }

    /** Store the settings (null = remove): in the vault (metadata only, a compare-and-swap edit) or on the phone. */
    fun saveConfig(c: Context, s: DdnSession?, cfg: Describe.AiConfig?) {
        if (s != null && !s.acct.serverBlobs) {
            s.sync.updateVault { v -> Describe.withConfig(v, cfg) }
            DdnAccount.setVaultRevision(c, s.sync.vaultRevision)
            SecureStore(c).remove(SECRET)
        } else if (cfg == null) SecureStore(c).remove(SECRET)
        else SecureStore(c).putString(SECRET, io.github.magiszonekk.discordrive.core.json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), Describe.withConfig(kotlinx.serialization.json.JsonObject(emptyMap()), cfg)))
    }

    /**
     * The language of descriptions and tags: the app's (its strings), not the phone's — a Polish app on an
     * English phone searches Polish words. Stored descriptions keep their language (Record.lang).
     */
    fun lang(c: Context): String = c.getString(R.string.ddn_ai_lang)

    // ── progress ──

    data class Status(val at: Long, val done: Int, val total: Int, val error: String?)
    fun status(c: Context): Status? = prefs(c).takeIf { it.contains("st_at") }?.let { Status(it.getLong("st_at", 0), it.getInt("st_done", 0), it.getInt("st_total", 0), it.getString("st_err", null)) }
    internal fun setStatus(c: Context, s: Status) = prefs(c).edit().putLong("st_at", s.at).putInt("st_done", s.done).putInt("st_total", s.total).putString("st_err", s.error).apply()

    // ── scheduling ──

    private fun constraints(c: Context) = Constraints.Builder()
        .setRequiredNetworkType(if (wifiOnly(c)) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .setRequiresCharging(chargingOnly(c))
        .build()

    fun schedule(c: Context) {
        val wm = WorkManager.getInstance(c)
        if (!enabled(c)) { wm.cancelUniqueWork(WORK_PERIODIC); return }
        wm.enqueueUniquePeriodicWork(WORK_PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, PeriodicWorkRequestBuilder<DdnAiWorker>(6, TimeUnit.HOURS).setConstraints(constraints(c)).build())
    }

    /**
     * "Describe now": with the user's constraints dropped to "any network" (they asked for it); runs also when
     * the background describing is off (`manual`).
     */
    fun runNow(c: Context, manual: Boolean = true) {
        WorkManager.getInstance(c).enqueueUniqueWork(WORK_NOW, ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<DdnAiWorker>().setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInputData(androidx.work.Data.Builder().putBoolean("manual", manual).build()).build())
    }

    /** Live progress of a run (the settings screen polls it). */
    @Volatile var live: Pair<Int, Int>? = null

    // ── the local table of descriptions (search, "described X of Y") ──

    class Db(c: Context) : SQLiteOpenHelper(c, "ddn-ai.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) {
            // ref: manifestRef of the version; state: "ok" (described), "absent" (no description stored with it, asked
            // at `at`), "none" (not describable), "err" (failed, retried later).
            db.execSQL("CREATE TABLE d (account TEXT NOT NULL, ref TEXT NOT NULL, node TEXT NOT NULL, state TEXT NOT NULL, rec TEXT, at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, ref))")
        }
        override fun onUpgrade(db: SQLiteDatabase, o: Int, n: Int) {}

        fun state(account: String, ref: String): Pair<String, Int>? = readableDatabase.rawQuery("SELECT state, tries FROM d WHERE account=? AND ref=?", arrayOf(account, ref)).use { if (it.moveToFirst()) it.getString(0) to it.getInt(1) else null }

        fun put(account: String, ref: String, node: String, state: String, rec: Describe.Record?) {
            val tries = if (state == "err") (state(account, ref)?.second ?: 0) + 1 else 0
            writableDatabase.execSQL("INSERT OR REPLACE INTO d (account, ref, node, state, rec, at, tries) VALUES (?, ?, ?, ?, ?, ?, ?)",
                arrayOf(account, ref, node, state, rec?.let(::encode), System.currentTimeMillis(), tries))
        }

        fun count(account: String, state: String): Int = readableDatabase.rawQuery("SELECT count(*) FROM d WHERE account=? AND state=?", arrayOf(account, state)).use { it.moveToFirst(); it.getInt(0) }

        fun record(account: String, ref: String): Describe.Record? = readableDatabase.rawQuery("SELECT rec FROM d WHERE account=? AND ref=? AND state='ok'", arrayOf(account, ref)).use { if (it.moveToFirst()) it.getString(0)?.let(::decode) else null }

        fun clear(account: String) = writableDatabase.delete("d", "account=?", arrayOf(account))

        /** Every stored description of the account: manifestRef → record. */
        fun records(account: String): Map<String, Describe.Record> {
            val out = HashMap<String, Describe.Record>()
            readableDatabase.rawQuery("SELECT ref, rec FROM d WHERE account=? AND state='ok'", arrayOf(account)).use { c ->
                while (c.moveToNext()) c.getString(1)?.let(::decode)?.let { out[c.getString(0)] = it }
            }
            return out
        }

        fun askedAt(account: String, ref: String): Long = readableDatabase.rawQuery("SELECT at FROM d WHERE account=? AND ref=?", arrayOf(account, ref)).use { if (it.moveToFirst()) it.getLong(0) else 0 }

        private fun encode(r: Describe.Record) = io.github.magiszonekk.discordrive.core.json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), kotlinx.serialization.json.buildJsonObject {
            put("d", kotlinx.serialization.json.JsonPrimitive(r.description)); put("g", kotlinx.serialization.json.JsonArray(r.tags.map { kotlinx.serialization.json.JsonPrimitive(it) }))
            r.text?.let { put("t", kotlinx.serialization.json.JsonPrimitive(it)) }; r.transcript?.let { put("s", kotlinx.serialization.json.JsonPrimitive(it)) }
            put("m", kotlinx.serialization.json.JsonPrimitive(r.model)); put("a", kotlinx.serialization.json.JsonPrimitive(r.at)); put("l", kotlinx.serialization.json.JsonPrimitive(r.lang))
        })

        private fun decode(t: String): Describe.Record? = runCatching {
            val o = io.github.magiszonekk.discordrive.core.json.parseToJsonElement(t) as kotlinx.serialization.json.JsonObject
            fun s(k: String) = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
            Describe.Record(s("d") ?: "", (o["g"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content } ?: emptyList(), s("t"), s("s"), s("m") ?: "", (o["a"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toLongOrNull() ?: 0, s("l") ?: "pl")
        }.getOrNull()
    }

    /** Media of the account to describe (photos; private albums only when allowed). */
    fun candidates(c: Context, s: DdnSession): List<IndexReplica.Child> {
        val locked = if (privateAllowed(c)) emptySet() else DdnPrivate.all(c)
        return s.media(100_000, null, locked).filter { DdnSession.isImage(it.name) && it.manifestRef != null }
    }

    /**
     * The picture sent to the endpoint: the stored preview (long side 1280) or thumbnail, else the file itself
     * (≤ 25 MB), downscaled to a JPEG with the long side ≤ 1024. Null = nothing usable.
     */
    fun picture(s: DdnSession, f: IndexReplica.Child): ByteArray? {
        val ref = f.manifestRef ?: return null
        val src = runCatching { s.files.preview(ref, 'p') ?: s.files.preview(ref, 't') }.getOrNull()?.data
            ?: (f.size?.takeIf { it in 1..25L * 1024 * 1024 }?.let { n -> ByteArrayOutputStream().also { o -> s.files.download(ref, n, f.sha256, o) }.toByteArray() })
            ?: return null
        val b = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(src, 0, src.size, b)
        if (b.outWidth <= 0) return null
        var sample = 1
        while (maxOf(b.outWidth, b.outHeight) / (sample * 2) >= 1024) sample *= 2
        var bmp = BitmapFactory.decodeByteArray(src, 0, src.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val long = maxOf(bmp.width, bmp.height)
        if (long > 1024) bmp = Bitmap.createScaledBitmap(bmp, bmp.width * 1024 / long, bmp.height * 1024 / long, true)
        return ByteArrayOutputStream().use { o -> bmp.compress(Bitmap.CompressFormat.JPEG, 80, o); o.toByteArray() }
    }

    /**
     * Describe one file: a description already stored with it (another device) is taken as it is; otherwise
     * the endpoint describes it and the result is stored with the file. Returns the record (null: nothing to send).
     */
    fun describeOne(c: Context, s: DdnSession, ai: AiDescriber, f: IndexReplica.Child, db: Db): Describe.Record? {
        val ref = f.manifestRef ?: return null
        val acct = s.acct.accountId
        runCatching { s.files.description(ref) }.getOrNull()?.let { db.put(acct, ref, f.id, "ok", it); return it }
        val jpeg = picture(s, f) ?: run { db.put(acct, ref, f.id, "none", null); return null }
        val rec = ai.describe(jpeg, lang(c))
        val loc = FileFormat.decodeManifestRef(ref)
        if (!s.addExtra(f, Describe.name(loc.fileKey), Describe.seal(loc.fileKey, rec))) {
            // Another device stored one meanwhile: that one counts (the same for every device).
            runCatching { s.files.description(ref) }.getOrNull()?.let { db.put(acct, ref, f.id, "ok", it); return it }
        }
        db.put(acct, ref, f.id, "ok", rec)
        return rec
    }

    /**
     * The local table catches up with the descriptions stored in the account (made by another device): for
     * media not looked at yet (or found without one more than a day ago) one read of the extras of its
     * manifest. At most `budget` reads per call (a big account fills up over a few runs). Returns how many
     * descriptions it found. Needs no AI endpoint: search works with descriptions made elsewhere.
     */
    fun syncDescriptions(c: Context, s: DdnSession, budget: Int = 300): Int {
        val db = Db(c)
        val acct = s.acct.accountId
        val now = System.currentTimeMillis()
        var reads = 0
        var found = 0
        for (f in s.media(1_000_000, null)) {
            if (reads >= budget) break
            val ref = f.manifestRef ?: continue
            val st = db.state(acct, ref)?.first
            if (st == "ok" || st == "none" || st == "err") continue
            if (st == "absent" && now - db.askedAt(acct, ref) < 24 * 3600_000L) continue
            reads++
            val got = runCatching { s.files.description(ref) }
            if (got.isFailure) continue
            val rec = got.getOrNull()
            if (rec != null) { db.put(acct, ref, f.id, "ok", rec); found++ } else db.put(acct, ref, f.id, "absent", null)
        }
        return found
    }

    /** A readable reason for an endpoint failure. */
    fun reason(c: Context, e: Throwable): String = when ((e as? AiException)?.kind) {
        "auth" -> c.getString(R.string.ddn_ai_err_auth)
        "rate" -> c.getString(R.string.ddn_ai_err_rate)
        "net" -> c.getString(R.string.ddn_ai_err_net)
        "parse" -> c.getString(R.string.ddn_ai_err_parse)
        else -> c.getString(R.string.ddn_ai_err_other, e.message ?: e.javaClass.simpleName)
    }
}

/** The background run: describes what is not described yet, paced (PER_MIN), within RUN_BUDGET_MS. */
class DdnAiWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    private var done = 0
    private var total = 0

    override suspend fun getForegroundInfo(): ForegroundInfo = info()

    private fun info(): ForegroundInfo {
        val c = applicationContext
        val mgr = c.getSystemService(android.app.NotificationManager::class.java)
        if (mgr.getNotificationChannel(DdnBackup.NOTIF_CHANNEL) == null) {
            mgr.createNotificationChannel(android.app.NotificationChannel(DdnBackup.NOTIF_CHANNEL, c.getString(R.string.ddn_up_channel), android.app.NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        }
        val n = NotificationCompat.Builder(c, DdnBackup.NOTIF_CHANNEL).setSmallIcon(R.drawable.ic_sync)
            .setContentTitle(c.getString(R.string.ddn_ai_progress, done, maxOf(total, done)))
            .setProgress(maxOf(total, 1), done, total == 0).setOngoing(true).setOnlyAlertOnce(true).build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(DdnAi.NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(DdnAi.NOTIF_ID, n)
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val c = applicationContext
        val s = DdnSession.get(c) ?: return@withContext Result.success()
        runCatching { s.refresh() }
        val cfg = DdnAi.config(c, s) ?: return@withContext Result.success()
        if (!DdnAi.enabled(c) && !inputData.getBoolean("manual", false)) return@withContext Result.success()
        val ai = AiDescriber(cfg.url, cfg.key, cfg.model)
        val db = DdnAi.Db(c)
        val acct = s.acct.accountId
        val all = DdnAi.candidates(c, s)
        // Not described yet; a failed one again after a while (at most 3 tries).
        val todo = all.filter { f -> db.state(acct, f.manifestRef!!).let { it == null || it.first == "absent" || (it.first == "err" && it.second < 3) } }
        total = todo.size
        val t0 = System.currentTimeMillis()
        var err: String? = null
        var last = 0L
        runCatching { setForeground(info()) }
        for (f in todo) {
            if (isStopped || System.currentTimeMillis() - t0 > DdnAi.RUN_BUDGET_MS) break
            val wait = last + 60_000L / DdnAi.PER_MIN - System.currentTimeMillis()
            if (wait > 0) Thread.sleep(wait)
            last = System.currentTimeMillis()
            var stop = false
            // A 429 waits as asked and tries the same photo again (up to 3 times), it is not skipped.
            for (attempt in 0 until 3) {
                try {
                    DdnAi.describeOne(c, s, ai, f, db)
                    done++
                    DdnAi.live = db.count(acct, "ok") to all.size
                    err = null
                } catch (e: AiException) {
                    err = DdnAi.reason(c, e)
                    when (e.kind) {
                        // The key refused / the endpoint unreachable: the rest would fail the same way.
                        "auth", "net" -> stop = true
                        "rate" -> { Thread.sleep(minOf(120L, maxOf(2L, e.retryAfterS)) * 1000); continue }
                        else -> db.put(acct, f.manifestRef!!, f.id, "err", null)
                    }
                } catch (e: Exception) {
                    err = DdnAi.reason(c, e)
                    db.put(acct, f.manifestRef!!, f.id, "err", null)
                }
                break
            }
            if (stop) break
            if (done % 5 == 0) runCatching { setForeground(info()) }
        }
        DdnAi.live = null
        DdnAi.setStatus(c, DdnAi.Status(System.currentTimeMillis(), db.count(acct, "ok"), all.size, err))
        Result.success()
    }
}
