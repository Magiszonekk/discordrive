package com.discordrive.gallery

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Shared pause/progress state for the sync, so the live notification (and its
 * Pause/Resume actions) can talk to the running pass. Also serializes syncs:
 * only one (manual OR background worker) runs at a time — [tryBegin] returns
 * false if one is already in progress, which prevents two passes from fighting
 * over the same notification (the "jumping between two values" bug).
 */
object SyncController {

    private val running = AtomicBoolean(false)

    @Volatile var paused: Boolean = false
        private set

    /** User asked to cancel the running job; loops break, awaitIfPaused exits. */
    @Volatile var cancelled: Boolean = false
        private set

    // Last progress snapshot (for the notification to render on pause/resume).
    // [label] = job title ("Synchronizacja" / "Analiza AI"); [detail] = right-side
    // text (upload speed for sync, "N nowych" for AI).
    @Volatile var done: Int = 0
    @Volatile var total: Int = 0
    @Volatile var label: String = ""
    @Volatile var detail: String = ""
    @Volatile var active: Boolean = false

    fun pause() { paused = true; detail = "" }
    fun resume() { paused = false }
    fun cancel() { cancelled = true; paused = false; detail = "" }

    /** Atomically claims the job slot; false if a sync/AI job is already running. */
    fun tryBegin(): Boolean {
        if (!running.compareAndSet(false, true)) return false
        paused = false; cancelled = false; done = 0; total = 0; label = ""; detail = ""; active = true
        return true
    }

    fun end() { active = false; paused = false; cancelled = false; detail = ""; running.set(false) }

    fun update(done: Int, total: Int, label: String, detail: String) {
        this.done = done
        this.total = total
        this.label = label
        this.detail = detail
    }

    /** Blocks the worker thread while paused (polled); returns immediately on cancel. */
    fun awaitIfPaused() {
        while (paused && !cancelled) {
            try {
                Thread.sleep(300)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }
}
