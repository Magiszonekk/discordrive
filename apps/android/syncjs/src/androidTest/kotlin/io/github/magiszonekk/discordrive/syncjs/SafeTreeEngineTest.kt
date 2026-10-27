package io.github.magiszonekk.discordrive.syncjs

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.magiszonekk.discordrive.core.json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Safe's tree in each JS engine (JsIndexReplica's __ddnSafe): an empty tree, folders and a file applied as
 * entries of the Safe's own log, the rules (a taken name gets a suffix), a purge reporting the released upload,
 * the listing (folders first); the account's index untouched. A tree larger than one slice goes in and out whole.
 */
@RunWith(AndroidJUnit4::class)
class SafeTreeEngineTest {
    private val context = InstrumentationRegistry.getInstrumentation().context

    private fun entry(seq: Long, op: JsonObject, guard: List<String> = emptyList()) = buildJsonObject {
        put("opId", "op-%08d".format(seq)); put("rulesVersion", 0); put("baseSeq", seq - 1)
        put("device", buildJsonObject { put("id", "dev-phone"); put("name", "Pixel") })
        put("createdAt", 1_700_000_000_000 + seq); put("tzOffsetMin", 60)
        if (guard.isNotEmpty()) put("leaseGuard", buildJsonArray { guard.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
        put("op", op); put("seq", seq); put("serverTime", 1_700_000_000_000 + seq)
    }

    @Test
    fun safeTreeInEachEngine() {
        val bundle = SyncCoreRuntime.loadBundle(context)
        for (make in engines(context)) {
            JsIndexReplica(SyncCoreRuntime(make(), bundle).engine).use { ix ->
                val accountHead = ix.headSeq
                var tree = json.parseToJsonElement(ix.safeEmpty()).jsonObject
                fun apply(seq: Long, op: JsonObject, guard: List<String> = emptyList()): JsonObject {
                    val r = json.parseToJsonElement(ix.safeApply(json.encodeToString(JsonElement.serializer(), tree), entry(seq, op, guard))).jsonObject
                    tree = r.getValue("tree").jsonObject
                    return r
                }
                apply(1, buildJsonObject { put("type", "create"); put("kind", "folder"); put("nodeId", "fold-0000001"); put("parentId", "root"); put("name", "Dokumenty") })
                val again = apply(2, buildJsonObject { put("type", "create"); put("kind", "folder"); put("nodeId", "fold-0000002"); put("parentId", "root"); put("name", "dokumenty") })
                assertEquals("applied", again.getValue("result").jsonObject.getValue("outcome").jsonPrimitive.content)
                val content = buildJsonObject {
                    put("versionId", "ver-0000001"); put("uploadId", "upl-0000001"); put("sizeBytes", 5); put("manifestRef", "ddn1:[1,1,\"k\",\"1\",\"2\",\"3\",\"4\"]"); put("chunkCount", 1); put("plaintextSha256", "0".repeat(64))
                }
                apply(3, buildJsonObject {
                    put("type", "group")
                    put("ops", buildJsonArray {
                        add(buildJsonObject { put("type", "upload_begin"); put("uploadId", "upl-0000001") })
                        add(buildJsonObject { put("type", "upload_commit"); put("uploadId", "upl-0000001") })
                        add(buildJsonObject { put("type", "create"); put("kind", "file"); put("nodeId", "file-0000001"); put("parentId", "fold-0000001"); put("name", "a.pdf"); put("content", content) })
                    })
                }, listOf("upl-0000001"))
                val top = ix.safeChildren(json.encodeToString(JsonElement.serializer(), tree), "root").map { it.name }
                assertEquals("${ix.engineName()}: rule 2 suffix, folders first", listOf("Dokumenty", "dokumenty (2)"), top)
                assertEquals(listOf("a.pdf"), ix.safeChildren(json.encodeToString(JsonElement.serializer(), tree), "fold-0000001").map { it.name })
                apply(4, buildJsonObject { put("type", "trash"); put("nodeId", "file-0000001") })
                val purged = apply(5, buildJsonObject { put("type", "purge"); put("nodeId", "file-0000001") })
                val rel = purged.getValue("released").jsonArray.map { it.jsonArray.map { x -> x.jsonPrimitive.content } }
                assertEquals(listOf(listOf("upl-0000001", content.getValue("manifestRef").jsonPrimitive.content)), rel)
                assertEquals(5L, tree.getValue("meta").jsonObject.getValue("headSeq").jsonPrimitive.long)
                // A tree larger than one slice (200 000 characters) goes in and out whole.
                for (i in 0 until 2500) apply(6L + i, buildJsonObject { put("type", "create"); put("kind", "folder"); put("nodeId", "big-%07d".format(i)); put("parentId", "fold-0000002"); put("name", "folder %05d ${"x".repeat(40)}".format(i)) })
                assertTrue(json.encodeToString(JsonElement.serializer(), tree).length > 400_000)
                assertEquals(2500, ix.safeChildren(json.encodeToString(JsonElement.serializer(), tree), "fold-0000002").size)
                // The account's index is another store.
                assertEquals(accountHead, ix.headSeq)
            }
        }
    }

    private fun JsIndexReplica.engineName() = toString()
}
