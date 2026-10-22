package io.github.magiszonekk.discordrive.syncjs

/**
 * One JavaScript context. [evaluate] runs a script in it and returns the value of its last expression as a
 * string (null for undefined/null). Globals persist between calls. Calls block: never call from the main
 * thread. Implementations: [QuickJsEngine] (embedded, synchronous) and [V8Engine] (the system WebView's
 * isolated V8 sandbox), so the engine can be swapped without touching the callers.
 */
interface JsEngine : AutoCloseable {
    /** Short label for logs and measurements, e.g. "quickjs" or "v8-sandbox". */
    val name: String

    fun evaluate(script: String): String?
}

class JsEngineException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
