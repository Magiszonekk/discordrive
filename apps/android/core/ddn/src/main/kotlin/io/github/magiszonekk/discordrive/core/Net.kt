package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class ServerException(val status: Int, val code: String) : Exception("server: HTTP $status $code")

private val JSON_TYPE = "application/json".toMediaType()

internal fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(20, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .build()

/**
 * The instance's HTTP API as the phone uses it (the same endpoints as packages/metadata-client/http-api.ts):
 * challenge, sign-in by signature, the encrypted log, the vault, devices and the pairing mailbox. Signs in
 * lazily and once more on an expired session. Calls block: run them off the main thread.
 */
class InstanceApi(
    val baseUrl: String,
    private val accountId: String?,
    private val deviceId: String?,
    private val device: Ed25519Key?,
    private val instanceId: String? = null,
    private val http: OkHttpClient = defaultHttp(),
    private val now: () -> Long = System::currentTimeMillis,
) {
    private var token: String? = null
    private var tokenUntil = 0L
    var logins = 0
        private set

    // ── without a session ──

    fun health(): JsonObject = call("GET", "/v1/health", null, auth = false).second.jsonObject

    fun challenge(): Challenge {
        val o = call("POST", "/v1/auth/challenge", buildJsonObject {}, auth = false).second.jsonObject
        val c = Challenge(o.str("challengeId"), o.str("nonce"), o.str("instanceId"), o.getValue("expiresAt").jsonPrimitive.long)
        if (instanceId != null && c.instanceId != instanceId) throw IllegalStateException("challenge from another server instance")
        return c
    }

    /** The pairing mailbox (no credentials: the pairingId is the secret from the QR). Null until the answer is there. */
    fun pairingTake(pairingId: String): Pairing.Message? {
        val (st, b) = call("GET", "/v1/pairing/$pairingId", null, auth = false, ok = setOf(404))
        if (st == 404) return null
        val o = b.jsonObject
        return Pairing.Message(o.str("pub"), o.str("sealed"))
    }

    /** New device with the rescue key (rescue kit / password sign-in). */
    fun rescueRegisterDevice(key: AccountKey, accountId: String, newDevice: Ed25519Key): String {
        val c = challenge()
        val body = buildJsonObject {
            put("challengeId", c.challengeId)
            put("accountId", accountId)
            put("devicePublicKey", newDevice.publicKey)
            put("signature", key.rescueKey().sign(AuthMessage.rescueAddDevice(c, accountId, newDevice.publicKey)))
        }
        return call("POST", "/v1/auth/rescue-device", body, auth = false).second.jsonObject.str("deviceId")
    }

    // ── signed in ──

    @Synchronized
    fun session(force: Boolean = false): String {
        val t = token
        if (!force && t != null && now() < tokenUntil - 30_000) return t
        val acct = requireNotNull(accountId) { "no account" }
        val dev = requireNotNull(deviceId)
        val key = requireNotNull(device)
        val c = challenge()
        val t0 = now()
        val r = call("POST", "/v1/auth/login", buildJsonObject {
            put("challengeId", c.challengeId)
            put("accountId", acct)
            put("deviceId", dev)
            put("signature", key.sign(AuthMessage.login(c, acct, dev)))
        }, auth = false).second.jsonObject
        token = r.str("token")
        // Own clock + the server's TTL: a skewed phone clock does not make sessions look expired or eternal.
        tokenUntil = t0 + r.getValue("ttlMs").jsonPrimitive.long
        logins++
        return token!!
    }

    /** Log entries after `afterSeq` (encrypted, as the server stores them). `waitS` > 0: long poll. */
    fun read(afterSeq: Long, limit: Int = 1000, waitS: Int = 0): List<JsonObject> =
        call("GET", "/v1/log?after=$afterSeq&limit=$limit" + (if (waitS > 0) "&wait=$waitS" else ""), null).second.jsonObject.getValue("entries").jsonArray.map { it.jsonObject }

    /** Submit an encrypted envelope; the answer as the server gives it (status accepted / duplicate / …_rejected). */
    fun submit(env: JsonObject): JsonObject = call("POST", "/v1/log", env).second.jsonObject

    fun renewLease(uploadId: String): Boolean = call("POST", "/v1/leases/$uploadId", null).second.jsonObject["ok"]?.jsonPrimitive?.content == "true"

    fun releaseLease(uploadId: String) {
        call("DELETE", "/v1/leases/$uploadId", null)
    }

    /** The sealed vault (revision 0, null blob = none yet). */
    fun vault(): Pair<Long, ByteArray?> {
        val (st, b) = call("GET", "/v1/vault", null, ok = setOf(404))
        if (st == 404) return 0L to null
        val o = b.jsonObject
        val blob = o["blob"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content
        return o.getValue("revision").jsonPrimitive.long to blob?.let { B64.dec(it) }
    }

    /** Compare-and-swap on the revision; null = stored, else the current (revision, blob) that won. */
    fun putVault(expectedRevision: Long, revision: Long, blob: ByteArray): Pair<Long, ByteArray?>? {
        val (_, b) = call("PUT", "/v1/vault", buildJsonObject {
            put("expectedRevision", expectedRevision)
            put("revision", revision)
            put("blob", B64.enc(blob))
        }, ok = setOf(409))
        val o = b.jsonObject
        if (o.strOrNull("status") == "ok") return null
        val cur = o["current"] as? JsonObject ?: return 0L to null
        return cur.getValue("revision").jsonPrimitive.long to B64.dec(cur.str("blob"))
    }

    /** Pairing: this signed-in device vouches for the new device's key. Returns its deviceId. */
    fun addDevice(newDevicePublicKey: String): String {
        val c = challenge()
        return call("POST", "/v1/devices", buildJsonObject {
            put("challengeId", c.challengeId)
            put("devicePublicKey", newDevicePublicKey)
            put("signature", device!!.sign(AuthMessage.addDevice(c, accountId!!, newDevicePublicKey)))
        }).second.jsonObject.str("deviceId")
    }

    fun devices(): List<JsonObject> = call("GET", "/v1/devices", null).second.jsonObject.getValue("devices").jsonArray.map { it.jsonObject }

    fun setDeviceName(deviceId: String, nameSealed: String) {
        call("PUT", "/v1/devices/$deviceId/name", buildJsonObject { put("nameSealed", nameSealed) })
    }

    fun pairingPut(pairingId: String, m: Pairing.Message) {
        call("PUT", "/v1/pairing/$pairingId", buildJsonObject { put("pub", m.pub); put("sealed", m.sealed) })
    }

    // ── transport ──

    private fun call(method: String, path: String, body: JsonElement?, auth: Boolean = true, ok: Set<Int> = emptySet()): Pair<Int, JsonElement> {
        for (attempt in 0..1) {
            val rb = Request.Builder().url(baseUrl.trimEnd('/') + path)
            if (auth) rb.header("authorization", "Bearer " + session(force = attempt > 0))
            val payload = body?.let { json.encodeToString(JsonElement.serializer(), it).toRequestBody(JSON_TYPE) }
            rb.method(method, payload ?: if (method == "POST" || method == "PUT") ByteArray(0).toRequestBody(JSON_TYPE) else null)
            http.newCall(rb.build()).execute().use { res ->
                val text = res.body?.string().orEmpty()
                val j = runCatching { json.parseToJsonElement(text) }.getOrElse { JsonObject(emptyMap()) }
                val err = (j as? JsonObject)?.strOrNull("error")
                // Expired / unknown session: sign in again once.
                if (auth && res.code == 401 && err == "unauthorized" && attempt == 0) return@use
                if (!res.isSuccessful && res.code !in ok) throw ServerException(res.code, err ?: "?")
                return res.code to j
            }
        }
        throw ServerException(401, "unauthorized")
    }
}

/**
 * Reads from Discord through the account's own webhooks (metadata only: nothing passes through the
 * instance): GET the message through the webhook for a fresh CDN link, then the CDN. `apiOrigin` replaces
 * https://discord.com in tests (a local fake); never set in the app.
 */
open class Discord(private val http: OkHttpClient = defaultHttp(), private val apiOrigin: String? = null) {
    data class Attachment(val id: String, val url: String, val size: Long, val filename: String = "")

    private fun map(url: String): String = apiOrigin?.let { url.replace(Regex("^https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com"), it) } ?: url

    open fun attachments(webhookUrl: String, messageId: String): List<Attachment> {
        val j = get("$webhookUrl/messages/$messageId").toString(Charsets.UTF_8)
        return (json.parseToJsonElement(j).jsonObject["attachments"] as? JsonArray ?: JsonArray(emptyList())).map {
            val o = it.jsonObject
            Attachment(o.str("id"), o.str("url"), o["size"]?.jsonPrimitive?.long ?: 0, o.strOrNull("filename") ?: "")
        }
    }

    /** One stored object: its message's attachment (by ID, or the only one), from the CDN. */
    open fun fetch(webhookUrl: String, messageId: String, attachmentId: String? = null): ByteArray {
        val atts = attachments(webhookUrl, messageId)
        val a = if (attachmentId.isNullOrEmpty()) atts.singleOrNull() ?: throw IllegalStateException("expected one attachment") else atts.firstOrNull { it.id == attachmentId }
        return get((a ?: throw IllegalStateException("attachment missing from message")).url)
    }

    /** A CDN link from [attachments] (fresh for ~24 h). */
    open fun download(cdnUrl: String): ByteArray = get(cdnUrl)

    private fun get(url: String): ByteArray {
        for (attempt in 0..4) {
            http.newCall(Request.Builder().url(map(url)).get().build()).execute().use { res ->
                if (res.code == 429) {
                    val wait = (res.header("retry-after")?.toDoubleOrNull() ?: 1.0).coerceIn(0.1, 30.0)
                    Thread.sleep((wait * 1000).toLong())
                    return@use
                }
                if (!res.isSuccessful) throw ServerException(res.code, "discord")
                return res.body!!.bytes()
            }
        }
        throw ServerException(429, "rate_limited")
    }

    companion object {
        const val PROVIDER = "discord-webhook"
        private val URL = Regex("^https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com/api(?:/v\\d+)?/webhooks/(\\d{15,22})/[A-Za-z0-9_.-]{20,}$")
        fun webhookId(url: String): String = URL.find(url.trim())?.groupValues?.get(1) ?: throw IllegalArgumentException("not a Discord webhook URL")
    }
}
