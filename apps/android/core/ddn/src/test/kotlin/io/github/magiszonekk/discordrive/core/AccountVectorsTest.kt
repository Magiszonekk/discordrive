package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The phone's formats against vectors made by the TypeScript code (packages/metadata-client/scripts/
 * android-vectors.ts): subkeys, Ed25519 signatures and sign-in messages, the encrypted log, the vault,
 * device names, a pairing offer of the web app, the snapshot pointer / base / segments and rescue kits.
 * A failure means the phone would not read what the web and desktop apps write (or the other way round).
 */
class AccountVectorsTest {
    private val v: JsonObject = json.parseToJsonElement(javaClass.getResourceAsStream("/account-vectors.json")!!.readBytes().toString(Charsets.UTF_8)).jsonObject
    private val acct = v.str("accountId")
    private val key = AccountKey.fromB64(v.str("accountKeyB64"))
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun subkeys() {
        val p = v.getValue("subkeyProbe").jsonObject
        for ((label, ct) in p.getValue("ciphertextHex").jsonObject) {
            val mine = Aes.encrypt(key.subkey(label), unhex(p.str("plainHex")), null, unhex(p.str("ivHex")))
            assertEquals(ct.jsonPrimitive.content, hex(mine.copyOfRange(12, mine.size)), "subkey $label")
        }
    }

    @Test
    fun ed25519AndSignInMessages() {
        val e = v.getValue("ed25519").jsonObject
        val dev = Ed25519Key.fromSeed(unhex(e.str("seedHex")))
        assertEquals(e.str("publicKey"), dev.publicKey)
        // Ed25519 is deterministic: the same signature byte for byte.
        assertEquals(e.str("loginSignature"), dev.sign(e.str("loginMessage")))
        assertTrue(Ed25519Key.verify(dev.publicKey, e.str("loginMessage"), e.str("loginSignature")))
        assertFalse(Ed25519Key.verify(dev.publicKey, e.str("loginMessage") + "x", e.str("loginSignature")))
        val rk = key.rescueKey()
        assertEquals(e.str("rescuePublicKey"), rk.publicKey)
        assertEquals(e.str("rescueSignature"), rk.sign(e.str("rescueMessage")))
        val c = Challenge("chal-BBBBBBBBBBBBBBBBBBBBBB", "nonce-123", "inst-CCCCCCCCCCCCCCCCCCCCCC", 1)
        assertEquals(e.str("loginMessage"), AuthMessage.login(c, acct, "dev-DDDDDDDDDDDDDDDDDDDDDD"))
        assertEquals(e.str("rescueMessage"), AuthMessage.rescueAddDevice(c, acct, dev.publicKey))
        assertEquals(e.str("addDeviceMessage"), AuthMessage.addDevice(c, acct, rk.publicKey))
        assertEquals(e.str("createAccountMessage"), AuthMessage.createAccount(c, dev.publicKey, rk.publicKey))
    }

    @Test
    fun operationLog() {
        val o = v.getValue("op").jsonObject
        val codec = OpCodec(key, acct)
        val dec = codec.decrypt(o.getValue("encrypted").jsonObject)
        assertEquals(o.getValue("decrypted"), dec)
        // A clear field changed by the server: the payload no longer opens → the same invalid op as in TS.
        val tampered = JsonObject(o.getValue("encrypted").jsonObject + ("baseSeq" to kotlinx.serialization.json.JsonPrimitive(3)))
        assertEquals(o.getValue("tamperedDecrypted"), codec.decrypt(tampered))
        // Our own encryption opens to the same entry (and keeps the clear fields as they are).
        val env = o.getValue("envelope").jsonObject
        val mine = codec.encrypt(env)
        for (k in listOf("opId", "rulesVersion", "baseSeq", "leaseGuard")) assertEquals(env[k], mine[k], k)
        val seq = buildJsonObject { put("seq", 5); put("serverTime", 1792600000123) }
        assertEquals(o.getValue("decrypted"), codec.decrypt(JsonObject(mine + seq)))
    }

    @Test
    fun vault() {
        val x = v.getValue("vault").jsonObject
        val rev = x.getValue("revision").jsonPrimitive.long
        val content = Vault.open(key, acct, rev, B64.dec(x.str("blobB64")))
        assertEquals(x.getValue("content"), content)
        assertEquals("1550000000000000001" to "1550000000000000201", Vault.pointer(content))
        assertEquals("1550000000000000101", Vault.webhooks(content).single().channelId)
        // Another revision in the AAD: refused (the server cannot relabel an old blob).
        assertThrows(UnsealException::class.java) { Vault.open(key, acct, rev + 1, B64.dec(x.str("blobB64"))) }
        // Our seal of an edited vault keeps the fields we do not know.
        val edited = Vault.withWebhook(content, buildJsonObject { put("id", "1550000000000000002"); put("url", "https://discord.com/api/webhooks/1550000000000000002/" + "u".repeat(68)); put("channelId", "c2"); put("label", "2"); put("addedAt", 20) })
        val back = Vault.open(key, acct, 8, Vault.seal(key, acct, 8, edited))
        assertEquals(content["futureField"], back["futureField"])
        assertEquals(2, Vault.webhooks(back).size)
    }

