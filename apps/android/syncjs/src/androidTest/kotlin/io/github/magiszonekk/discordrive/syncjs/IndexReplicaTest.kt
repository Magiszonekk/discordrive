package io.github.magiszonekk.discordrive.syncjs

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.magiszonekk.discordrive.core.AccountKey
import io.github.magiszonekk.discordrive.core.B64
import io.github.magiszonekk.discordrive.core.OpCodec
import io.github.magiszonekk.discordrive.core.Snapshots
import io.github.magiszonekk.discordrive.core.json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The phone's index in the JS engine (JsIndexReplica) on what the web app writes: the snapshot base and
 * segment of account-vectors.json (made by the TypeScript code) opened in Kotlin, loaded into each engine,
 * the log tail decrypted here and applied there: the state hash must equal Node's. Then a large account
 * joined from a snapshot (load + tail), measured per engine.
 */
@RunWith(AndroidJUnit4::class)
class IndexReplicaTest {
    private val context = InstrumentationRegistry.getInstrumentation().context
    private val v = json.parseToJsonElement(context.assets.open("account-vectors.json").bufferedReader().readText()).jsonObject

    @Test
    fun webSnapshotAndTailGiveNodesState() {
        val acct = v.getValue("accountId").jsonPrimitive.content
        val key = AccountKey.fromB64(v.getValue("accountKeyB64").jsonPrimitive.content)
        val s = v.getValue("snapshots").jsonObject
        val objects = s.getValue("objects").jsonObject.mapValues { B64.dec(it.value.jsonPrimitive.content) }
        val p = Snapshots.openPointer(key, acct, objects.getValue(s.getValue("pointer").jsonObject.getValue("messageId").jsonPrimitive.content))
        val slices = Snapshots.baseSlices(key, acct, p.base!!, { objects.getValue(it.messageId) }, 777).toList()
        val codec = OpCodec(key, acct)
        val tail = s.getValue("log").jsonArray.map { codec.decrypt(it.jsonObject) }.filter { it.getValue("seq").jsonPrimitive.long > p.base!!.headSeq }
        val bundle = SyncCoreRuntime.loadBundle(context)
        for (make in engines(context)) {
            JsIndexReplica(SyncCoreRuntime(make(), bundle).engine).use { ix ->
                assertEquals(p.base!!.headSeq, ix.loadSnapshotText(slices.asSequence()))
                val r = ix.apply(tail)
                assertEquals(s.getValue("headSeq").jsonPrimitive.long, ix.headSeq)
                assertEquals(mapOf("applied" to tail.size), r.outcomes)
                assertEquals("${ix.toString()}: state", s.getValue("stateSha256AtHead").jsonPrimitive.content, ix.stateSha256())
                assertTrue(ix.children("root").any { it.name == "Dokumenty" })
            }
        }
    }

    /**
     * A large account joined from a snapshot: N files in folders of 200 (built in the engine, snapshot taken
     * there, as a base would be), streamed into a fresh replica in slices as the app does, then a tail of 500
     * entries; the state must equal the source's. -e ixFiles 50000 (default 5000).
     */
    @Test
    fun largeAccountFromSnapshot() {
        val n = (InstrumentationRegistry.getArguments().getString("ixFiles") ?: "5000").toInt()
        val bundle = SyncCoreRuntime.loadBundle(context)
        for (make in engines(context)) {
            val src = SyncCoreRuntime(make(), bundle)
            src.engine.evaluate(MAKE)
            val snapChars = src.engine.evaluate("__ddnMake($n, 200)")!!.toInt()
            // The snapshot leaves the source engine in slices (a V8 answer is capped at 20 MB).
            val snapSlices = sequence {
                var at = 0
                while (at < snapChars) {
                    yield(src.engine.evaluate("__ddnPart('snap', $at, 200000)")!!)
                    at += 200000
                }
            }
            val name = src.engine.name
            JsIndexReplica(SyncCoreRuntime(make(), bundle).engine).use { ix ->
                val t0 = System.nanoTime()
                val head = ix.loadSnapshotText(snapSlices)
                val t1 = System.nanoTime()
                val tail = json.parseToJsonElement(src.engine.evaluate("__ddnTail(500)")!!).jsonArray.map { it.jsonObject }
                val t2 = System.nanoTime()
                ix.apply(tail)
                val t3 = System.nanoTime()
                val sha = ix.stateSha256()
                val t4 = System.nanoTime()
                val wantLen = src.engine.evaluate("__ddnState()")!!.toInt()
                val md = java.security.MessageDigest.getInstance("SHA-256")
                var at = 0
                while (at < wantLen) {
                    md.update(src.engine.evaluate("__ddnPart('state', $at, 200000)")!!.toByteArray(Charsets.UTF_8))
                    at += 200000
                }
                val wantSha = md.digest().joinToString("") { "%02x".format(it) }
                val r = JSONObject().put("test", "join").put("engine", name).put("files", n).put("snapshotChars", snapChars).put("headAfterLoad", head)
                    .put("loadMs", (t1 - t0) / 1_000_000).put("tail", tail.size).put("tailMs", (t3 - t2) / 1_000_000).put("hashMs", (t4 - t3) / 1_000_000)
                Log.i(SyncCoreCompatTest.TAG, "RESULT $r")
                assertEquals("$name: state after snapshot + tail", wantSha, sha)
            }
            src.close()
        }
    }

