package io.github.magiszonekk.discordrive.syncjs

import io.github.magiszonekk.discordrive.core.JsEngine
import io.github.magiszonekk.discordrive.core.JsEngineException
import android.content.Context
import org.json.JSONObject
import java.security.MessageDigest

/** sync-vectors.txt: a JSON header line, then "<sha256 of Node's canonical state> <log JSON>" per log. */
class Vectors(val header: JSONObject, val cases: List<Pair<String, String>>) {
    val entries: Int get() = header.getInt("entries")

    companion object {
        fun load(context: Context): Vectors {
            val lines = context.assets.open("sync-vectors.txt").bufferedReader().use { it.readLines() }.filter { it.isNotEmpty() }
            val cases = lines.drop(1).map { it.substring(0, 64) to it.substring(65) }
            return Vectors(JSONObject(lines.first()), cases)
        }
    }
}

fun sha256Hex(s: String): String =
    MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

/** Engines to test: QuickJS always, V8 when this device's WebView offers the sandbox. */
fun engines(context: Context): List<() -> JsEngine> = buildList {
    add { QuickJsEngine() }
    if (V8Engine.isSupported()) add { V8Engine.create(context) }
}
