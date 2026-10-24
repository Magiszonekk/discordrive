package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.text.Normalizer

val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }

/**
 * The account key (32 random bytes) and its subkeys: HKDF-SHA256 with the info "ddn-<label>-v1", one per
 * kind of object (vault, op, snapshot, device-name, share-note), so one ciphertext cannot pass for another.
 */
class AccountKey(raw: ByteArray) {
    init {
        require(raw.size == 32) { "account key must be 32 bytes" }
    }

    private val raw = raw.copyOf()
    private val subkeys = HashMap<String, ByteArray>()

    /** base64, as in the rescue kit and the pairing bundle. Secret: never log. */
    val rawB64: String get() = B64.enc(raw)

    @Synchronized
    fun subkey(label: String): ByteArray = subkeys.getOrPut(label) { Hkdf.derive(raw, "ddn-$label-v1") }

    /** The rescue key: Ed25519 from the seed HKDF(account key, "ddn-rescue-ed25519-v1"). */
    fun rescueKey(): Ed25519Key = Ed25519Key.fromSeed(Hkdf.derive(raw, "ddn-rescue-ed25519-v1"))

    companion object {
        fun fromB64(s: String) = AccountKey(B64.dec(s))
        fun generate() = AccountKey(randomBytes(32))
    }
}

/** version (1) || iv (12) || ciphertext+tag, AES-256-GCM, AAD = the context string. */
object Seal {
    private const val VERSION: Byte = 1

    fun seal(key: ByteArray, plain: ByteArray, aad: String): ByteArray =
        byteArrayOf(VERSION) + Aes.encrypt(key, plain, aad.toByteArray(Charsets.UTF_8))

    fun unseal(key: ByteArray, sealed: ByteArray, aad: String, what: String = "data"): ByteArray {
        if (sealed.size < 1 + Aes.IV + 16 || sealed[0] != VERSION) throw UnsealException(what)
        return Aes.decrypt(key, sealed.copyOfRange(1, sealed.size), aad.toByteArray(Charsets.UTF_8), what)
    }

    fun sealJson(key: ByteArray, value: JsonElement, aad: String): ByteArray =
        seal(key, json.encodeToString(JsonElement.serializer(), value).toByteArray(Charsets.UTF_8), aad)

    fun unsealJson(key: ByteArray, sealed: ByteArray, aad: String, what: String = "data"): JsonElement =
        json.parseToJsonElement(unseal(key, sealed, aad, what).toString(Charsets.UTF_8))
}

/** A challenge from the instance: each signed message names its purpose, the instance and the challenge. */
data class Challenge(val challengeId: String, val nonce: String, val instanceId: String, val expiresAt: Long)

object AuthMessage {
    private fun m(vararg parts: Any) = parts.joinToString("|")
    fun createAccount(c: Challenge, devicePub: String, rescuePub: String) = m("ddn-create-account-v1", c.instanceId, c.challengeId, c.nonce, devicePub, rescuePub)
    fun login(c: Challenge, accountId: String, deviceId: String) = m("ddn-login-v1", c.instanceId, c.challengeId, c.nonce, accountId, deviceId)
    fun addDevice(c: Challenge, accountId: String, newDevicePub: String) = m("ddn-add-device-v1", c.instanceId, c.challengeId, c.nonce, accountId, newDevicePub)
    fun revokeDevice(c: Challenge, accountId: String, deviceId: String) = m("ddn-revoke-device-v1", c.instanceId, c.challengeId, c.nonce, accountId, deviceId)
    fun rescueAddDevice(c: Challenge, accountId: String, newDevicePub: String) = m("ddn-rescue-add-device-v1", c.instanceId, c.challengeId, c.nonce, accountId, newDevicePub)
}

/** Device display names, sealed with the account key (the server stores an opaque blob). */
object DeviceNames {
    const val MAX = 64
    private fun aad(accountId: String, deviceId: String) = "ddn-devname-v1|$accountId|$deviceId"

    // The characters JavaScript's \s and trim() treat as white space.
    private val JS_SPACE = Regex("[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")

    fun clean(name: String): String {
        val n = Normalizer.normalize(name, Normalizer.Form.NFC).replace(Regex("[\\u0000-\\u001f\\u007f]"), " ").replace(JS_SPACE, " ").trim { JS_SPACE.matches(it.toString()) }
        val cps = n.codePoints().limit(MAX.toLong()).toArray()
        return String(cps, 0, cps.size).ifEmpty { "device" }
    }

    fun seal(key: AccountKey, accountId: String, deviceId: String, name: String): String =
        B64.enc(Seal.sealJson(key.subkey("device-name"), buildJsonObject { put("n", clean(name)) }, aad(accountId, deviceId)))

    fun open(key: AccountKey, accountId: String, deviceId: String, sealed: String?): String? {
        if (sealed.isNullOrEmpty()) return null
        return try {
            Seal.unsealJson(key.subkey("device-name"), B64.dec(sealed), aad(accountId, deviceId), "device name").jsonObject["n"]?.jsonPrimitive?.content
        } catch (e: Exception) {
            null
        }
    }
}

/** What this phone keeps about its account (in the Keystore-encrypted store). Secrets: accountKey, deviceSeed. */
data class AccountState(
    val serverUrl: String,
    val instanceId: String,
    val accountId: String,
    val deviceId: String,
    val deviceName: String,
    val accountKey: String,
    val deviceSeed: String,
    /** The instance's storage mode: "metadata-only" (own webhooks), "e2ee" or "plain" (blobs through the instance). */
    val mode: String = MODE_METADATA,
) {
    /** Blobs go through the instance (e2ee / plain): no vault of webhooks, no client snapshots. */
    val serverBlobs: Boolean get() = mode == MODE_E2EE || mode == MODE_PLAIN
    fun toJson(): JsonObject = buildJsonObject {
        put("v", 1)
        put("serverUrl", serverUrl)
        put("instanceId", instanceId)
        put("accountId", accountId)
        put("deviceId", deviceId)
        put("deviceName", deviceName)
        put("accountKey", accountKey)
        put("deviceSeed", deviceSeed)
        put("mode", mode)
    }

    val key: AccountKey get() = AccountKey.fromB64(accountKey)
    val device: Ed25519Key get() = Ed25519Key.fromSeed(B64.dec(deviceSeed))

    companion object {
        fun fromJson(o: JsonObject) = AccountState(
            serverUrl = o.str("serverUrl"),
            instanceId = o.str("instanceId"),
            accountId = o.str("accountId"),
            deviceId = o.str("deviceId"),
            deviceName = o.str("deviceName"),
            accountKey = o.str("accountKey"),
            deviceSeed = o.str("deviceSeed"),
            mode = o.strOrNull("mode") ?: MODE_METADATA,
        )
        const val MODE_METADATA = "metadata-only"
        const val MODE_E2EE = "e2ee"
        const val MODE_PLAIN = "plain"
    }
}

internal fun JsonObject.str(k: String): String = this[k]?.jsonPrimitive?.content ?: throw IllegalArgumentException("missing $k")
internal fun JsonObject.strOrNull(k: String): String? = (this[k] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
