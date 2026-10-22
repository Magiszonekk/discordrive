package io.github.magiszonekk.discordrive.syncjs

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.magiszonekk.discordrive.core.InteropScenario
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The interop scenario on the phone, with the index in the phone's own JS engine (V8 sandbox where the
 * WebView offers it, else QuickJS; -e ddnEngine quickjs forces QuickJS): pairing with the TypeScript client,
 * joining from the snapshot, the same state hash, operations it sees. Started by
 * apps/android/interop/harness.mts --device (adb reverse to the servers on the computer); skipped otherwise.
 */
@RunWith(AndroidJUnit4::class)
class InteropDeviceTest {
    @Test
    fun phoneJoinsByPairingAndWorksWithTheWebClient() {
        val args = InstrumentationRegistry.getArguments()
        val rpc = args.getString("ddnRpc")
        assumeTrue("started by apps/android/interop/harness.mts --device", rpc != null)
        val context = InstrumentationRegistry.getInstrumentation().context
        val bundle = SyncCoreRuntime.loadBundle(context)
        val forced = args.getString("ddnEngine")
        val open = { if (forced == "quickjs") QuickJsEngine() else JsEngines.open(context) }
        val engines = mutableSetOf<String>()
        val s = InteropScenario(rpc!!, args.getString("ddnServer")!!, args.getString("ddnDiscord")!!)
        val r = s.run({ val e = open(); engines += e.name; JsIndexReplica(SyncCoreRuntime(e, bundle).engine) }, "Pixel 7") { Log.i(SyncCoreCompatTest.TAG, it) }
        Log.i(SyncCoreCompatTest.TAG, "RESULT {\"test\":\"interop\",\"engines\":\"$engines\",\"ok\":${r.values.all { it }}}")
        assertTrue("interop checks ($engines): $r", r.values.all { it })
    }
}
