package com.discordrive.gallery

import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.delay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The upload notification's "X of Y": one count for a whole series of runs, and a notification of its own
 * (not shared with the AI descriptions' job, whose stale text WorkManager re-posted over it).
 */
@RunWith(AndroidJUnit4::class)
class BackupProgressTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    private class MapStore : BackupSeries.Store {
        val m = HashMap<String, Any?>()
        override fun getInt(k: String) = m[k] as? Int ?: 0
        override fun getLong(k: String) = m[k] as? Long ?: 0L
        override fun getString(k: String) = m[k] as? String
        override fun getBoolean(k: String) = m[k] as? Boolean ?: false
        override fun put(values: Map<String, Any?>) { m.putAll(values) }
    }

    /** 1109 photos over three runs (time budget), a new photo in the middle: the count never goes back. */
    @Test
    fun oneCountForTheSeriesOfRuns() {
        var t = 1_000_000L
        val s = BackupSeries(MapStore()) { t }
        assertEquals(BackupSeries.State(0, 1109), s.start("acct", 1109))
        repeat(400) { s.step() }
        s.end(709)
        t += 1000
        // The next run (queued at once): what is left is 709, the count goes on from 400.
        assertEquals(BackupSeries.State(400, 1109), s.start("acct", 709))
        repeat(300) { s.step() }
        s.end(409)
        // A new photo meanwhile: the trigger's run sees 410 left.
        assertEquals(BackupSeries.State(700, 1110), s.start("acct", 410))
        repeat(410) { s.step() }
        assertEquals(BackupSeries.State(1110, 1110), s.state())
        s.end(0)
        // Done: the next photo starts a new series.
        assertEquals(BackupSeries.State(0, 1), s.start("acct", 1))
        s.end(1)
        // Another account, or a series left for long: from 0 again.
        assertEquals(BackupSeries.State(0, 5), s.start("other", 5))
        s.end(5)
        t += BackupSeries.STALE_MS + 1
        assertEquals(BackupSeries.State(0, 5), s.start("other", 5))
    }

    @Test
    fun jobsHaveTheirOwnNotifications() {
        val ids = setOf(DdnBackup.NOTIF_ID, DdnBackup.NOTIF_FAILED, DdnAi.NOTIF_ID, SyncNotifications.NOTIF_ID)
        assertEquals("every job's notification ID differs", 4, ids.size)
    }

    /**
     * Two foreground jobs at once (the AI descriptions' job started first, then the upload): the upload's
     * notification shows its latest count. With one ID for both it showed the first job's text again after
     * each update (WorkManager re-posts the foreground job's own notification); that case is only logged.
     */
    @Test
    fun theSecondJobsCountStaysOnScreen() {
        val distinct = run(firstId = DdnAi.NOTIF_ID, secondId = DdnBackup.NOTIF_ID)
        assertEquals("the upload's notification shows its last count", "B 5 z 5", distinct)
        val shared = run(firstId = 4799, secondId = 4799)
        Log.i("ddn-ui", "one ID for both jobs shows: '$shared'")
    }

    private fun run(firstId: Int, secondId: Int): String? {
        val wm = WorkManager.getInstance(ctx)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val a = req("A 0 z 1109", firstId, steps = 0, holdMs = 15_000)
        wm.enqueue(a)
        assertTrue("first job running", waitUntil { wm.getWorkInfoById(a.id).get()?.state == WorkInfo.State.RUNNING })
        Thread.sleep(1500)
        val b = req("B", secondId, steps = 5, holdMs = 3_000)
        wm.enqueue(b)
        assertTrue("second job reached its last count", waitUntil { wm.getWorkInfoById(b.id).get()?.progress?.getInt("step", 0) == 5 })
        Thread.sleep(800)
        val title = nm.activeNotifications.firstOrNull { it.id == secondId }?.notification?.extras?.getCharSequence(NotificationCompat.EXTRA_TITLE)?.toString()
        wm.cancelWorkById(a.id); wm.cancelWorkById(b.id)
        waitUntil { listOf(a.id, b.id).all { wm.getWorkInfoById(it).get()?.state?.isFinished != false } }
        return title
    }

    private fun req(title: String, id: Int, steps: Int, holdMs: Long) = OneTimeWorkRequestBuilder<FgTestWorker>()
        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        .setInputData(Data.Builder().putString("title", title).putInt("id", id).putInt("steps", steps).putLong("hold", holdMs).build())
        .build()

    private fun waitUntil(ms: Long = 30_000, f: () -> Boolean): Boolean {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) { if (runCatching(f).getOrDefault(false)) return true; Thread.sleep(100) }
        return false
    }
}

/** A foreground job that shows "<title> <n> z <steps>" for each step (or just its title), then holds. */
class FgTestWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    private fun info(text: String): ForegroundInfo {
        val c = applicationContext
        val mgr = c.getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(DdnBackup.NOTIF_CHANNEL) == null) {
            mgr.createNotificationChannel(android.app.NotificationChannel(DdnBackup.NOTIF_CHANNEL, "test", NotificationManager.IMPORTANCE_LOW))
        }
        val n = NotificationCompat.Builder(c, DdnBackup.NOTIF_CHANNEL).setSmallIcon(R.drawable.ic_sync).setContentTitle(text).setOngoing(true).setOnlyAlertOnce(true).build()
        return ForegroundInfo(inputData.getInt("id", 0), n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }

    override suspend fun getForegroundInfo() = info(inputData.getString("title")!!)

    override suspend fun doWork(): Result {
        val title = inputData.getString("title")!!
        val steps = inputData.getInt("steps", 0)
        setForeground(info(if (steps == 0) title else "$title 0 z $steps"))
        for (i in 1..steps) {
            delay(400)
            setForeground(info("$title $i z $steps"))
            setProgress(Data.Builder().putInt("step", i).build())
        }
        delay(inputData.getLong("hold", 0))
        return Result.success()
    }
}
