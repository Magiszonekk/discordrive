package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

/**
 * The encrypted operation log. The server gets opId, rulesVersion, baseSeq and leaseGuard in clear (it
 * needs them) and the rest (device, createdAt, tzOffsetMin, op) sealed with the "op" subkey; the AAD binds
 * the payload to the account and to every clear field. An entry that does not decrypt becomes the same
 * invalid operation on every replica (they share the key), which the rules apply as a no-op.
 *
 * Envelopes and entries are JSON objects (the wire format; the sync core reads them as they are).
 */
class OpCodec(private val key: AccountKey, val accountId: String) {

    private fun aad(opId: String, rulesVersion: Long, baseSeq: Long, leaseGuard: List<String>?) =
        listOf("ddn-op-v1", accountId, opId, rulesVersion.toString(), baseSeq.toString(), (leaseGuard ?: emptyList()).joinToString(",")).joinToString("|")

    /** An envelope (opId, rulesVersion, baseSeq, device, createdAt, tzOffsetMin?, leaseGuard?, op) → what the server stores. */
    fun encrypt(env: JsonObject): JsonObject {
        val opId = env.str("opId")
        val rv = env.getValue("rulesVersion").jsonPrimitive.long
        val base = env.getValue("baseSeq").jsonPrimitive.long
        val lg = (env["leaseGuard"] as? JsonArray)?.map { it.jsonPrimitive.content }
        val payload = buildJsonObject {
            put("device", env.getValue("device"))
            put("createdAt", env.getValue("createdAt"))
            env["tzOffsetMin"]?.let { put("tzOffsetMin", it) }
            put("op", env.getValue("op"))
        }
        val sealed = Seal.sealJson(key.subkey("op"), payload, aad(opId, rv, base, lg))
        return buildJsonObject {
            put("opId", opId)
            put("rulesVersion", rv)
            put("baseSeq", base)
            if (lg != null) put("leaseGuard", JsonArray(lg.map { JsonPrimitive(it) }))
            put("payload", B64.enc(sealed))
        }
    }

    /** A sequenced encrypted entry (… seq, serverTime, payload) → a log entry for the sync core. */
    fun decrypt(e: JsonObject): JsonObject {
        val opId = e.str("opId")
        val rv = e.getValue("rulesVersion").jsonPrimitive.long
        val base = e.getValue("baseSeq").jsonPrimitive.long
        val lgEl = e["leaseGuard"]
        val lg = (lgEl as? JsonArray)?.map { it.jsonPrimitive.content }
        val head = buildJsonObject {
            put("opId", opId)
            put("rulesVersion", rv)
            put("baseSeq", base)
            put("seq", e.getValue("seq"))
            put("serverTime", e.getValue("serverTime"))
            if (lgEl != null && lgEl !is JsonNull) put("leaseGuard", lgEl)
        }
        val p = try {
            Seal.unsealJson(key.subkey("op"), B64.dec(e.str("payload")), aad(opId, rv, base, lg), "operation") as? JsonObject
        } catch (x: Exception) {
            null
        }
        return JsonObject(
            head + if (p != null) {
                buildMap {
                    put("device", p.getValue("device"))
                    put("createdAt", p.getValue("createdAt"))
                    p["tzOffsetMin"]?.let { put("tzOffsetMin", it) }
                    put("op", p.getValue("op"))
                }
            } else {
                mapOf(
                    "device" to buildJsonObject { put("id", "undecryptable"); put("name", "?") },
                    "createdAt" to JsonPrimitive(0),
                    "op" to buildJsonObject { put("type", "undecryptable") },
                )
            },
        )
    }

    companion object {
        /** IDs a client mints: 16 random bytes, base64url (22 characters). */
        fun newId(): String = B64.encUrl(randomBytes(16))
    }
}

/** The account's storage backends, one blob sealed with the "vault" subkey; AAD binds account and revision. */
object Vault {
    const val FORMAT = "ddn-webhook-vault"
    const val VERSION = 1
    private fun aad(accountId: String, revision: Long) = "ddn-vault-v1|$accountId|$revision"

    fun empty(): JsonObject = buildJsonObject { put("format", FORMAT); put("version", VERSION); put("webhooks", JsonArray(emptyList())) }

    fun open(key: AccountKey, accountId: String, revision: Long, blob: ByteArray): JsonObject {
        val v = Seal.unsealJson(key.subkey("vault"), blob, aad(accountId, revision), "webhook vault").jsonObject
        if (v.strOrNull("format") != FORMAT || v["version"]?.jsonPrimitive?.content != VERSION.toString() || v["webhooks"] !is JsonArray) {
            throw IllegalStateException("unsupported vault format")
        }
        return v
    }

    fun seal(key: AccountKey, accountId: String, revision: Long, v: JsonObject): ByteArray = Seal.sealJson(key.subkey("vault"), v, aad(accountId, revision))

    data class Webhook(val id: String, val url: String, val channelId: String, val label: String, val retired: Boolean)

    fun webhooks(v: JsonObject): List<Webhook> = v.getValue("webhooks").jsonArray.map { w ->
        val o = w.jsonObject
        Webhook(o.str("id"), o.str("url"), o.strOrNull("channelId") ?: "", o.strOrNull("label") ?: "", o["retired"]?.jsonPrimitive?.content == "true")
    }

    /** The snapshot pointer: the backend (webhook) ID and its slot (message ID), once created. */
    fun pointer(v: JsonObject): Pair<String, String>? = (v["pointer"] as? JsonObject)?.let { it.str("webhookId") to it.str("messageId") }

    /** Add (or replace by ID) a webhook; every other field of the vault is kept as it is. */
    fun withWebhook(v: JsonObject, w: JsonObject): JsonObject {
        val id = w.str("id")
        val list = v.getValue("webhooks").jsonArray.filter { it.jsonObject.strOrNull("id") != id } + w
        val sorted = list.sortedWith(compareBy<JsonElement>({ it.jsonObject["addedAt"]?.jsonPrimitive?.long ?: 0 }, { it.jsonObject.str("id") }))
        val removed = (v["removed"] as? JsonArray)?.filter { it.jsonObject.strOrNull("id") != id }
        return JsonObject(v + mapOf("webhooks" to JsonArray(sorted)) + (if (removed != null) mapOf("removed" to JsonArray(removed)) else emptyMap()))
    }
}

class VaultRollbackException(seen: Long, got: Long) : Exception("vault revision went back from $seen to $got: refusing (server rollback?)")
