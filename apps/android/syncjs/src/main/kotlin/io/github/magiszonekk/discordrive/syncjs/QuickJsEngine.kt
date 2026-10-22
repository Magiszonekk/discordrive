package io.github.magiszonekk.discordrive.syncjs

import io.github.magiszonekk.discordrive.core.JsEngine
import io.github.magiszonekk.discordrive.core.JsEngineException
import com.whl.quickjs.android.QuickJSLoader
import com.whl.quickjs.wrapper.QuickJSContext

/**
 * QuickJS embedded in the app (native library, no WebView needed, works in a background worker).
 * A QuickJS context is bound to the thread that created it: create, use and close it on one thread.
 */
class QuickJsEngine : JsEngine {
    override val name = "quickjs"

    private val context: QuickJSContext

    init {
        loadNative()
        context = QuickJSContext.create()
    }

    override fun evaluate(script: String): String? =
        try {
            context.evaluate(script)?.toString()
        } catch (e: Exception) {
            throw JsEngineException("QuickJS: ${e.message}", e)
        }

    override fun close() {
        context.destroy()
    }

    private companion object {
        @Volatile
        private var loaded = false

        @Synchronized
        fun loadNative() {
            if (!loaded) {
                QuickJSLoader.init()
                loaded = true
            }
        }
    }
}
