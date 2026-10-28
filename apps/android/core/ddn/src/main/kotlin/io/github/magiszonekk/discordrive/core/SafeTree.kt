package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.text.Normalizer
import java.util.TimeZone

/**
 * The Safe on the phone: the same slot, state and rules as the web app (packages/metadata-client/src/safe.ts and
 * safe-tree.ts), so a Safe made on one opens on the other.
 *   state = { v: 1, tree: <sync-core snapshot>, gone?: [{ u, ref, at }] }
 * A change is one operation applied by the sync core (the phone's JS engine, [IndexReplica.safeApply]) as the next
 * entry of the Safe's own log, then the whole state stored with the slot's compare-and-swap; on a concurrent write
 * it is applied again on the other device's state with the base the author saw. Nothing goes through the account's
 * log. Files: pieces stored like any file (the account's webhooks, or the instance), the reference and its key only
 * in the state; an upload no file uses any more is noted in `gone` and let go by [cleanup].
 */
class SafeStore(
    private val api: InstanceApi,
    private val key: AccountKey,
    private val accountId: String,
    /** Highest revision seen (persist it): an older one from the server is refused. */
    var seenRevision: Long = 0,
) {
    class Missing : Exception("the account has no Safe")
    class Exists : Exception("the account has a Safe already")
    class Damaged(msg: String) : Exception("the Safe cannot be read: $msg")
    /** The state no longer fits one slot (names and keys of every file and folder; at most [Safe.PAD_MAX]). */
    class TooLarge(bytes: Int) : Exception("the Safe's state is too large ($bytes bytes)")

    /** An open Safe: the master (memory or the device's key store only), the header and the state. */
    class Unlocked(val master: ByteArray, val revision: Long, val header: Safe.Header, val state: JsonObject)

    private fun read(): Pair<Long, String?> {
        val (rev, blob) = api.slot(Safe.SLOT)
        if (rev < seenRevision) throw Safe.RollbackException(seenRevision, rev)
        return rev to blob
    }

    fun exists(): Boolean = read().second != null

    /** [masterChecked]: the master came from the password (its seal proved it), so a state that does not open is damaged. */
    private fun open(rev: Long, blob: String, masterChecked: Boolean = false, master: (Safe.Header) -> ByteArray): Unlocked {
        val (h, sealed) = try { Safe.openHeader(key, accountId, rev, blob) } catch (e: Exception) { throw Damaged(e.message ?: "$e") }
        val m = master(h)
        val st = try { Safe.openState(m, accountId, rev, sealed).jsonObject } catch (e: Exception) { if (masterChecked) throw Damaged(e.message ?: "$e") else throw e }
        seenRevision = maxOf(seenRevision, rev)
        return Unlocked(m, rev, h, st)
    }

    fun create(password: String, state: JsonObject, params: Safe.Kdf = Safe.ARGON2): Unlocked {
        val master = randomBytes(32)
        val h = Safe.newHeader(master, password, accountId, params)
        if (api.putSlot(Safe.SLOT, 0, 1, Safe.sealSlot(key, accountId, 1, h, master, state)) != null) throw Exists()
        seenRevision = 1
        return Unlocked(master, 1, h, state)
    }

    fun unlock(password: String): Unlocked {
        val (rev, blob) = read()
        return open(rev, blob ?: throw Missing(), masterChecked = true) { h -> Safe.openMaster(h, password, accountId) }
    }

    fun unlockWithMaster(master: ByteArray): Unlocked {
        val (rev, blob) = read()
        return open(rev, blob ?: throw Missing()) { master }
    }

    /** Apply `change` to the newest state and store it; on a concurrent edit re-read and apply again. */
    fun update(u: Unlocked, change: (JsonObject) -> JsonObject): Unlocked {
        var cur = u
        repeat(5) {
            val next = change(cur.state)
            val bytes = json.encodeToString(JsonElement.serializer(), next).toByteArray(Charsets.UTF_8).size
            if (bytes + 4 > Safe.PAD_MAX) throw TooLarge(bytes)
            val rev = cur.revision + 1
            val won = api.putSlot(Safe.SLOT, cur.revision, rev, Safe.sealSlot(key, accountId, rev, cur.header, cur.master, next))
                ?: return Unlocked(cur.master, rev, cur.header, next).also { seenRevision = rev }
            val blob = won.second ?: throw Missing()
            cur = open(won.first, blob) { cur.master }
        }
        throw IllegalStateException("Safe: too many concurrent edits")
    }
}

