package com.discordrive.gallery

/**
 * Shared pause/progress state for the background sync, so the live notification
 * (and its Pause/Resume actions) can talk to the running worker. The worker
 * polls [awaitIfPaused] between assets; the notification receiver flips
 * [paused] and re-renders using the last [done]/[total]/[bytesPerSec] snapshot.
 */
object SyncController {

    @Volatile var paused: Boolean = false
        private set

    // Last progress snapshot (for the notification to render on pause/resume).
    @Volatile var done: Int = 0
    @Volatile var total: Int = 0
    @Volatile var bytesPerSec: Long = 0
    @Volatile var active: Boolean = false

    fun pause() { paused = true; bytesPerSec = 0 }
    fun resume() { paused = false }

    fun begin() { paused = false; done = 0; total = 0; bytesPerSec = 0; active = true }
    fun end() { active = false; paused = false; bytesPerSec = 0 }

    fun update(done: Int, total: Int, bytesPerSec: Long) {
        this.done = done
        this.total = total
        this.bytesPerSec = bytesPerSec
    }

    /** Blocks the worker thread while paused (polled, interrupt-safe). */
    fun awaitIfPaused() {
        while (paused) {
            try {
                Thread.sleep(300)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }
}
