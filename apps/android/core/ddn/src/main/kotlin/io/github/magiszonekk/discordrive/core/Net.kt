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

    /** Account settings (every mode): (revision, sealed blob or null). */
    fun settings(): Pair<Long, ByteArray?> {
        val o = call("GET", "/v1/settings", null).second.jsonObject
        val blob = o["blob"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content
        return o.getValue("revision").jsonPrimitive.long to blob?.let { B64.dec(it) }
    }

    /** Compare-and-swap of the settings; null = stored, else the current (revision, blob) that won. */
    fun putSettings(expectedRevision: Long, revision: Long, blob: ByteArray): Pair<Long, ByteArray?>? {
        val (_, b) = call("PUT", "/v1/settings", buildJsonObject {
            put("expectedRevision", expectedRevision); put("revision", revision); put("blob", B64.enc(blob))
        }, ok = setOf(409))
        val o = b.jsonObject
        if (o.strOrNull("status") == "ok") return null
        val cur = o["current"] as? JsonObject ?: return 0L to null
        return cur.getValue("revision").jsonPrimitive.long to B64.dec(cur.str("blob"))
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

    /** The cleanup bookkeeping (Q4): server time now, the last cleanup run of the account, its first entry. */
    data class GcStatus(val now: Long, val lastRunAt: Long?, val firstEntryAt: Long?)

    fun gcStatus(): GcStatus = call("GET", "/v1/gc", null).second.jsonObject.let { o ->
        GcStatus(o.getValue("now").jsonPrimitive.long, o.longOrNull("lastRunAt"), o.longOrNull("firstEntryAt"))
    }

    /** Note a cleanup run (the trash step; no fragments were deleted by the phone). */
    fun gcRecordRun() {
        call("POST", "/v1/gc", buildJsonObject { put("uploads", JsonArray(emptyList())); put("run", true) })
    }

    fun devices(): List<JsonObject> = call("GET", "/v1/devices", null).second.jsonObject.getValue("devices").jsonArray.map { it.jsonObject }

    fun setDeviceName(deviceId: String, nameSealed: String) {
        call("PUT", "/v1/devices/$deviceId/name", buildJsonObject { put("nameSealed", nameSealed) })
    }

    fun pairingPut(pairingId: String, m: Pairing.Message) {
        call("PUT", "/v1/pairing/$pairingId", buildJsonObject { put("pub", m.pub); put("sealed", m.sealed) })
    }

    // ── blobs through the instance (e2ee / plain) ──

    /**
     * One blob of an upload (fragment `index`, "m" the manifest, "x<name>" an extra next to it), PUT with its
     * SHA-256; the instance posts it on its webhooks and answers with the placement (the same (upload, index,
     * hash) again returns the stored one: a resume). 503 / 429 = the instance is busy: waits as it asks.
     */
    fun putBlob(uploadId: String, index: String, data: ByteArray, sha256: String): JsonObject = putBlobResult(uploadId, index, data, sha256).first

    /** As putBlob; second = the instance already had it (an extra added by another device first). */
    fun putBlobResult(uploadId: String, index: String, data: ByteArray, sha256: String): Pair<JsonObject, Boolean> {
        var waited = 0L
        for (attempt in 0 until 8) {
            val rb = Request.Builder().url(baseUrl.trimEnd('/') + "/v1/uploads/$uploadId/blobs/$index")
                .header("authorization", "Bearer " + session())
                .header("x-ddn-sha256", sha256)
                .put(data.toRequestBody("application/octet-stream".toMediaType()))
            http.newCall(rb.build()).execute().use { res ->
                val text = res.body?.string().orEmpty()
                val j = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
                if (res.isSuccessful) return j!!.getValue("placement").jsonObject to (j["reused"]?.jsonPrimitive?.content == "true")
                val err = j?.strOrNull("error") ?: "?"
                when {
                    res.code == 401 && err == "unauthorized" -> token = null
                    res.code == 503 || res.code == 429 -> {
                        val wait = maxOf(500L, (res.header("retry-after")?.toDoubleOrNull()?.times(1000))?.toLong() ?: j?.get("retryAfterMs")?.jsonPrimitive?.content?.toLongOrNull() ?: 2000L)
                        if (waited + wait > 120_000) throw ServerException(res.code, "instance_busy")
                        waited += wait
                        Thread.sleep(wait)
                    }
                    res.code >= 500 -> Thread.sleep(500L shl attempt)
                    else -> throw ServerException(res.code, err)
                }
            }
        }
        throw ServerException(503, "instance_busy")
    }

    fun finalizeUpload(uploadId: String) { call("POST", "/v1/uploads/$uploadId/final", buildJsonObject {}) }
    fun abortUpload(uploadId: String) { call("DELETE", "/v1/uploads/$uploadId", null, ok = setOf(404)) }

    /** Fresh CDN links (at most 50 at a time) for blobs of this account: attachmentId → URL. */
    fun blobUrls(placements: List<JsonObject>): Map<String, String> {
        val out = HashMap<String, String>()
        for (part in placements.chunked(50)) {
            val body = buildJsonObject {
                put("attachments", JsonArray(part.map { p -> buildJsonObject { put("webhookId", p.str("locationId")); put("messageId", p.str("messageId")); put("attachmentId", p.str("attachmentId")) } }))
            }
            for (x in call("POST", "/v1/blobs/urls", body).second.jsonObject.getValue("urls").jsonArray) {
                val o = x.jsonObject
                o.strOrNull("url")?.let { out[o.str("attachmentId")] = it }
            }
        }
        return out
    }

    /** The extras (thumbnail, preview) stored next to a manifest: name (without extension) → placement. */
    fun extras(manifestAttachmentId: String): Map<String, JsonObject> {
        val r = call("POST", "/v1/blobs/extras", buildJsonObject { put("attachmentIds", JsonArray(listOf(kotlinx.serialization.json.JsonPrimitive(manifestAttachmentId)))) }).second.jsonObject
        val list = (r.getValue("extras").jsonObject[manifestAttachmentId] as? JsonArray) ?: return emptyMap()
        return list.associate { it.jsonObject.str("name") to it.jsonObject.getValue("placement").jsonObject }
    }

    /** A blob through the instance (the fallback when the CDN cannot be read). */
    fun blobProxy(p: JsonObject): ByteArray {
        val rb = Request.Builder().url(baseUrl.trimEnd('/') + "/v1/blobs/${p.str("attachmentId")}?w=${p.str("locationId")}&m=${p.str("messageId")}")
            .header("authorization", "Bearer " + session()).get()
        http.newCall(rb.build()).execute().use { res ->
            if (!res.isSuccessful) throw ServerException(res.code, "blob")
            return res.body!!.bytes()
        }
    }

    /** Uploads this phone's index released (purged / superseded): the instance deletes them 30 days later. */
    fun released(list: List<Pair<String, Long>>) {
        for (part in list.chunked(1000)) {
            call("POST", "/v1/uploads/released", buildJsonObject {
                put("uploads", JsonArray(part.map { (u, at) -> buildJsonObject { put("uploadId", u); put("at", at) } }))
            })
        }
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
 * How long a Discord 429 asks to wait, in seconds. Discord answers a webhook's per-route bucket with
 * contradicting values (production 2026-10-26: header retry-after 1812, body retry_after 0.3,
 * x-ratelimit-reset-after 2, scope user): the header retry-after counts only for the global limit. A bucket's
 * 429 waits the body's retry_after, else x-ratelimit-reset-after (at least 0.25 s).
 */
object DiscordRateLimit {
    data class Wait(val seconds: Double, val global: Boolean, val cloudflare: Boolean)

    fun wait(header: (String) -> String?, body: String): Wait {
        val j = runCatching { json.parseToJsonElement(body) as? JsonObject }.getOrNull()
        val fromBody = j?.get("retry_after")?.jsonPrimitive?.content?.toDoubleOrNull()
        val discordHeaders = listOf("x-ratelimit-scope", "x-ratelimit-remaining", "x-ratelimit-reset-after", "x-ratelimit-limit", "x-ratelimit-bucket", "x-ratelimit-global").any { header(it) != null }
        val hdr = header("retry-after")?.toDoubleOrNull()
        // Cloudflare: no Discord headers, no Discord JSON (an HTML page or "error code: 1015").
        if (!discordHeaders && fromBody == null) return Wait(hdr ?: 60.0, global = false, cloudflare = true)
        val global = j?.get("global")?.jsonPrimitive?.content == "true" || header("x-ratelimit-global") == "true" || header("x-ratelimit-scope") == "global"
        val reset = header("x-ratelimit-reset-after")?.toDoubleOrNull()
        val s = if (global) fromBody ?: hdr ?: 1.0 else fromBody ?: reset ?: minOf(hdr ?: 1.0, 60.0)
        return Wait(maxOf(0.25, s), global, false)
    }

    /** Random 0–1.5 s added to a 429 wait: the requests waiting on one bucket must not all return at once. */
    fun jitterMs(): Long = (Math.random() * 1500).toLong()
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
        // Short 429s of a webhook's bucket have their own pool (they are normal when reading many fragments)
        // and do not use up the retries of other errors; each waits what Discord asks (not its header
        // retry-after) plus a little jitter.
        var short429 = 0
        var attempt = 0
        while (true) {
            try {
                http.newCall(Request.Builder().url(map(url)).get().build()).execute().use { res ->
                    if (res.code == 429) {
                        val w = DiscordRateLimit.wait({ res.header(it) }, res.body?.string().orEmpty())
                        if (w.cloudflare || w.seconds > 60) throw ServerException(429, if (w.cloudflare) "discord_blocked" else "rate_limited")
                        if (++short429 > 12) throw ServerException(429, "rate_limited")
                        Thread.sleep((w.seconds * 1000).toLong() + DiscordRateLimit.jitterMs())
                        return@use
                    }
                    if (res.code >= 500 || res.code == 408) {
                        if (++attempt > 4) throw ServerException(res.code, "discord")
                        Thread.sleep((1000L shl (attempt - 1)) + DiscordRateLimit.jitterMs())
                        return@use
                    }
                    if (!res.isSuccessful) throw ServerException(res.code, "discord")
                    return res.body!!.bytes()
                }
            } catch (e: java.io.IOException) {
                // No answer (network): again, as for a 5xx.
                if (++attempt > 4) throw e
                Thread.sleep((1000L shl (attempt - 1)) + DiscordRateLimit.jitterMs())
            }
        }
    }

    companion object {
        const val PROVIDER = "discord-webhook"
        private val URL = Regex("^https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com/api(?:/v\\d+)?/webhooks/(\\d{15,22})/[A-Za-z0-9_.-]{20,}$")
        fun webhookId(url: String): String = URL.find(url.trim())?.groupValues?.get(1) ?: throw IllegalArgumentException("not a Discord webhook URL")
    }
}
