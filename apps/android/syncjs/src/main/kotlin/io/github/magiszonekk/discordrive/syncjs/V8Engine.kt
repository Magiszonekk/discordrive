package io.github.magiszonekk.discordrive.syncjs

import android.content.Context
import androidx.javascriptengine.IsolateStartupParameters
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import java.util.concurrent.TimeUnit

/**
 * V8 from the system WebView, in its isolated sandbox process (androidx.javascriptengine). Faster than
 * QuickJS (JIT), but every call crosses a process boundary and it needs a WebView that supports it
 * ([isSupported]). The calls here wait for the asynchronous results, so the interface stays synchronous.
 */
class V8Engine private constructor(
    private val sandbox: JavaScriptSandbox,
    private val isolate: JavaScriptIsolate,
    private val timeoutMs: Long,
) : JsEngine {
    override val name = "v8-sandbox"

    override fun evaluate(script: String): String? =
        try {
            isolate.evaluateJavaScriptAsync(script).get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            throw JsEngineException("V8 sandbox: ${e.cause?.message ?: e.message}", e)
        }

    override fun close() {
        isolate.close()
        sandbox.close()
    }

    companion object {
        fun isSupported(): Boolean = JavaScriptSandbox.isSupported()

        fun create(context: Context, timeoutMs: Long = 120_000): V8Engine {
            val sandbox = JavaScriptSandbox.createConnectedInstanceAsync(context.applicationContext)
                .get(timeoutMs, TimeUnit.MILLISECONDS)
            val params = IsolateStartupParameters()
            if (sandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE)) {
                params.maxHeapSizeBytes = 512L * 1024 * 1024
            }
            return V8Engine(sandbox, sandbox.createIsolate(params), timeoutMs)
        }
    }
}
