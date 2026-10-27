package com.discordrive.gallery

import android.content.Context

/**
 * The count shown by the upload notification ("X of Y"), kept for a whole series of runs.
 *
 * A big automatic copy takes many runs: each one stops after its time budget and queues the next, a new photo
 * or the periodic job starts another. Counting inside one run made every run start again at "0 of <what is
 * left>". The series lives in the app's preferences instead: a run that starts while a series is open adds to
 * it (done stays, total = done + what is left now), the series closes when a run ends with nothing waiting.
 * A series left untouched for [STALE_MS] (no network for days, a file that always fails) starts again at 0.
 */
class BackupSeries(private val store: Store, private val now: () -> Long = System::currentTimeMillis) {
    /** Where the series is kept (SharedPreferences in the app, a map in tests). */
    interface Store {
        fun getInt(k: String): Int
        fun getLong(k: String): Long
        fun getString(k: String): String?
        fun getBoolean(k: String): Boolean
        fun put(values: Map<String, Any?>)
    }

    data class State(val done: Int, val total: Int)

    val done get() = store.getInt(K_DONE)
    val total get() = store.getInt(K_TOTAL)
    val open get() = store.getBoolean(K_OPEN)
    fun state() = State(done, maxOf(total, done))

    /** A run starts with [remaining] files to send (queue + media not copied yet) for [account]. */
    fun start(account: String, remaining: Int): State {
        val continues = open && store.getString(K_ACCOUNT) == account && now() - store.getLong(K_AT) < STALE_MS
        val d = if (continues) done else 0
        store.put(mapOf(K_DONE to d, K_TOTAL to d + remaining, K_OPEN to (remaining > 0), K_ACCOUNT to account, K_AT to now()))
        return state()
    }

    /** One file of the run is done (sent, or found already in the account). */
    fun step(): State {
        val d = done + 1
        store.put(mapOf(K_DONE to d, K_TOTAL to maxOf(total, d), K_AT to now()))
        return state()
    }

    /** The run ended with [waiting] files left: none closes the series (the next one starts at 0). */
    fun end(waiting: Int) {
        store.put(mapOf(K_OPEN to (waiting > 0), K_AT to now()))
    }

    companion object {
        const val STALE_MS = 12 * 3600_000L
        private const val K_DONE = "ser_done"
        private const val K_TOTAL = "ser_total"
        private const val K_OPEN = "ser_open"
        private const val K_ACCOUNT = "ser_account"
        private const val K_AT = "ser_at"

        /** The app's series (the automatic copy's preferences). */
        fun of(c: Context): BackupSeries {
            val p = c.getSharedPreferences("ddn-backup-series", Context.MODE_PRIVATE)
            return BackupSeries(object : Store {
                override fun getInt(k: String) = p.getInt(k, 0)
                override fun getLong(k: String) = p.getLong(k, 0)
                override fun getString(k: String) = p.getString(k, null)
                override fun getBoolean(k: String) = p.getBoolean(k, false)
                override fun put(values: Map<String, Any?>) {
                    p.edit().apply {
                        for ((k, v) in values) when (v) {
                            is Int -> putInt(k, v); is Long -> putLong(k, v); is Boolean -> putBoolean(k, v)
                            is String -> putString(k, v); null -> remove(k)
                        }
                    }.apply()
                }
            })
        }
    }
}
