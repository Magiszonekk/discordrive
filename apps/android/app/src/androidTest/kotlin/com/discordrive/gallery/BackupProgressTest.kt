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
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import java.util.concurrent.TimeUnit
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

    /**
     * B1: a periodic job is updated while it runs (the app does enqueueUniquePeriodicWork(UPDATE) each time it
     * opens). Its generation changes, and WorkManager posts the notification of the first generation again
     * after every setForeground. With setForeground per update the count freezes (only logged); with FgNotice
     * (one setForeground, then notify) the screen shows the last count.
     */
    @Test
    fun aPeriodicJobUpdatedWhileItRunsKeepsItsCount() {
        val viaSetForeground = periodic("setForeground")
        Log.i("ddn-ui", "setForeground per update, after UPDATE shows: '$viaSetForeground'")
        assertEquals("FgNotice: the last count", "P 12 z 12", periodic("notice"))
    }

    private fun periodic(mode: String): String? {
        val wm = WorkManager.getInstance(ctx)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val name = "fg-test-periodic"
        fun req() = PeriodicWorkRequestBuilder<FgTestWorker>(6, TimeUnit.HOURS)
            .setInputData(Data.Builder().putString("title", "P").putInt("id", 4798).putInt("steps", 12).putLong("hold", 3_000).putString("mode", mode).build()).build()
        wm.enqueueUniquePeriodicWork(name, ExistingPeriodicWorkPolicy.UPDATE, req()).result.get()
        fun info() = wm.getWorkInfosForUniqueWork(name).get().firstOrNull()
        assertTrue("periodic job running", waitUntil { info()?.state == WorkInfo.State.RUNNING && (info()?.progress?.getInt("step", 0) ?: 0) >= 2 })
        // The app opens: the same periodic job enqueued again with UPDATE (a new generation of the running one).
        wm.enqueueUniquePeriodicWork(name, ExistingPeriodicWorkPolicy.UPDATE, req()).result.get()
        assertTrue("reached its last count", waitUntil { info()?.progress?.getInt("step", 0) == 12 })
        Thread.sleep(800)
        val title = nm.activeNotifications.firstOrNull { it.id == 4798 }?.notification?.extras?.getCharSequence(NotificationCompat.EXTRA_TITLE)?.toString()
        wm.cancelUniqueWork(name).result.get()
        waitUntil { info()?.state?.isFinished != false || info()?.state == WorkInfo.State.ENQUEUED }
        Thread.sleep(1000)
        return title
    }

    /**
     * B2: a run Android does not allow in the foreground (started in the background): the notification is
     * shown anyway, not ongoing, and gone once the run ends.
     */
    @Test
    fun aRunWithoutTheForegroundServiceLeavesNoNotification() {
        val wm = WorkManager.getInstance(ctx)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        FgNotice.denyForegroundForTest = true
        try {
            val r = OneTimeWorkRequestBuilder<FgTestWorker>()
                .setInputData(Data.Builder().putString("title", "Q").putInt("id", 4797).putInt("steps", 6).putLong("hold", 1_500).putString("mode", "notice").build()).build()
            wm.enqueue(r)
            assertTrue("reached its last count", waitUntil { wm.getWorkInfoById(r.id).get()?.progress?.getInt("step", 0) == 6 })
            val during = nm.activeNotifications.firstOrNull { it.id == 4797 }
            assertEquals("shown during the run", "Q 6 z 6", during?.notification?.extras?.getCharSequence(NotificationCompat.EXTRA_TITLE)?.toString())
            assertTrue("not ongoing without the service", during!!.notification.flags and android.app.Notification.FLAG_ONGOING_EVENT == 0)
            assertTrue("finished", waitUntil { wm.getWorkInfoById(r.id).get()?.state == WorkInfo.State.SUCCEEDED })
            assertTrue("gone after the run", waitUntil(5_000) { nm.activeNotifications.none { it.id == 4797 } })
        } finally { FgNotice.denyForegroundForTest = false }
    }

    /** At most one update a second (Android drops a package's updates above 5 a second). */
    @Test
    fun updatesAreThrottled() {
        var built = 0
        val n = FgNotice(ctx, 4796, minGapMs = 1000, setForeground = null) { built++; android.app.Notification.Builder(ctx, DdnBackup.NOTIF_CHANNEL).setSmallIcon(R.drawable.ic_sync).build() }
        val t0 = System.currentTimeMillis()
        while (System.currentTimeMillis() - t0 < 2_500) { n.update(); Thread.sleep(5) }
        n.end()
        assertTrue("about one a second, not hundreds: $built", built in 2..4)
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

    private var text = ""
    private val notice by lazy {
        FgNotice(this, inputData.getInt("id", 0), minGapMs = 0) { ongoing ->
            NotificationCompat.Builder(applicationContext, DdnBackup.NOTIF_CHANNEL).setSmallIcon(R.drawable.ic_sync).setContentTitle(text).setOngoing(ongoing).setOnlyAlertOnce(true).build()
        }
    }

    override suspend fun doWork(): Result {
        val title = inputData.getString("title")!!
        val steps = inputData.getInt("steps", 0)
        val viaNotice = inputData.getString("mode") == "notice"
        text = if (steps == 0) title else "$title 0 z $steps"
        info(text) // the channel
        if (viaNotice) notice.start() else setForeground(info(text))
        try {
            for (i in 1..steps) {
                delay(400)
                text = "$title $i z $steps"
                if (viaNotice) notice.update() else setForeground(info(text))
                setProgress(Data.Builder().putInt("step", i).build())
            }
            delay(inputData.getLong("hold", 0))
        } finally { if (viaNotice) notice.end() }
        return Result.success()
    }
}