    private companion object {
        // Builds an account in the engine (as the web app's tree would be), returns its snapshot as JSON;
        // __ddnTail continues the same log (renames) and returns those entries.
        const val MAKE = """
globalThis.__ddnMake = function (nFiles, perFolder) {
  var S = SyncCore, st = S.initIndex(new S.MemoryIndexStore()), dev = { id: "dev-bench", name: "bench" };
  globalThis.__ddnSt = st; globalThis.__ddnSeq = 0;
  function id(p, n) { return p + String(n).padStart(10, "0"); }
  globalThis.__ddnAdd = function (op, lg) {
    var q = ++globalThis.__ddnSeq;
    var e = { opId: id("op", q), rulesVersion: S.RULES_VERSION, baseSeq: q - 1, device: dev, createdAt: q, leaseGuard: lg, op: op, seq: q, serverTime: q };
    var r = S.applyEntry(st, e);
    if (r.outcome !== "applied") throw new Error("op " + q + ": " + r.outcome);
    return e;
  };
  var folder = null;
  for (var i = 0; i < nFiles; i++) {
    if (i % perFolder === 0) { folder = id("dir", i); __ddnAdd({ type: "create", kind: "folder", nodeId: folder, parentId: S.ROOT_ID, name: "Folder " + i }, []); }
    var u = id("upl", i);
    __ddnAdd({ type: "upload_begin", uploadId: u }, [u]);
    __ddnAdd({ type: "group", ops: [{ type: "upload_commit", uploadId: u }, { type: "create", kind: "file", nodeId: id("file", i), parentId: folder,
      name: "IMG_" + i + ".jpg", content: { versionId: id("ver", i), uploadId: u, sizeBytes: 3000000, manifestRef: "mf-" + i, chunkCount: 1,
      plaintextSha256: "0000000000000000000000000000000000000000000000000000000000000000" } }] }, [u]);
  }
  globalThis.__ddnTexts = { snap: JSON.stringify(S.takeSnapshot(st)) };
  return String(__ddnTexts.snap.length);
};
globalThis.__ddnState = function () { __ddnTexts.state = SyncCore.canonicalState(globalThis.__ddnSt); return String(__ddnTexts.state.length); };
// Slices never start or end inside a surrogate pair (the test names are ASCII, kept for safety).
globalThis.__ddnPart = function (k, i, n) {
  var s = __ddnTexts[k], end = Math.min(s.length, i + n), c = s.charCodeAt(end - 1), from = i, p = s.charCodeAt(i);
  if (end < s.length && c >= 0xd800 && c <= 0xdbff) end++;
  if (i > 0 && p >= 0xdc00 && p <= 0xdfff) from++;
  return s.slice(from, end);
};
globalThis.__ddnTail = function (k) {
  var out = [];
  for (var i = 0; i < k; i++) out.push(__ddnAdd({ type: "rename", nodeId: "file" + String(i).padStart(10, "0"), name: "renamed " + i + ".jpg" }, []));
  return JSON.stringify(out);
};
"ok"
"""
    }
}