    @Test
    fun deviceNames() {
        val d = v.getValue("deviceName").jsonObject
        val ins = d.getValue("inputs").jsonArray.map { it.jsonPrimitive.content }
        val outs = d.getValue("cleaned").jsonArray.map { it.jsonPrimitive.content }
        ins.zip(outs).forEach { (i, o) -> assertEquals(o, DeviceNames.clean(i), "clean(${i.toByteArray().contentToString()})") }
        assertEquals("Telefon Ola", DeviceNames.open(key, acct, "dev-DDDDDDDDDDDDDDDDDDDDDD", d.str("sealed")))
        assertNull(DeviceNames.open(key, acct, "dev-other", d.str("sealed")))
        val mine = DeviceNames.seal(key, acct, "dev-X", "Pixel 7")
        assertEquals("Pixel 7", DeviceNames.open(key, acct, "dev-X", mine))
    }

    @Test
    fun pairingOfferOfTheWebApp() {
        val p = v.getValue("pairing").jsonObject
        val o = Pairing.parseOffer(p.str("offer"))
        assertEquals(p.str("devicePublicKey"), o.devicePublicKey)
        assertEquals(65, o.pubN.size)
        // The QR of the web app carries a link; both forms parse.
        assertEquals(o.pairingId, Pairing.parseOffer("https://example.com/#pair=" + java.net.URLEncoder.encode(p.str("offer"), "UTF-8")).pairingId)
        assertThrows(IllegalArgumentException::class.java) { Pairing.parseOffer("ddn-pair1:short.x.y") }
        // Accepting a web offer as the signed-in device gives a mailbox message the web app opens (interop test);
        // here: the protocol between two phones.
        val newDev = Ed25519Key.generate()
        val pend = Pairing.start(newDev.publicKey)
        var registered: String? = null
        val (pid, msg, sas) = Pairing.accept(pend.offer, acct, key, "Pixel") { registered = it; "dev-NEW" }
        assertEquals(newDev.publicKey, registered)
        assertEquals(pend.pairingId, pid)
        val r = pend.complete(msg)
        assertEquals(sas, r.sas)
        assertEquals(acct, r.accountId)
        assertEquals("dev-NEW", r.deviceId)
        assertEquals(key.rawB64, r.key.rawB64)
        // A swapped mailbox message (another device's answer) does not open.
        val other = Pairing.start(newDev.publicKey)
        assertThrows(IllegalStateException::class.java) { other.complete(msg) }
    }

    @Test
    fun snapshotPointerBaseAndSegments() {
        val s = v.getValue("snapshots").jsonObject
        val objects = s.getValue("objects").jsonObject.mapValues { B64.dec(it.value.jsonPrimitive.content) }
        val loc = s.getValue("pointer").jsonObject
        val p = Snapshots.openPointer(key, acct, objects.getValue(loc.str("messageId")))
        assertEquals(s.getValue("toSeq").jsonPrimitive.long, p.toSeq)
        val b = p.base!!
        assertEquals(s.getValue("baseHeadSeq").jsonPrimitive.long, b.headSeq)
        assertEquals(s.getValue("baseParts").jsonPrimitive.content.toInt(), b.parts.size)
        val snap = Snapshots.loadBase(key, acct, b) { objects.getValue(it.messageId) }
        assertEquals("ddn-index-snapshot", snap.str("format"))
        assertEquals(b.headSeq, snap.getValue("meta").jsonObject.getValue("headSeq").jsonPrimitive.long)
        // 30 folders + the two system roots.
        assertEquals(32, snap.getValue("nodes").jsonArray.size)
        // The last segment opens and holds the encrypted entry after the base.
        val seg = p.json.getValue("lastSegment").jsonObject
        val body = Snapshots.openObject(key, objects.getValue(seg.str("messageId")), Snapshots.aadSegment(acct, seg.getValue("fromSeq").jsonPrimitive.long, seg.getValue("toSeq").jsonPrimitive.long), "segment").jsonObject
        val e = OpCodec(key, acct).decrypt(body.getValue("entries").jsonArray.last().jsonObject)
        assertEquals("rename", e.getValue("op").jsonObject.str("type"))
        // Slices of a large array keep every element, each slice valid JSON.
        val sl = Snapshots.slices(snap.getValue("nodes").jsonArray, 2000).toList()
        assertTrue(sl.size > 1)
        assertEquals(32, sl.sumOf { json.parseToJsonElement(it).jsonArray.size })
    }

    @Test
    fun rescueKits() {
        val k = v.getValue("kits").jsonObject
        val k1 = RescueKit.parse(k.str("kit1"))
        assertEquals(acct, k1.accountId)
        assertEquals("1550000000000000001", k1.pointerWebhookId)
        assertEquals("1550000000000000201", k1.pointerMessageId)
        val k3 = RescueKit.parse(k.str("kit3"))
        assertEquals(key.rawB64, k3.key)
        assertEquals(listOf("1550000000000000001", "1550000000000000002"), k3.webhooks.map { it.first })
        assertThrows(IllegalArgumentException::class.java) { RescueKit.parse("ddn-kit2:e30") }
    }
}
