package com.discordrive.gallery

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Handles the Pause/Resume buttons on the background-sync notification. */
class SyncActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_PAUSE -> SyncController.pause()
            ACTION_RESUME -> SyncController.resume()
        }
        // Instant feedback — the worker is blocked while paused so it can't refresh itself.
        SyncNotifications.refresh(context)
    }

    companion object {
        const val ACTION_PAUSE = "com.discordrive.gallery.SYNC_PAUSE"
        const val ACTION_RESUME = "com.discordrive.gallery.SYNC_RESUME"
    }
}
