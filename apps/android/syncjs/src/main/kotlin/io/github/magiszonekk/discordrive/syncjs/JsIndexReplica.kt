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
        rows(call("__ddnIx.children(${json.encodeToString(JsonElement.serializer(), JsonPrimitive(parentId))})"))

    override fun media(extensions: List<String>, limit: Int, after: Pair<Long, String>?): List<IndexReplica.Child> {
        val ext = json.encodeToString(JsonElement.serializer(), JsonArray(extensions.map { JsonPrimitive(it) }))
        val a = if (after == null) "null" else "[${after.first}, ${json.encodeToString(JsonElement.serializer(), JsonPrimitive(after.second))}]"
        return rows(call("__ddnIx.media($ext, $limit, $a)"))
    }

    override fun node(id: String): IndexReplica.Child? =
        rows(call("__ddnIx.node(${json.encodeToString(JsonElement.serializer(), JsonPrimitive(id))})")).firstOrNull()

    override fun trash(): List<IndexReplica.Child> = rows(call("__ddnIx.trash()"))

    override fun albums(extensions: List<String>): List<IndexReplica.Album> {
        val ext = json.encodeToString(JsonElement.serializer(), JsonArray(extensions.map { JsonPrimitive(it) }))
        return json.parseToJsonElement(call("__ddnIx.albums($ext)")).jsonArray.map {
            val o = it.jsonObject
            IndexReplica.Album(o.getValue("id").jsonPrimitive.content, o.getValue("name").jsonPrimitive.content, o.getValue("count").jsonPrimitive.int, rows("[" + o.getValue("cover").toString() + "]").first())
        }
    }

    override fun released(afterSeq: Long): List<Triple<String, Long, Long>> =
        json.parseToJsonElement(call("__ddnIx.released($afterSeq)")).jsonArray.map { val x = it.jsonArray; Triple(x[0].jsonPrimitive.content, x[1].jsonPrimitive.long, x[2].jsonPrimitive.long) }

    override fun expiredTrash(nowServerMs: Long): List<String> =
        json.parseToJsonElement(call("__ddnIx.expired($nowServerMs)")).jsonArray.map { it.jsonPrimitive.content }

    override fun snapshotText(): Sequence<String> = sequence {
        val n = call("__ddnIx.snapText()").toInt()
        var at = 0
        while (at < n) {
            yield(call("__ddnIx.textSlice($at, $CHUNK)"))
            at += CHUNK
        }
        call("__ddnIx.textDone()")
    }

    private fun rows(text: String): List<IndexReplica.Child> = json.parseToJsonElement(text).jsonArray.map {
        val o = it.jsonObject
        fun s(k: String) = o[k]?.jsonPrimitive?.takeIf { p -> p.isString }?.content
        IndexReplica.Child(
            id = s("id")!!, name = s("name")!!, kind = s("kind")!!,
            size = o["size"]?.jsonPrimitive?.content?.toLongOrNull(),
            manifestRef = s("ref"), sha256 = s("sha"),
            createdAt = o["at"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0, parentId = s("parent"),
            trashedAt = o["tat"]?.jsonPrimitive?.content?.toLongOrNull(), uploadId = s("up"),
        )
    }

    override fun close() = engine.close()

    private companion object {
        /** Characters per slice of the canonical state (UTF-16 units: never splits a surrogate pair, see statePart). */
        const val CHUNK = 200_000

        const val GLUE = """
globalThis.__ddnIx = (function () {
  var S = SyncCore, st = S.initIndex(new S.MemoryIndexStore()), snap = null, state = null, mediaCache = null;
  function row(n) {
    var c = n.content;
    return { id: n.id, name: n.name, kind: n.kind, parent: n.parentId, size: c ? c.sizeBytes : null, ref: c ? c.manifestRef : null, sha: c ? c.plaintextSha256 : null, at: c ? c.createdAt : 0, up: c ? c.uploadId : null };
  }
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
    // One node; "tat" is set when it is in the trash (itself or inside a trashed folder: 0 then).
    node: function (id) {
      var n = st.getNode(id);
      if (!n) return "[]";
      var r = row(n);
      if (S.inTrash(st, n.id)) r.tat = n.trashed ? n.trashed.at : 0;
      return JSON.stringify([r]);
    },
    snapText: function () { state = JSON.stringify(S.takeSnapshot(st)); return String(state.length); },
    textSlice: function (i, n) { return this.statePart(i, n); },
    textDone: function () { state = null; return "ok"; },
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
        out.push(row(n));
      }
      out.sort(function (a, b) { return a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === "folder" ? -1 : 1; });
      return JSON.stringify(out);
    },
    // Albums: the media list (built and kept by media()) grouped by folder; newest first.
    albums: function (exts) {
      this.media(exts, 0, null);
      var by = {}, order = [];
      for (var n of mediaCache.list) {
        var a = by[n.parentId];
        if (!a) { var f = st.getNode(n.parentId); if (!f) continue; a = by[n.parentId] = { id: f.id, name: f.name, count: 0, cover: row(n) }; order.push(a); }
        a.count++;
      }
      return JSON.stringify(order);
    },
    // The trash: nodes trashed themselves (inside a trashed folder they go with it), newest first.
    trash: function () {
      var out = [];
      for (var n of st.allNodes()) {
        if (!n.trashed || (n.parentId !== null && S.inTrash(st, n.parentId))) continue;
        var r = row(n); r.tat = n.trashed.at; out.push(r);
      }
      out.sort(function (a, b) { return b.tat - a.tat || (a.id < b.id ? -1 : 1); });
      return JSON.stringify(out);
    },
    expired: function (now) { return JSON.stringify(S.expiredTrash(st, now)); },
    released: function (after) {
      var out = [];
      for (var u of st.allUploads()) if (u.status === "released" && u.ended && u.ended.seq > after) out.push([u.id, u.ended.at, u.ended.seq]);
      out.sort(function (a, b) { return a[2] - b[2]; });
      return JSON.stringify(out);
    },
    // The Gallery: media files outside the trash, newest first. Built once per head and kept (sorted).
    media: function (exts, limit, after) {
      var head = st.getMeta().headSeq;
      if (!mediaCache || mediaCache.head !== head || mediaCache.key !== exts.join(",")) {
        var list = [];
        for (var n of st.allNodes()) {
          if (n.kind !== "file" || !n.content) continue;
          var lower = n.name.toLowerCase(), ok = false;
          for (var i = 0; i < exts.length; i++) if (lower.endsWith(exts[i])) { ok = true; break; }
          if (!ok || S.inTrash(st, n.id)) continue;
          list.push(n);
        }
        list.sort(function (a, b) { return b.content.createdAt - a.content.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
        mediaCache = { head: head, key: exts.join(","), list: list };
      }
      var l = mediaCache.list, from = 0;
      if (after) { while (from < l.length && (l[from].content.createdAt > after[0] || (l[from].content.createdAt === after[0] && l[from].id <= after[1]))) from++; }
      return JSON.stringify(l.slice(from, from + limit).map(row));
    }
  };
})();
"ok"
"""
    }
}
