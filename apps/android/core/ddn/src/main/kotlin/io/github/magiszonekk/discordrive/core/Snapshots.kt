package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/**
 * Snapshots on the storage backends (the web app and the desktop app write them): one pointer slot (a
 * Discord message edited in place) names the current base (the decrypted tree, split in parts) and the last
 * segment. Everything is sealed with the "snapshot" subkey; the pointer and segments are gzip + JSON, a
 * base is gzip of the whole tree cut into parts, each part sealed on its own.
 *
 * A phone joining an account loads the base and replays only the log after it (from the instance), so a
 * large account does not replay every operation since the first.
 */
object Snapshots {
    private fun aadPointer(acct: String) = "ddn-pointer-v1|$acct"
    private fun aadBase(acct: String, headSeq: Long, i: Int, n: Int) = "ddn-base-v1|$acct|$headSeq|$i|$n"
    fun aadSegment(acct: String, from: Long, to: Long) = "ddn-segment-v1|$acct|$from|$to"

    /** Where an object is: a Discord webhook's message and attachment. */
    data class ObjRef(val webhookId: String, val messageId: String, val attachmentId: String, val other: JsonObject?)

    data class Base(val headSeq: Long, val parts: List<ObjRef>)

    data class Pointer(val toSeq: Long, val base: Base?, val json: JsonObject)

    fun openObject(key: AccountKey, sealed: ByteArray, aad: String, what: String): JsonElement =
        json.parseToJsonElement(Gzip.decompress(Seal.unseal(key.subkey("snapshot"), sealed, aad, what)).toString(Charsets.UTF_8))

    fun openPointer(key: AccountKey, accountId: String, sealed: ByteArray): Pointer {
        val p = openObject(key, sealed, aadPointer(accountId), "pointer").jsonObject
        require(p["v"]?.jsonPrimitive?.content == "1") { "unsupported pointer version" }
        val b = p["base"] as? JsonObject
        return Pointer(
            toSeq = p.getValue("toSeq").jsonPrimitive.long,
            base = b?.let { Base(it.getValue("headSeq").jsonPrimitive.long, it.getValue("parts").jsonArray.map { r -> ref(r.jsonObject) }) },
            json = p,
        )
    }

    private fun ref(o: JsonObject) = ObjRef(o.str("webhookId"), o.strOrNull("messageId") ?: "", o.strOrNull("attachmentId") ?: "", o["at"] as? JsonObject)

    /**
     * The tree of a base as JSON text in slices of at most `maxChars` (never split inside a surrogate pair):
     * every part fetched (`fetch`) and opened, the gzip stream decompressed as it is read. A base of a large
     * account is tens of MB of JSON: it is never held as one string or as a parsed tree on the Kotlin side
     * (the sync core parses it in its engine).
     */
    fun baseSlices(key: AccountKey, accountId: String, b: Base, fetch: (ObjRef) -> ByteArray, maxChars: Int = 256 * 1024): Sequence<String> = sequence {
        val gz = java.io.ByteArrayOutputStream()
        b.parts.forEachIndexed { i, r -> gz.write(Seal.unseal(key.subkey("snapshot"), fetch(r), aadBase(accountId, b.headSeq, i, b.parts.size), "base part")) }
        java.io.InputStreamReader(java.util.zip.GZIPInputStream(java.io.ByteArrayInputStream(gz.toByteArray()), 64 * 1024), Charsets.UTF_8).use { rd ->
            val buf = CharArray(maxChars)
            var n = 0
            var eof = false
            while (!eof) {
                while (n < buf.size) {
                    val k = rd.read(buf, n, buf.size - n)
                    if (k < 0) { eof = true; break }
                    n += k
                }
                // A high surrogate at the end waits for its pair in the next slice.
                val keep = if (!eof && n > 0 && Character.isHighSurrogate(buf[n - 1])) 1 else 0
                if (n - keep > 0) yield(String(buf, 0, n - keep))
                if (keep == 1) buf[0] = buf[n - 1]
                n = keep
            }
        }
    }

    /** The whole tree of a base parsed (small bases: tests, tools). */
    fun loadBase(key: AccountKey, accountId: String, b: Base, fetch: (ObjRef) -> ByteArray): JsonObject {
        val snap = json.parseToJsonElement(baseSlices(key, accountId, b, fetch).joinToString("")).jsonObject
        val head = snap.getValue("meta").jsonObject.getValue("headSeq").jsonPrimitive.long
        require(head == b.headSeq) { "base headSeq mismatch" }
        return snap
    }

    /** A snapshot's nodes or uploads in slices (an engine call carries a bounded amount of text). */
    fun slices(arr: JsonArray, maxChars: Int = 256 * 1024): Sequence<String> = sequence {
        val sb = StringBuilder("[")
        for (e in arr) {
            val s = json.encodeToString(JsonElement.serializer(), e)
            if (sb.length > 1 && sb.length + s.length + 1 > maxChars) {
                yield(sb.append(']').toString())
                sb.setLength(0)
                sb.append('[')
            }
            if (sb.length > 1) sb.append(',')
            sb.append(s)
        }
        yield(sb.append(']').toString())
    }
}

/**
 * A rescue kit of a metadata-only account ("ddn-kit3:" / "ddn-kit1:" + base64url(JSON)): account ID, account
 * key, the pointer's backend and slot. Secret.
 */
data class RescueKit(val accountId: String, val key: String, val pointerWebhookId: String, val pointerMessageId: String, val webhooks: List<Pair<String, String>>) {
    companion object {
        fun parse(text: String): RescueKit {
            val t = text.trim()
            val v = Regex("^ddn-kit(\\d+):").find(t)?.groupValues?.get(1) ?: throw IllegalArgumentException("not a rescue kit")
            val o = json.parseToJsonElement(B64.decUrl(t.substring(9)).toString(Charsets.UTF_8)).jsonObject
            return when (v) {
                // e2ee / plain: the account key and the instance (the instance holds the webhooks and the chain).
                "2" -> RescueKit(o.str("accountId"), o.str("key"), "", "", emptyList())
                "1" -> {
                    val url = o.str("webhookUrl")
                    val id = Discord.webhookId(url)
                    RescueKit(o.str("accountId"), o.str("key"), id, o.str("pointerMessageId"), listOf(id to url))
                }
                "3" -> {
                    val own = o.getValue("backend").jsonObject
                    val all = listOf(own) + ((o["backends"] as? JsonArray)?.map { it.jsonObject } ?: emptyList())
                    val hooks = all.filter { it.strOrNull("kind") == Discord.PROVIDER && it.strOrNull("url") != null }.map { it.str("id") to it.str("url") }.distinctBy { it.first }
                    RescueKit(o.str("accountId"), o.str("key"), own.str("id"), o.str("slot"), hooks)
                }
                else -> throw IllegalArgumentException("not a rescue kit")
            }
        }
    }
}
