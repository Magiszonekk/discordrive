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

        val mode = inputData.getString(KEY_MODE) ?: MODE_SYNC
        val bucket = inputData.getString(KEY_BUCKET)

        SyncNotifications.ensureChannel(ctx)
        // One job at a time (sync OR AI) — avoids two jobs fighting over the notification.
        if (!SyncController.tryBegin()) {
            AppLog.i("SyncWorker", "a job is already running — skipping")
            return Result.success()
        }
        // Initial notification title reflects the job (before the first progress tick).
        val initialLabel = when (mode) {
            MODE_AI -> R.string.action_ai
            MODE_DOWNLOAD -> R.string.sync_from_cloud
            MODE_DOWNLOAD_PREVIEWS -> R.string.sync_previews
            else -> R.string.sync_notif_title
        }
        SyncController.update(0, 0, ctx.getString(initialLabel), "")
        setForegroundAsync(foregroundInfo(ctx))

        return try {
            val runner = SyncRunner(ctx, client, filesKey)
            when (mode) {
                MODE_AI -> runAi(ctx, runner, bucket)
                MODE_DOWNLOAD -> {
                    val tracker = newSpeedTracker(ctx, ctx.getString(R.string.sync_from_cloud), "↓")
                    val r = runner.downloadFromCloud { tracker.onProgress(it) }
                    AppLog.i("SyncWorker", "download: ${r.downloaded} downloaded, ${r.failed} failed")
                }
                MODE_DOWNLOAD_PREVIEWS -> {
                    val tracker = JobProgressTracker(ctx, ctx.getString(R.string.sync_previews)) {
                        "${it.downloaded} ${ctx.getString(R.string.sync_previews_done)}"
                    }
                    val r = runner.downloadPreviewsFromCloud { tracker.onProgress(it) }
                    AppLog.i("SyncWorker", "previews: ${r.downloaded} downloaded, ${r.failed} failed")
                }
                else -> {
                    AppLog.i("SyncWorker", "sync run")
                    val tracker = newSpeedTracker(ctx, ctx.getString(R.string.sync_notif_title), "↑")
                    val sync = runner.sync { tracker.onProgress(it) }
                    AppLog.i("SyncWorker", "sync: +${sync.uploaded} up, ${sync.deduplicated} dedup, ${sync.failed} failed")
                    if (Settings.aiAutoAfterSync(ctx) && Settings.aiConfigured(ctx)) runAi(ctx, runner, null)
                }
            }
            Result.success()
        } catch (e: Exception) {
            AppLog.w("SyncWorker", "$mode job failed", e)
            Result.retry()
        } finally {
            SyncController.end()
            ctx.getSystemService(NotificationManager::class.java).cancel(SyncNotifications.NOTIF_ID)
        }
    }

    private fun runAi(ctx: Context, runner: SyncRunner, bucket: String?) {
        if (!Settings.aiConfigured(ctx)) return
        val ai = AiVisionClient(Settings.aiUrl(ctx), Settings.aiKey(ctx), Settings.aiModel(ctx))
        val tracker = JobProgressTracker(ctx, ctx.getString(R.string.action_ai)) { "${it.analyzed} ${ctx.getString(R.string.ai_notif_new)}" }
        val r = runner.aiScan(ai, Settings.aiModel(ctx), bucketFilter = bucket, limit = Settings.aiLimit(ctx), concurrency = Settings.aiConcurrency(ctx)) { tracker.onProgress(it) }
        AppLog.i("SyncWorker", "ai: ${r.analyzed} analyzed, ${r.failed} failed")
    }

    /**
     * Tracker showing a rolling transfer speed ([arrow] = ↑ for sync, ↓ for download),
     * averaged over the last ~15 s: bytesDone advances a whole file at a time
     * (4 parallel uploads), so an instantaneous delta would jump wildly.
     */
    private fun newSpeedTracker(ctx: Context, label: String, arrow: String): JobProgressTracker {
        val samples = ArrayDeque<Pair<Long, Long>>() // (timeMs, bytesDone)
        return JobProgressTracker(ctx, label) { p ->
            val now = System.currentTimeMillis()
            samples.addLast(now to p.bytesDone)
            while (samples.size > 1 && now - samples.first().first > SPEED_WINDOW_MS) samples.removeFirst()
            val (t0, b0) = samples.first()
            val dtMs = now - t0
            val speed = if (dtMs >= 1000) ((p.bytesDone - b0) * 1000 / dtMs).coerceAtLeast(0) else 0L
            if (speed > 0) "$arrow ${android.text.format.Formatter.formatShortFileSize(ctx, speed)}/s" else ""
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
        private const val SPEED_WINDOW_MS = 15_000L
        private const val WORK_NAME = "ddv4-bg-sync"
        private const val NOW_WORK_NAME = "ddv4-sync-now"
        const val KEY_MODE = "mode"
        const val KEY_BUCKET = "bucket"
        const val MODE_SYNC = "sync"
        const val MODE_AI = "ai"
        const val MODE_DOWNLOAD = "download"
        const val MODE_DOWNLOAD_PREVIEWS = "download_previews"

        /**
         * Runs a sync or AI pass immediately as a foreground service, so it keeps
         * going when the user leaves the app / screen off (it used to run in the
         * Activity thread and got killed). KEEP = don't start a 2nd while one runs.
         * @param mode [MODE_SYNC] (sync + optional auto-AI) or [MODE_AI]
         * @param bucket for AI: analyze only this album (null = whole library)
         */
        fun runNow(context: Context, mode: String = MODE_SYNC, bucket: String? = null) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setInputData(
                    androidx.work.Data.Builder()
                        .putString(KEY_MODE, mode)
                        .apply { bucket?.let { putString(KEY_BUCKET, it) } }
                        .build(),
                )
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
