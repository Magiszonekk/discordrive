package com.discordrive.gallery

import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.discordrive.gallery.api.AiVisionClient
import java.util.concurrent.TimeUnit

/**
 * Background sync — the app does not need to be open. Possible despite E2EE
 * because the ARK is Keystore-wrapped without user-auth (accepted trade-off):
 * the worker silently restores the device session and runs a normal sync pass.
 * Optionally follows up with a rate-limited AI pass (respects the per-run cap).
 */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val ctx = applicationContext
        if (!SessionManager.restore(ctx)) return Result.failure()
        val client = SessionManager.client ?: return Result.failure()
        val filesKey = SessionManager.filesKey ?: return Result.failure()

        SyncNotifications.ensureChannel(ctx)
        // Don't run a 2nd sync on top of a manual one (avoids the dual-progress bug).
        if (!SyncController.tryBegin()) {
            AppLog.i("SyncWorker", "sync already running — skipping bg pass")
            return Result.success()
        }
        setForegroundAsync(foregroundInfo(ctx))

        return try {
            AppLog.i("SyncWorker", "bg sync run")
            val runner = SyncRunner(ctx, client, filesKey)

            // Live notification: progress + rolling upload speed, throttled to ~1s.
            val tracker = SyncProgressTracker(ctx)
            val sync = runner.sync { tracker.onProgress(it) }
            AppLog.i("SyncWorker", "bg sync: +${sync.uploaded} up, ${sync.deduplicated} dedup, ${sync.failed} failed")

            if (Settings.aiAutoAfterSync(ctx) && Settings.aiConfigured(ctx)) {
                val ai = AiVisionClient(Settings.aiUrl(ctx), Settings.aiKey(ctx), Settings.aiModel(ctx))
                val aiResult = runner.aiScan(ai, Settings.aiModel(ctx), bucketFilter = null, limit = Settings.aiLimit(ctx), concurrency = Settings.aiConcurrency(ctx)) {}
                AppLog.i("SyncWorker", "bg ai: ${aiResult.analyzed} analyzed, ${aiResult.failed} failed")
            }
            Result.success()
        } catch (e: Exception) {
            AppLog.w("SyncWorker", "bg sync failed", e)
            Result.retry()
        } finally {
            SyncController.end()
            ctx.getSystemService(NotificationManager::class.java).cancel(SyncNotifications.NOTIF_ID)
        }
    }

    // Required for EXPEDITED one-time work (runNow): WorkManager promotes to a
    // foreground service via this BEFORE doWork — without it the worker throws.
    override fun getForegroundInfo(): ForegroundInfo {
        SyncNotifications.ensureChannel(applicationContext)
        return foregroundInfo(applicationContext)
    }

    private fun foregroundInfo(ctx: Context): ForegroundInfo =
        ForegroundInfo(
            SyncNotifications.NOTIF_ID,
            SyncNotifications.build(ctx),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )

    companion object {
        private const val WORK_NAME = "ddv4-bg-sync"
        private const val NOW_WORK_NAME = "ddv4-sync-now"

        /**
         * Runs a sync immediately as a foreground service, so it keeps going when
         * the user leaves the app or the screen turns off (a manual sync used to
         * run in the Activity thread and got killed on backgrounding). KEEP = if a
         * sync is already running/queued, don't start another.
         */
        fun runNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(NOW_WORK_NAME, ExistingWorkPolicy.KEEP, request)
        }

        /** LiveData of the manual-sync job state (so the UI can refresh on completion). */
        fun nowWorkLiveData(context: Context) =
            WorkManager.getInstance(context).getWorkInfosForUniqueWorkLiveData(NOW_WORK_NAME)

        /** (Re)schedules or cancels periodic sync according to settings. */
        fun applySchedule(context: Context) {
            val wm = WorkManager.getInstance(context)
            if (!Settings.bgSyncEnabled(context)) {
                wm.cancelUniqueWork(WORK_NAME)
                return
            }

            val constraints = Constraints.Builder()
                .setRequiredNetworkType(
                    if (Settings.bgWifiOnly(context)) NetworkType.UNMETERED else NetworkType.CONNECTED,
                )
                .setRequiresCharging(Settings.bgChargingOnly(context))
                .setRequiresBatteryNotLow(true)
                .build()

            val request = PeriodicWorkRequestBuilder<SyncWorker>(3, TimeUnit.HOURS)
                .setConstraints(constraints)
                .build()

            wm.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
        }
    }
}
