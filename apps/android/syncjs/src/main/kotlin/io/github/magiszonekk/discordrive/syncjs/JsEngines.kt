package io.github.magiszonekk.discordrive.syncjs

import android.content.Context
import android.util.Log

/**
 * The engine the app runs the sync core in: V8 from the system WebView (androidx.javascriptengine, about
 * 10x faster than QuickJS on a large account) when this device's WebView offers the isolated sandbox,
 * otherwise QuickJS embedded in the app. Both reach the same state (on-device compatibility test).
 */
object JsEngines {
    private const val TAG = "ddn-syncjs"

    /** Blocks (V8 starts a sandbox process): never call from the main thread. */
    fun open(context: Context): JsEngine {
        if (V8Engine.isSupported()) {
            try {
                return V8Engine.create(context)
            } catch (e: Exception) {
                // An outdated or broken WebView: QuickJS gives the same result, only slower.
                Log.w(TAG, "V8 sandbox unavailable, using QuickJS: ${e.message}")
            }
        }
        return QuickJsEngine()
    }

    /** The sync core loaded into [open]'s engine. */
    fun openSyncCore(context: Context): SyncCoreRuntime {
        val engine = open(context)
        return try {
            SyncCoreRuntime(engine, SyncCoreRuntime.loadBundle(context))
        } catch (e: Exception) {
            engine.close()
            if (engine is QuickJsEngine) throw e
            Log.w(TAG, "sync core failed in ${engine.name}, using QuickJS: ${e.message}")
            SyncCoreRuntime(QuickJsEngine(), SyncCoreRuntime.loadBundle(context))
        }
    }
}
