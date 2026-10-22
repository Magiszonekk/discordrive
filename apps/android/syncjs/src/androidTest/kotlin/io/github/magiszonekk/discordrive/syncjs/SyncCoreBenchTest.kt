package io.github.magiszonekk.discordrive.syncjs

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Cost of the sync core on a large account, per engine: N files (upload_begin + commit/create each, folders
 * of 200) applied from an empty index, then a snapshot taken (JSON) and loaded back. A phone joining an
 * account normally loads a snapshot and replays only the tail, so loadSnapshotMs is the number that matters
 * for a big account; applyMs is the worst case (no snapshot). Prints RESULT lines; fails only when the
 * engines disagree on the result. Sizes: -e syncBenchFiles 2000,20000,50000 (default 2000, so CI stays fast).
 */
@RunWith(AndroidJUnit4::class)
class SyncCoreBenchTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.context

    @Test
    fun largeAccount() {
        val sizes = (InstrumentationRegistry.getArguments().getString("syncBenchFiles") ?: "2000")
            .split(',').map { it.trim().toInt() }
        assumeTrue(sizes.isNotEmpty())
        val bundle = SyncCoreRuntime.loadBundle(context)
        val snapshotHashes = mutableMapOf<Int, String>()
        for (make in engines(context)) {
            SyncCoreRuntime(make(), bundle).use { core ->
                core.engine.evaluate(BENCH)
                for (n in sizes) {
                    val t0 = System.nanoTime()
                    val r = JSONObject(core.engine.evaluate("__ddnBench($n, 200)")!!)
                    val wallMs = (System.nanoTime() - t0) / 1_000_000
                    r.put("test", "bench").put("engine", core.engine.name).put("wallMs", wallMs)
                    Log.i(SyncCoreCompatTest.TAG, "RESULT $r")
                    val h = r.getString("snapshotHash")
                    snapshotHashes.putIfAbsent(n, h)
                    assertEquals("${core.engine.name}: snapshot of $n files differs between engines", snapshotHashes[n], h)
                }
            }
        }
    }

    private companion object {
        // Builds the log in the engine itself, so the measurement is the core, not the Kotlin/JS bridge.
        // The snapshot hash is a 32-bit FNV-1a over the JSON (no crypto in the engine): enough to compare engines.
        const val BENCH = """
globalThis.__ddnBench = function (nFiles, perFolder) {
  var S = SyncCore, st = S.initIndex(new S.MemoryIndexStore()), seq = 0, dev = { id: "dev-bench", name: "bench" };
  function id(p, n) { return p + String(n).padStart(10, "0"); }
  function add(op, lg) {
    seq++;
    var r = S.applyEntry(st, { opId: id("op", seq), rulesVersion: S.RULES_VERSION, baseSeq: seq - 1, device: dev, createdAt: seq,
      leaseGuard: lg, op: op, seq: seq, serverTime: seq });
    if (r.outcome !== "applied") throw new Error("bench op " + seq + ": " + r.outcome);
  }
  var t0 = Date.now(), folder = null;
  for (var i = 0; i < nFiles; i++) {
    if (i % perFolder === 0) { folder = id("dir", i); add({ type: "create", kind: "folder", nodeId: folder, parentId: S.ROOT_ID, name: "folder " + i }, []); }
    var u = id("upl", i);
    add({ type: "upload_begin", uploadId: u }, [u]);
    add({ type: "group", ops: [{ type: "upload_commit", uploadId: u }, { type: "create", kind: "file", nodeId: id("file", i), parentId: folder,
      name: "IMG_" + i + ".jpg", content: { versionId: id("ver", i), uploadId: u, sizeBytes: 3000000, manifestRef: "mf-" + i, chunkCount: 1,
      plaintextSha256: "0000000000000000000000000000000000000000000000000000000000000000" } }] }, [u]);
  }
  var applyMs = Date.now() - t0;
  var t1 = Date.now(), snap = JSON.stringify(S.takeSnapshot(st)), snapshotMs = Date.now() - t1;
  var t2 = Date.now(), loaded = S.loadSnapshot(JSON.parse(snap)), loadSnapshotMs = Date.now() - t2;
  if (S.canonicalState(loaded) !== S.canonicalState(st)) throw new Error("snapshot round trip changed the state");
  var h = 0x811c9dc5;
  for (var k = 0; k < snap.length; k++) { h ^= snap.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0; }
  return JSON.stringify({ files: nFiles, entries: seq, applyMs: applyMs, snapshotMs: snapshotMs, snapshotBytes: snap.length,
    loadSnapshotMs: loadSnapshotMs, snapshotHash: h.toString(16) });
};
"ok"
"""
    }
}
