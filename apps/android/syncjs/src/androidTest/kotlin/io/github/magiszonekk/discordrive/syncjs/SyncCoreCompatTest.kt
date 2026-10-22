package io.github.magiszonekk.discordrive.syncjs

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The phone must reach exactly the state Node reaches from the same operation logs (random logs of the
 * sync-core simulator: concurrent devices, conflicts, trash, uploads, snapshots). Any difference means the
 * phone would show another tree than the other devices, so it fails the build.
 */
@RunWith(AndroidJUnit4::class)
class SyncCoreCompatTest {
    private val context = InstrumentationRegistry.getInstrumentation().context

    @Test
    fun bundleInTheAppIsTheOneTheVectorsWereMadeWith() {
        val vectors = Vectors.load(context)
        assertEquals(
            "sync-core.js in the app differs from the bundle the vectors were generated with: run packages/sync-core/scripts/android-assets.ts",
            vectors.header.getString("bundleSha256"),
            sha256Hex(SyncCoreRuntime.loadBundle(context)),
        )
    }

    @Test
    fun sameStateAsNodeInEveryEngine() {
        val vectors = Vectors.load(context)
        val bundle = SyncCoreRuntime.loadBundle(context)
        for (make in engines(context)) {
            val s0 = System.nanoTime()
            SyncCoreRuntime(make(), bundle).use { core ->
                // Engine start + loading the bundle: what a background sync pays once per run.
                val startMs = (System.nanoTime() - s0) / 1_000_000
                assertEquals(vectors.header.getInt("rulesVersion"), core.rulesVersion)
                core.takeEngineMs()
                val t0 = System.nanoTime()
                var mismatches = 0
                vectors.cases.forEachIndexed { i, (want, log) ->
                    val got = sha256Hex(core.replayCanonical(log))
                    if (got != want) {
                        mismatches++
                        Log.e(TAG, "${core.engine.name}: case $i state $got, Node $want")
                    }
                }
                val wallMs = (System.nanoTime() - t0) / 1_000_000
                val result = JSONObject()
                    .put("test", "compat")
                    .put("engine", core.engine.name)
                    .put("startMs", startMs)
                    .put("cases", vectors.cases.size)
                    .put("entries", vectors.entries)
                    .put("mismatches", mismatches)
                    .put("engineMs", core.takeEngineMs())
                    .put("wallMs", wallMs)
                    .put("nodeReplayMs", vectors.header.optInt("nodeReplayMs"))
                Log.i(TAG, "RESULT $result")
                assertEquals("${core.engine.name}: cases with a state different from Node", 0, mismatches)
            }
        }
    }

    companion object {
        const val TAG = "ddn-syncjs"
    }
}
