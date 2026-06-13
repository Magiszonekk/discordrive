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

    // Last progress snapshot (for the notification to render on pause/resume).
    @Volatile var done: Int = 0
    @Volatile var total: Int = 0
    @Volatile var bytesPerSec: Long = 0
    @Volatile var active: Boolean = false

    fun pause() { paused = true; bytesPerSec = 0 }
    fun resume() { paused = false }

    /** Atomically claims the sync slot; false if a sync is already running. */
    fun tryBegin(): Boolean {
        if (!running.compareAndSet(false, true)) return false
        paused = false; done = 0; total = 0; bytesPerSec = 0; active = true
        return true
    }

    fun end() { active = false; paused = false; bytesPerSec = 0; running.set(false) }

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
