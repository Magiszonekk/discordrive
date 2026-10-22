package io.github.magiszonekk.discordrive.syncjs

import io.github.magiszonekk.discordrive.core.IndexReplica
import io.github.magiszonekk.discordrive.core.JsEngine
import io.github.magiszonekk.discordrive.core.JsEngineException
import io.github.magiszonekk.discordrive.core.Snapshots
import io.github.magiszonekk.discordrive.core.json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/**
 * The account's index kept inside the JS engine (the sync core's MemoryIndexStore): log entries and
 * snapshots go in as JSON, small answers come back. Every call is one engine evaluation with a bounded
 * payload (entries and snapshot parts in slices), so the V8 sandbox's per-call limits are never reached.
 */
class JsIndexReplica(private val engine: JsEngine) : IndexReplica {

    init {
        engine.evaluate(GLUE)
    }

    private fun call(expr: String): String = engine.evaluate(expr) ?: throw JsEngineException("no answer from ${engine.name}")

    override val rulesVersion: Int get() = call("String(SyncCore.RULES_VERSION)").toInt()
    override val headSeq: Long get() = call("__ddnIx.head()").toLong()

    override fun reset() {
        call("__ddnIx.reset()")
    }

    override fun loadSnapshotText(slices: Sequence<String>): Long {
        call("__ddnIx.textBegin()")
        for (s in slices) call("__ddnIx.textPart(${json.encodeToString(JsonElement.serializer(), JsonPrimitive(s))})")
        return call("__ddnIx.textEnd()").toLong()
    }

    override fun apply(entries: List<JsonObject>): IndexReplica.ApplySummary {
        val results = ArrayList<JsonObject>()
        val outcomes = HashMap<String, Int>()
        for (s in Snapshots.slices(JsonArray(entries))) {
            val r = json.parseToJsonElement(call("__ddnIx.apply($s)")).jsonObject
            for (x in r.getValue("results").jsonArray) results += x.jsonObject
            for ((k, v) in r.getValue("outcomes").jsonObject) outcomes[k] = (outcomes[k] ?: 0) + v.jsonPrimitive.int
        }
        return IndexReplica.ApplySummary(headSeq, outcomes, results)
    }

    override fun leaseGuard(op: JsonObject): List<String> =
        json.parseToJsonElement(call("JSON.stringify(SyncCore.uploadsTouched(${json.encodeToString(JsonElement.serializer(), op)}))")).jsonArray.map { it.jsonPrimitive.content }

    /** The canonical state is hashed on the Kotlin side (the engine has no SHA-256); fetched in slices. */
    override fun stateSha256(): String {
        val n = call("__ddnIx.stateBegin()").toInt()
        val md = java.security.MessageDigest.getInstance("SHA-256")
        var i = 0
        while (i < n) {
            val part = call("__ddnIx.statePart($i, $CHUNK)")
            md.update(part.toByteArray(Charsets.UTF_8))
            i += CHUNK
        }
        call("__ddnIx.stateEnd()")
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    override fun children(parentId: String): List<IndexReplica.Child> =
        json.parseToJsonElement(call("__ddnIx.children(${json.encodeToString(JsonElement.serializer(), kotlinx.serialization.json.JsonPrimitive(parentId))})")).jsonArray.map {
            val o = it.jsonObject
            IndexReplica.Child(o.getValue("id").jsonPrimitive.content, o.getValue("name").jsonPrimitive.content, o.getValue("kind").jsonPrimitive.content, o["size"]?.jsonPrimitive?.let { p -> if (p.content == "null") null else p.long })
        }

    override fun close() = engine.close()

    private companion object {
        /** Characters per slice of the canonical state (UTF-16 units: never splits a surrogate pair, see statePart). */
        const val CHUNK = 200_000

        const val GLUE = """
globalThis.__ddnIx = (function () {
  var S = SyncCore, st = S.initIndex(new S.MemoryIndexStore()), snap = null, state = null;
  return {
    reset: function () { st = S.initIndex(new S.MemoryIndexStore()); return "ok"; },
    head: function () { return String(st.getMeta().headSeq); },
    textBegin: function () { snap = []; return "ok"; },
    textPart: function (t) { snap.push(t); return "ok"; },
    textEnd: function () {
      var parsed = JSON.parse(snap.join(""));
      snap = null;
      st = S.loadSnapshot(parsed, new S.MemoryIndexStore());
      return String(st.getMeta().headSeq);
    },
    apply: function (es) {
      var res = [], oc = {};
      for (var i = 0; i < es.length; i++) {
        var r = S.applyEntry(st, es[i]);
        oc[r.outcome] = (oc[r.outcome] || 0) + 1;
        res.push(r);
      }
      return JSON.stringify({ results: res, outcomes: oc });
    },
    stateBegin: function () { state = S.canonicalState(st); return String(state.length); },
    statePart: function (i, n) {
      // A slice must not end between the two halves of a surrogate pair (it would not encode to UTF-8).
      var end = Math.min(state.length, i + n);
      var c = state.charCodeAt(end - 1);
      if (end < state.length && c >= 0xd800 && c <= 0xdbff) end++;
      var from = i;
      var p = state.charCodeAt(i);
      if (i > 0 && p >= 0xdc00 && p <= 0xdfff) from++;
      return state.slice(from, end);
    },
    stateEnd: function () { state = null; return "ok"; },
    children: function (pid) {
      var out = [], ids = st.childIds(pid);
      for (var id of ids) {
        var n = st.getNode(id);
        if (!n || n.trashed) continue;
        out.push({ id: n.id, name: n.name, kind: n.kind, size: n.content ? n.content.sizeBytes : null });
      }
      out.sort(function (a, b) { return a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === "folder" ? -1 : 1; });
      return JSON.stringify(out);
    }
  };
})();
"ok"
"""
    }
}
