package com.discordrive.gallery

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.github.magiszonekk.discordrive.core.AppUpdates
import io.github.magiszonekk.discordrive.core.TrashPolicy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * App-wide settings of the discordrive part of the app (SharedPreferences "ddn-app"): check for updates,
 * the automatic trash cleanup (rule Q4), and the background jobs for both.
 */
object DdnApp {
    private const val PREFS = "ddn-app"
    const val WORK_MAINT = "ddn-maintenance"
    private const val TAG = "ddn-app"

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun checkUpdates(c: Context) = prefs(c).getBoolean("updates", true)
    fun setCheckUpdates(c: Context, on: Boolean) { prefs(c).edit().putBoolean("updates", on).apply(); schedule(c) }
    /** The build last seen in the release (so the notification is shown once per build). */
    private fun notifiedCode(c: Context) = prefs(c).getLong("notified", 0)
    private fun setNotified(c: Context, code: Long) = prefs(c).edit().putLong("notified", code).apply()
    fun lastClean(c: Context): String? = prefs(c).getString("clean", null)
    internal fun setLastClean(c: Context, s: String) = prefs(c).edit().putString("clean", s).apply()

    fun installedVersion(c: Context): Pair<Long, String> {
        val pi = c.packageManager.getPackageInfo(c.packageName, 0)
        return pi.longVersionCode to (pi.versionName ?: "?")
    }

    fun metered(c: Context): Boolean = (c.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).isActiveNetworkMetered

    /** The daily job: the trash cleanup (unmetered) and the update check (when on). */
    fun schedule(c: Context) {
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(
            WORK_MAINT, ExistingPeriodicWorkPolicy.UPDATE,
            PeriodicWorkRequestBuilder<DdnMaintenanceWorker>(12, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build(),
        )
    }

    /** Tests (CI) point the update check at a local fake of the GitHub API. Never set in the app. */
    @Volatile var testUpdatesApi: String? = null

    fun updates(): AppUpdates = testUpdatesApi?.let { AppUpdates(apiBase = it) } ?: AppUpdates()

    /** A newer build in the release (null: none, or the check failed). Off the main thread. */
    fun newer(c: Context): AppUpdates.Build? {
        val b = updates().latest() ?: return null
        return b.takeIf { AppUpdates.isNewer(installedVersion(c).first, it) }
    }

    /** Download (checked) into the app's cache: the same build is not downloaded twice. */
    fun download(c: Context, b: AppUpdates.Build, progress: (Long, Long) -> Unit, cancelled: () -> Boolean = { false }): File =
        updates().download(b, File(File(c.cacheDir, "updates").apply { mkdirs() }, "discordrive-${b.versionCode}.apk"), progress, cancelled)

    /**
     * Hand the APK to the system installer (PackageInstaller session): the system shows its confirmation and
     * checks the signature; the app restarts as the new version. Android 12+: this app is the update owner of
     * its own installs only when it installed itself; the system asks the user in every case (no silent install).
     */
    fun install(c: Context, apk: File) {
        val pi = c.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(c.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
            if (Build.VERSION.SDK_INT >= 34) setRequestUpdateOwnership(true)
        }
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            s.openWrite("base.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out) }; s.fsync(out) }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pending = PendingIntent.getBroadcast(c, id, Intent(c, DdnInstallReceiver::class.java), flags)
            s.commit(pending.intentSender)
        }
    }

    fun canInstall(c: Context) = c.packageManager.canRequestPackageInstalls()

    internal fun notifyUpdate(c: Context, b: AppUpdates.Build) {
        if (notifiedCode(c) >= b.versionCode) return
        val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel("ddn-updates", c.getString(R.string.ddn_set_updates), NotificationManager.IMPORTANCE_DEFAULT))
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val open = PendingIntent.getActivity(c, 7, Intent(c, DdnSettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
        nm.notify(7, NotificationCompat.Builder(c, "ddn-updates").setSmallIcon(R.drawable.ic_cloud_pending)
            .setContentTitle(c.getString(R.string.ddn_upd_available, b.versionName)).setContentText(c.getString(R.string.ddn_upd_tap))
            .setContentIntent(open).setAutoCancel(true).build())
        setNotified(c, b.versionCode)
    }

    internal fun log(m: String) = Log.i(TAG, m)
}

/** The system installer's answer: it needs the user's confirmation (shown), or it is done / failed. */
class DdnInstallReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        when (val st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = (if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else i.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return
                c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> DdnApp.log("update installed")
            // The user closed the system's window (Cancel / back): not an error.
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                DdnApp.log("update cancelled by the user")
                android.widget.Toast.makeText(c, c.getString(R.string.ddn_upd_cancelled), android.widget.Toast.LENGTH_SHORT).show()
            }
            else -> {
                val msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "status $st"
                DdnApp.log("update failed: $msg")
                // Words for the user; the system's code stays in the log.
                val why = when (st) {
                    PackageInstaller.STATUS_FAILURE_STORAGE -> c.getString(R.string.ddn_upd_no_space)
                    PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> c.getString(R.string.ddn_upd_conflict)
                    else -> c.getString(R.string.ddn_upd_other)
                }
                android.widget.Toast.makeText(c, c.getString(R.string.ddn_upd_failed, why), android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }
}

/** Twice a day: the trash cleanup (Q4) and the update check. */
class DdnMaintenanceWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val c = applicationContext
        runCatching {
            val s = DdnSession.get(c) ?: return@runCatching
            val d = s.autoCleanTrash(metered = DdnApp.metered(c))
            DdnApp.setLastClean(c, "${System.currentTimeMillis()} ${if (d is TrashPolicy.Decision.Clean) "purged ${d.nodeIds.size}" else (d as TrashPolicy.Decision.Skip).reason}")
            DdnApp.log("trash cleanup: $d")
        }.onFailure { DdnApp.log("trash cleanup failed: ${it.message}") }
        // Search: descriptions other devices stored with the files.
        runCatching { DdnSession.get(c)?.let { DdnAi.syncDescriptions(c, it) } }.onFailure { DdnApp.log("descriptions: ${it.message}") }
        if (DdnApp.checkUpdates(c)) runCatching { DdnApp.newer(c)?.let { DdnApp.notifyUpdate(c, it) } }
        Result.success()
    }
}
