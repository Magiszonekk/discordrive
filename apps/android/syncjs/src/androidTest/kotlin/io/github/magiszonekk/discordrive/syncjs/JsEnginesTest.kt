package io.github.magiszonekk.discordrive.syncjs

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** The app's engine choice: V8 where the WebView offers the sandbox, QuickJS elsewhere; the core loads in it. */
@RunWith(AndroidJUnit4::class)
class JsEnginesTest {
    private val context = InstrumentationRegistry.getInstrumentation().context

    @Test
    fun picksV8WhenSupportedAndLoadsTheCore() {
        JsEngines.openSyncCore(context).use { core ->
            assertEquals(if (V8Engine.isSupported()) "v8-sandbox" else "quickjs", core.engine.name)
            assertEquals(Vectors.load(context).header.getInt("rulesVersion"), core.rulesVersion)
        }
    }
}
