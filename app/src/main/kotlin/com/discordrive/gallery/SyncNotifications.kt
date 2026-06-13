package com.discordrive.gallery

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.text.format.Formatter
import androidx.core.app.NotificationCompat

/** Live "background sync" notification with progress, speed and Pause/Resume. */
object SyncNotifications {

    const val CHANNEL_ID = "sync"
    const val NOTIF_ID = 42001

    fun ensureChannel(context: Context) {
        val mgr = context.getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, context.getString(R.string.sync_notif_channel), NotificationManager.IMPORTANCE_LOW)
                    .apply { setShowBadge(false) },
            )
        }
    }

    fun build(context: Context): Notification {
        val done = SyncController.done
        val total = SyncController.total
        val paused = SyncController.paused

        val title = context.getString(if (paused) R.string.sync_notif_paused else R.string.sync_notif_title)
        val text = buildString {
            if (total > 0) append(context.getString(R.string.sync_notif_progress, done, total))
            if (!paused && SyncController.bytesPerSec > 0) {
                if (isNotEmpty()) append("  ·  ")
                append("↑ ").append(Formatter.formatShortFileSize(context, SyncController.bytesPerSec)).append("/s")
            }
        }

        val action = if (paused) {
            NotificationCompat.Action(0, context.getString(R.string.sync_notif_resume), broadcast(context, SyncActionReceiver.ACTION_RESUME))
        } else {
            NotificationCompat.Action(0, context.getString(R.string.sync_notif_pause), broadcast(context, SyncActionReceiver.ACTION_PAUSE))
        }

        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_sync)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(contentIntent(context))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(total.coerceAtLeast(1), done, total == 0)
            .addAction(action)
            .build()
    }

    /** Re-renders the notification (used by the action receiver for instant feedback). */
    fun refresh(context: Context) {
        if (!SyncController.active) return
        context.getSystemService(NotificationManager::class.java).notify(NOTIF_ID, build(context))
    }

    private fun contentIntent(context: Context): PendingIntent =
        PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun broadcast(context: Context, action: String): PendingIntent =
        PendingIntent.getBroadcast(
            context, action.hashCode(),
            Intent(context, SyncActionReceiver::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}

/**
 * Drives the live sync notification from SyncRunner progress: computes a rolling
 * upload speed and refreshes the notification at most ~once/second. Shared by the
 * background worker (foreground service) and the in-app manual sync.
 */
class SyncProgressTracker(private val context: Context) {
    private var lastBytes = 0L
    private var lastTimeMs = System.currentTimeMillis()
    private var lastNotifyMs = 0L

    fun onProgress(p: SyncRunner.Progress) {
        val now = System.currentTimeMillis()
        if (now - lastNotifyMs < 1000) return
        val dtMs = (now - lastTimeMs).coerceAtLeast(1)
        val speed = ((p.bytesDone - lastBytes) * 1000 / dtMs).coerceAtLeast(0)
        lastBytes = p.bytesDone
        lastTimeMs = now
        lastNotifyMs = now
        SyncController.update(p.done, p.total, speed)
        SyncNotifications.refresh(context)
    }
}
