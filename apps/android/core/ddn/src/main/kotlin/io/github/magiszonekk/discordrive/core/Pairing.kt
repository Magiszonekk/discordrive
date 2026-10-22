package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.KeyAgreement

/**
 * Device pairing, the same protocol as the web app (offer "ddn-pair1:<pairingId>.<pubN>.<devicePub>"):
 *  1. the NEW device makes an ephemeral ECDH P-256 pair and shows the offer (QR / text) with its Ed25519 key;
 *  2. a signed-in device reads it, registers that Ed25519 key on the instance, seals {accountId, account key,
 *     deviceId} with K = HKDF(ECDH, transcript) and leaves it in the instance's one-shot mailbox;
 *  3. the new device takes it and opens it with the same K;
 *  4. both show a 6-digit code from K: a server that swapped a key would give different codes.
 */
object Pairing {
    const val PREFIX = "ddn-pair1:"
    const val TTL_MS = 10 * 60_000L
    private val ID = Regex("^[A-Za-z0-9_-]{22}$")

    class Offer(val pairingId: String, val pubN: ByteArray, val devicePublicKey: String)

    /** What the signed-in device puts into the mailbox. */
    class Message(val pub: String, val sealed: String)

    class Result(val bundle: JsonObject, val key: AccountKey, val sas: String) {
        val accountId: String get() = bundle.str("accountId")
        val deviceId: String get() = bundle.getValue("deviceCredential").jsonObject.str("deviceId")
        val fromDevice: String get() = bundle.strOrNull("fromDevice") ?: ""
    }

    /** Step 1 on the new device. Keep the returned object until the answer came (or 10 minutes passed). */
    class Pending internal constructor(val pairingId: String, private val kp: KeyPair, private val devicePublicKey: String) {
        private val pubN = rawPublic(kp.public as ECPublicKey)
        val offer: String = "$PREFIX$pairingId.${B64.encUrl(pubN)}.$devicePublicKey"

        /** Step 3: the mailbox message → the account (or an exception: wrong offer, tampered). */
        fun complete(msg: Message): Result {
            val pubE = B64.decUrl(msg.pub)
            val k = derive(kp, importPublic(pubE, (kp.public as ECPublicKey).params), pairingId, pubN, pubE, devicePublicKey)
            val plain = try {
                Aes.decrypt(k.aes, B64.decUrl(msg.sealed), null, "pairing message")
            } catch (e: UnsealException) {
                throw IllegalStateException("pairing message does not decrypt (wrong offer or tampered)")
            }
            val bundle = json.parseToJsonElement(plain.toString(Charsets.UTF_8)).jsonObject
            if (bundle["v"]?.toString() != "1" || bundle.strOrNull("accountId").isNullOrEmpty() || bundle.strOrNull("accountKey").isNullOrEmpty() ||
                (bundle["deviceCredential"] as? JsonObject)?.strOrNull("deviceId").isNullOrEmpty()
            ) {
                throw IllegalStateException("bad pairing bundle")
            }
            return Result(bundle, AccountKey.fromB64(bundle.str("accountKey")), k.sas)
        }
    }

    fun start(devicePublicKey: String): Pending {
        require(Ed25519Key.isPublicKey(devicePublicKey)) { "bad device public key" }
        return Pending(B64.encUrl(randomBytes(16)), newPair(), devicePublicKey)
    }

    fun parseOffer(text: String): Offer {
        var t = text.trim()
        // A QR of the web app holds a link (…/#pair=ddn-pair1:…).
        val i = t.indexOf("#pair=")
        if (i >= 0) t = java.net.URLDecoder.decode(t.substring(i + 6), "UTF-8")
        require(t.startsWith(PREFIX)) { "not a pairing code" }
        val parts = t.substring(PREFIX.length).split(".")
        require(parts.size == 3 && ID.matches(parts[0]) && parts[1].isNotEmpty() && Ed25519Key.isPublicKey(parts[2])) { "bad pairing code" }
        return Offer(parts[0], B64.decUrl(parts[1]), parts[2])
    }

    /**
     * Step 2 on the signed-in device: `register` adds the new device's key on the instance and returns its ID.
     * Returns the mailbox message and the code to compare.
     */
    fun accept(offer: String, accountId: String, accountKey: AccountKey, fromDevice: String, register: (String) -> String): Triple<String, Message, String> {
        val o = parseOffer(offer)
        val kp = newPair()
        val peer = importPublic(o.pubN, (kp.public as ECPublicKey).params)
        val pubE = rawPublic(kp.public as ECPublicKey)
        val k = derive(kp, peer, o.pairingId, o.pubN, pubE, o.devicePublicKey)
        val deviceId = register(o.devicePublicKey)
        val bundle = buildJsonObject {
            put("v", 1)
            put("accountId", accountId)
            put("accountKey", accountKey.rawB64)
            put("fromDevice", fromDevice)
            put("deviceCredential", buildJsonObject { put("deviceId", deviceId) })
        }
        val sealed = Aes.encrypt(k.aes, json.encodeToString(JsonObject.serializer(), bundle).toByteArray(Charsets.UTF_8))
        return Triple(o.pairingId, Message(B64.encUrl(pubE), B64.encUrl(sealed)), k.sas)
    }

    private class Keys(val aes: ByteArray, val sas: String)

    private fun derive(kp: KeyPair, peer: PublicKey, pairingId: String, pubN: ByteArray, pubE: ByteArray, signPub: String): Keys {
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(kp.private)
        ka.doPhase(peer, true)
        val shared = ka.generateSecret()
        fun info(label: String) = "ddn-pair-v2|$label|$pairingId|${B64.encUrl(pubN)}|${B64.encUrl(pubE)}|$signPub"
        val aes = Hkdf.derive(shared, info("key"), 32)
        val s = Hkdf.derive(shared, info("sas"), 4)
        val n = ((s[0].toLong() and 0xff) shl 24) or ((s[1].toLong() and 0xff) shl 16) or ((s[2].toLong() and 0xff) shl 8) or (s[3].toLong() and 0xff)
        return Keys(aes, (n % 1_000_000).toString().padStart(6, '0'))
    }

    private fun newPair(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    /** Uncompressed point 04 || x || y (65 bytes), as WebCrypto's "raw" export. */
    private fun rawPublic(k: ECPublicKey): ByteArray = byteArrayOf(4) + fixed32(k.w.affineX) + fixed32(k.w.affineY)

    private fun fixed32(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    private fun importPublic(raw: ByteArray, params: ECParameterSpec): PublicKey {
        require(raw.size == 65 && raw[0] == 4.toByte()) { "bad pairing public key" }
        val p = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(p, params))
    }
}