class SafeTree(
    private val store: SafeStore,
    private val replica: IndexReplica,
    private val deviceId: String,
    private val deviceName: String,
    private val api: InstanceApi,
    /** Where the pieces are: the instance (e2ee / plain), or the account's webhooks ([deleteMessage]). */
    private val viaInstance: Boolean,
    private val readManifest: ((String) -> FileFormat.Manifest)? = null,
    private val deleteMessage: ((webhookId: String, messageId: String) -> Unit)? = null,
    private val now: () -> Long = System::currentTimeMillis,
) {
    data class Change(val safe: SafeStore.Unlocked, val result: JsonObject, val nodeId: String? = null)
    data class Cleanup(val safe: SafeStore.Unlocked, val released: Int, val kept: Int, val deleted: Int)

    fun create(password: String, params: Safe.Kdf = Safe.ARGON2): SafeStore.Unlocked =
        store.create(password, buildJsonObject { put("v", 1); put("tree", json.parseToJsonElement(replica.safeEmpty())) }, params)

    private fun treeOf(s: JsonObject): String {
        require(s["v"]?.jsonPrimitive?.content == "1") { "unsupported Safe state" }
        return json.encodeToString(JsonElement.serializer(), s.getValue("tree"))
    }

    private fun bound(s: JsonObject): Map<String, String> {
        val out = HashMap<String, String>()
        for (n in s.getValue("tree").jsonObject.getValue("nodes").jsonArray) {
            val c = n.jsonObject["content"] as? JsonObject ?: continue
            out[c.str("uploadId")] = c.str("manifestRef")
        }
        return out
    }

    /** How full the state is (0..1 of what one slot holds). */
    fun usage(u: SafeStore.Unlocked): Double =
        minOf(1.0, json.encodeToString(JsonElement.serializer(), u.state).toByteArray(Charsets.UTF_8).size.toDouble() / (Safe.PAD_MAX - 4))

    /** Folders first, by name; nothing in the trash. */
    fun children(u: SafeStore.Unlocked, parentId: String = "root"): List<IndexReplica.Child> = replica.safeChildren(treeOf(u.state), parentId)

    /** The node of a file (its reference: download with [FileReader.download]). */
    fun file(u: SafeStore.Unlocked, nodeId: String): JsonObject? =
        u.state.getValue("tree").jsonObject.getValue("nodes").jsonArray.map { it.jsonObject }.firstOrNull { it.str("id") == nodeId && it["content"] is JsonObject }

    fun commit(u: SafeStore.Unlocked, op: JsonObject): Change {
        val baseSeq = u.state.getValue("tree").jsonObject.getValue("meta").jsonObject.getValue("headSeq").jsonPrimitive.long
        val opId = OpCodec.newId()
        val createdAt = now()
        var result: JsonObject? = null
        var letGo = false
        val safe = store.update(u) { s ->
            val tree = treeOf(s)
            val head = json.parseToJsonElement(tree).jsonObject.getValue("meta").jsonObject.getValue("headSeq").jsonPrimitive.long
            val seq = head + 1
            val lg = replica.leaseGuard(op)
            val e = buildJsonObject {
                put("opId", opId); put("rulesVersion", 0); put("baseSeq", minOf(baseSeq, seq - 1))
                put("device", buildJsonObject { put("id", deviceId); put("name", deviceName) })
                put("createdAt", createdAt); put("tzOffsetMin", TimeZone.getDefault().getOffset(createdAt) / 60_000)
                if (lg.isNotEmpty()) put("leaseGuard", JsonArray(lg.map { JsonPrimitive(it) }))
                put("op", op); put("seq", seq); put("serverTime", now())
            }
            val r = json.parseToJsonElement(replica.safeApply(tree, e)).jsonObject
            result = r.getValue("result").jsonObject
            val gone = (s["gone"] as? JsonArray)?.toMutableList() ?: mutableListOf()
            val before = gone.size
            for (x in r.getValue("released").jsonArray) {
                val p = x.jsonArray
                gone += buildJsonObject { put("u", p[0].jsonPrimitive.content); put("ref", p[1].jsonPrimitive.content); put("at", e.getValue("serverTime").jsonPrimitive.long) }
            }
            letGo = gone.size > before
            buildJsonObject { put("v", 1); put("tree", r.getValue("tree")); if (gone.isNotEmpty()) put("gone", JsonArray(gone)) }
        }
        val after = if (letGo && viaInstance) runCatching { cleanup(safe) }.getOrNull() else null
        return Change(after?.safe ?: safe, result!!)
    }

    fun mkdir(u: SafeStore.Unlocked, name: String, parentId: String = "root"): Change {
        val id = OpCodec.newId()
        return commit(u, buildJsonObject { put("type", "create"); put("kind", "folder"); put("nodeId", id); put("parentId", parentId); put("name", Normalizer.normalize(name, Normalizer.Form.NFC)) }).copy(nodeId = id)
    }
    fun rename(u: SafeStore.Unlocked, nodeId: String, name: String) = commit(u, buildJsonObject { put("type", "rename"); put("nodeId", nodeId); put("name", Normalizer.normalize(name, Normalizer.Form.NFC)) })
    fun move(u: SafeStore.Unlocked, nodeId: String, parentId: String) = commit(u, buildJsonObject { put("type", "move"); put("nodeId", nodeId); put("parentId", parentId) })
    /** Delete for good (the Safe's pieces go after 30 days). */
    fun delete(u: SafeStore.Unlocked, ids: List<String>) = commit(u, buildJsonObject {
        put("type", "group")
        put("ops", buildJsonArray { for (id in ids) { add(buildJsonObject { put("type", "trash"); put("nodeId", id) }); add(buildJsonObject { put("type", "purge"); put("nodeId", id) }) } })
    })

    /** A file into the Safe: one Safe entry (upload_begin + upload_commit + create) with the reference. */
    fun upload(u: SafeStore.Unlocked, fw: FileWriter, open: () -> java.io.InputStream, size: Long, name: String, parentId: String = "root", takenAt: Long? = null, progress: (Long, Long) -> Unit = { _, _ -> }, cancelled: () -> Boolean = { false }): Change {
        var out: Change? = null
        var stored: JsonObject? = null
        try {
            fw.upload(open, size, name, parentId, takenAt = takenAt, progress = progress, cancelled = cancelled, outsideLog = { content, nodeId, nfc ->
                stored = content
                val c = commit(u, buildJsonObject {
                    put("type", "group")
                    put("ops", buildJsonArray {
                        add(buildJsonObject { put("type", "upload_begin"); put("uploadId", content.str("uploadId")) })
                        add(buildJsonObject { put("type", "upload_commit"); put("uploadId", content.str("uploadId")) })
                        add(buildJsonObject { put("type", "create"); put("kind", "file"); put("nodeId", nodeId); put("parentId", parentId); put("name", nfc); put("content", content) })
                    })
                })
                if (c.result.strOrNull("outcome") != "applied") throw IllegalStateException("Safe: the file was not added (${c.result.strOrNull("outcome")})")
                out = c.copy(nodeId = nodeId)
            })
        } catch (e: Exception) {
            // Stored but no file of the Safe has it: noted (through the instance it goes after the grace time anyway).
            stored?.let { c -> runCatching { noteGone(u, c.str("uploadId"), c.str("manifestRef")) } }
            throw e
        }
        return out!!
    }

    private fun noteGone(u: SafeStore.Unlocked, uploadId: String, ref: String) {
        val cur = store.unlockWithMaster(u.master)
        store.update(cur) { s ->
            if (uploadId in bound(s) || (s["gone"] as? JsonArray)?.any { it.jsonObject.str("u") == uploadId } == true) s
            else JsonObject(s + ("gone" to JsonArray(((s["gone"] as? JsonArray) ?: JsonArray(emptyList())) + buildJsonObject { put("u", uploadId); put("ref", ref); put("at", now()) })))
        }
    }

    /** Let go of the pieces no file of the Safe uses (the same rules as the web app's SafeTree.cleanup). */
    fun cleanup(u: SafeStore.Unlocked): Cleanup {
        val cur = store.unlockWithMaster(u.master)
        val b = bound(cur.state)
        val notes = (cur.state["gone"] as? JsonArray)?.map { it.jsonObject } ?: emptyList()
        if (viaInstance) {
            val (serverNow, rows) = api.outsideUploads()
            val noted = notes.map { it.str("u") }.toSet()
            val release = rows.filter { (id, st, fin) -> st == "committed" && id !in b && (id in noted || fin <= serverNow - ORPHAN_GRACE_MS) }.map { it.first }
            val keep = rows.filter { (id, st, _) -> st == "released" && id in b }.map { it.first }
            if (release.isNotEmpty()) api.released(release.map { it to serverNow })
            if (keep.isNotEmpty()) api.keptUploads(keep)
            val safe = if (noted.isNotEmpty()) store.update(cur) { s -> dropLetGo(s, noted) } else cur
            return Cleanup(safe, release.size, keep.size, 0)
        }
        val done = HashSet<String>()
        var deleted = 0
        for (g in notes) {
            val id = g.str("u")
            if (id in b) { done += id; continue }
            if (g.getValue("at").jsonPrimitive.long + RETENTION_MS > now()) continue
            runCatching { deleted += deletePieces(g.str("ref")); done += id }
        }
        val safe = if (done.isNotEmpty()) store.update(cur) { s -> dropLetGo(s, done) } else cur
        return Cleanup(safe, 0, 0, deleted)
    }

    private fun deletePieces(ref: String): Int {
        val loc = FileFormat.decodeManifestRef(ref)
        val m = try { readManifest!!(ref) } catch (e: Exception) {
            if (Regex("404|Unknown Message|attachment missing").containsMatchIn(e.message ?: "")) return 0
            throw e
        }
        var n = 0
        for (c in m.chunks) { deleteMessage!!(c.webhookId, c.messageId); n++ }
        deleteMessage!!(loc.webhookId, loc.messageId)
        return n + 1
    }

    private fun dropLetGo(s: JsonObject, ids: Set<String>): JsonObject {
        val b = bound(s)
        val gone = (s["gone"] as? JsonArray)?.filter { it.jsonObject.str("u") !in ids } ?: emptyList()
        val tree = s.getValue("tree").jsonObject
        val uploads = tree.getValue("uploads").jsonArray.filter { r ->
            val o = r.jsonObject; val id = o.str("id"); val st = o.str("status")
            id in b || st == "open" || st == "committed" || id !in ids
        }
        return buildJsonObject {
            put("v", 1)
            put("tree", JsonObject(tree + ("uploads" to JsonArray(uploads))))
            if (gone.isNotEmpty()) put("gone", JsonArray(gone))
        }
    }

    companion object {
        /** An upload outside the log the Safe does not refer to this long after: a write that never happened. */
        const val ORPHAN_GRACE_MS = 60 * 60_000L
        /** Pieces of what the Safe let go stay this long (a restored revision may want them). */
        const val RETENTION_MS = 30L * 86_400_000
    }
}
