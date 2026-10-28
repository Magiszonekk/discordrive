package com.discordrive.gallery

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import kotlinx.coroutines.delay
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo

/**
 * The notification of a long background job, kept current with NotificationManager.notify.
 *
 * setForeground is called once, when the job starts. Calling it for every update does not work:
 * WorkManager keeps the notification of the job it put in the foreground first and posts it again after
 * every later update. When the job's generation changes while it runs (a periodic job updated by
 * enqueueUniquePeriodicWork(UPDATE), which the app does each time it opens), later updates are stored
 * under a new key, and the first one, with its old count, is posted again over each new one.
 * Updates go out at most once per [minGapMs] (Android drops a package's updates above 5 a second).
 *
 * When Android does not let the job start a foreground service (a job started in the background, e.g.
 * by the trigger on new photos), the job runs as a plain one and the notification is a plain one
 * (not ongoing, the user can swipe it away). [end] removes it either way.
 */
class FgNotice(
    private val context: Context,
    val id: Int,
    private val minGapMs: Long = 1000,
    /** The worker's setForeground (null: never asks for the foreground service). */
    private val setForeground: (suspend (ForegroundInfo) -> Unit)?,
    private val build: (ongoing: Boolean) -> Notification,
) {
    constructor(worker: CoroutineWorker, id: Int, minGapMs: Long = 1000, build: (ongoing: Boolean) -> Notification) :
        this(worker.applicationContext, id, minGapMs, { worker.setForeground(it) }, build)

    var foreground = false
        private set
    private var last = 0L
    private val nm get() = context.getSystemService(NotificationManager::class.java)

    fun info(): ForegroundInfo {
        val n = build(true)
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(id, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(id, n)
    }

    /** The job starts: in the foreground when Android allows it; the notification is shown either way. */
    suspend fun start(): Boolean {
        val fg = setForeground
        val asked = fg != null && !denyForegroundForTest && runCatching { fg(info()) }
            .onFailure { Log.i("ddn-fg", "notification $id: no foreground service (${it.javaClass.simpleName})") }
            .isSuccess
        // setForeground may return while the service was refused (the refusal is only logged by WorkManager's
        // service): ask Android whether it really runs in the foreground.
        foreground = asked && (inForeground() || run { delay(500); inForeground() })
        if (asked && !foreground) Log.i("ddn-fg", "notification $id: the foreground service was refused")
        post()
        return foreground
    }

    /** The state changed; skipped when the last one went out less than [minGapMs] ago (unless [force]). */
    fun update(force: Boolean = false) {
        if (!force && System.currentTimeMillis() - last < minGapMs) return
        post()
    }

    private fun post() {
        last = System.currentTimeMillis()
        runCatching { nm.notify(id, build(foreground)) }
    }

    @Suppress("DEPRECATION") // still returns the app's own services
    private fun inForeground(): Boolean = runCatching {
        context.getSystemService(android.app.ActivityManager::class.java).getRunningServices(50)
            .any { it.foreground && it.service.packageName == context.packageName && it.service.className.endsWith("SystemForegroundService") }
    }.getOrDefault(false)

    /** The job ended: its notification goes (a foreground service's own is removed by WorkManager too). */
    fun end() {
        runCatching { nm.cancel(id) }
    }

    companion object {
        /** Tests: act as when Android refuses the foreground service (a job started in the background). */
        @Volatile var denyForegroundForTest = false
    }
}
