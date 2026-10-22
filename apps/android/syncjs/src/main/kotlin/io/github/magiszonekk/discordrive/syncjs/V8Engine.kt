package io.github.magiszonekk.discordrive.syncjs

import io.github.magiszonekk.discordrive.core.JsEngine
import io.github.magiszonekk.discordrive.core.JsEngineException
import android.content.Context
import androidx.javascriptengine.IsolateStartupParameters
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import java.util.concurrent.TimeUnit

/**
 * V8 from the system WebView, in its isolated sandbox process (androidx.javascriptengine). Faster than
 * QuickJS (JIT), but every call crosses a process boundary and it needs a WebView that supports it
 * ([isSupported]). The calls here wait for the asynchronous results, so the interface stays synchronous.
 *
 * Only one sandbox process may exist at a time: every engine is an isolate of one shared sandbox, which is
 * closed when the last isolate is.
 */
class V8Engine private constructor(private val isolate: JavaScriptIsolate, private val timeoutMs: Long) : JsEngine {
    override val name = "v8-sandbox"
    private var closed = false

    override fun evaluate(script: String): String? =
        try {
            isolate.evaluateJavaScriptAsync(script).get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            throw JsEngineException("V8 sandbox: ${e.cause?.message ?: e.message}", e)
        }

    override fun close() {
        if (closed) return
        closed = true
        isolate.close()
        release()
    }

    companion object {
        private var sandbox: JavaScriptSandbox? = null
        private var users = 0

        fun isSupported(): Boolean = JavaScriptSandbox.isSupported()

        @Synchronized
        fun create(context: Context, timeoutMs: Long = 120_000): V8Engine {
            val sb = sandbox ?: JavaScriptSandbox.createConnectedInstanceAsync(context.applicationContext).get(timeoutMs, TimeUnit.MILLISECONDS).also { sandbox = it }
            val params = IsolateStartupParameters()
            if (sb.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE)) params.maxHeapSizeBytes = 512L * 1024 * 1024
            val iso = try {
                sb.createIsolate(params)
            } catch (e: Exception) {
                if (users == 0) {
                    sb.close()
                    sandbox = null
                }
                throw e
            }
            users++
            return V8Engine(iso, timeoutMs)
        }

        @Synchronized
        private fun release() {
            users = maxOf(0, users - 1)
            if (users == 0) {
                sandbox?.close()
                sandbox = null
            }
        }
    }
}
