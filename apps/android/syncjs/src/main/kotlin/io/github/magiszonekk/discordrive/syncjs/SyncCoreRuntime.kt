package io.github.magiszonekk.discordrive.syncjs

import io.github.magiszonekk.discordrive.core.JsEngine
import io.github.magiszonekk.discordrive.core.JsEngineException
import android.content.Context

/**
 * The sync core loaded into a [JsEngine]. Log entries go in and come out as JSON strings: the core's own
 * JSON is the wire format, so nothing is re-encoded on the Kotlin side.
 *
 * The core needs no host APIs (no TextEncoder, crypto, timers or Intl during apply): hashing and
 * encryption stay native on the phone, the engine only runs the rules.
 */
class SyncCoreRuntime(val engine: JsEngine, bundle: String) : AutoCloseable {

    init {
        engine.evaluate(bundle)
        engine.evaluate(GLUE)
        val loaded = engine.evaluate("typeof SyncCore.applyEntry")
        if (loaded != "function") throw JsEngineException("sync core did not load in ${engine.name} ($loaded)")
    }

    /** RULES_VERSION of the loaded core. */
    val rulesVersion: Int = engine.evaluate("String(SyncCore.RULES_VERSION)")!!.toInt()

    /** Replays a whole log (a JSON array of log entries) into a fresh index; returns its canonical state. */
    fun replayCanonical(logJson: String): String =
        engine.evaluate("__ddn.replayCanonical($logJson)") ?: throw JsEngineException("no state from ${engine.name}")

    /** Milliseconds the engine itself spent in [replayCanonical] calls since the last reset (its own clock). */
    fun takeEngineMs(): Long = engine.evaluate("__ddn.takeMs()")!!.toDouble().toLong()

    override fun close() = engine.close()

    companion object {
        const val ASSET = "sync-core.js"

        fun loadBundle(context: Context): String = context.assets.open(ASSET).bufferedReader().use { it.readText() }

        // `globalThis.__ddn` is the only global the glue adds next to `SyncCore`.
        private const val GLUE = """
globalThis.__ddn = (function () {
  var ms = 0;
  return {
    replayCanonical: function (log) {
      var t = Date.now();
      var st = SyncCore.initIndex(new SyncCore.MemoryIndexStore());
      for (var i = 0; i < log.length; i++) SyncCore.applyEntry(st, log[i]);
      var out = SyncCore.canonicalState(st);
      ms += Date.now() - t;
      return out;
    },
    takeMs: function () { var m = ms; ms = 0; return String(m); }
  };
})();
"ok"
"""
    }
}
