package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** The Safe's formats against what the web app (TypeScript) made: safe-vectors.json. */
class SafeVectorsTest {
    private val v: JsonObject = json.parseToJsonElement(javaClass.getResourceAsStream("/safe-vectors.json")!!.readBytes().toString(Charsets.UTF_8)).jsonObject
    private val acct = v.str("accountId")
    private val key = AccountKey.fromB64(v.str("accountKeyB64"))
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    @Test
    fun argon2AndMasterAsTheWebApp() {
        val a = v.getValue("argon2").jsonObject
        val kdf = Safe.Kdf.parse(a.getValue("kdf").jsonObject)
        assertEquals(65536, kdf.memoryKiB)
        val t0 = System.nanoTime()
        assertEquals(a.str("outHex"), hex(Safe.argon2(v.str("password"), kdf)))
        println("Safe Argon2id 64 MiB/3/4 on the JVM: ${(System.nanoTime() - t0) / 1_000_000} ms")
        val h = Safe.Header.parse(v.getValue("header").jsonObject)
        assertEquals(v.str("masterHex"), hex(Safe.openMaster(h, v.str("password"), acct)))
        assertThrows(Safe.BadPasswordException::class.java) { Safe.openMaster(h, v.str("password") + "!", acct) }
        assertThrows(Safe.BadPasswordException::class.java) { Safe.openMaster(h, "", acct) }
        // Bound to the account: another account ID does not open it.
        assertThrows(Safe.BadPasswordException::class.java) { Safe.openMaster(h, v.str("password"), acct + "x") }
    }

    @Test
    fun slotOpensAndTheAccountKeyAloneSeesNoNames() {
        val s = v.getValue("slot").jsonObject
        val rev = s.getValue("revision").jsonPrimitive.long
        val (h, sealed) = Safe.openHeader(key, acct, rev, s.str("blob"))
        assertFalse(h.toJson().toString().contains("paszport"))
        assertEquals(1 + 12 + Safe.PAD_MIN + 16, sealed.size)
        val master = Safe.openMaster(h, v.str("password"), acct)
        assertEquals(s.getValue("state"), Safe.openState(master, acct, rev, sealed))
        // Bound to the revision.
        assertThrows(UnsealException::class.java) { Safe.openHeader(key, acct, rev + 1, s.str("blob")) }
        // Another account key: not even the header.
        assertThrows(UnsealException::class.java) { Safe.openHeader(AccountKey.generate(), acct, rev, s.str("blob")) }
    }

    @Test
    fun phoneSealsWhatTheWebAppOpensTheSameWay() {
        // A slot sealed here opens with the same functions (the web app's format: checked by the web tests'
        // round trip of the same layout, and here against the vector's header).
        val s = v.getValue("slot").jsonObject
        val h = Safe.Header.parse(v.getValue("header").jsonObject)
        val master = Safe.openMaster(h, v.str("password"), acct)
        val blob = Safe.sealSlot(key, acct, 8, h, master, s.getValue("state"))
        val (h2, sealed) = Safe.openHeader(key, acct, 8, blob)
        assertEquals(h, h2)
        assertEquals(s.getValue("state"), Safe.openState(master, acct, 8, sealed))
    }

    @Test
    fun kitAndPadding() {
        assertEquals(v.str("kit"), Safe.kitText(acct, Safe.parseKit(v.str("kit")).second))
        assertEquals(v.str("masterB64"), B64.enc(Safe.parseKit(v.str("kit")).second))
        assertThrows(IllegalArgumentException::class.java) { Safe.parseKit("ddn-safe1:x:abc") }
        // A typo in the key part fails the check.
        val p = v.str("kit").split(":")
        val typo = listOf(p[0], p[1], (if (p[2][0] == 'A') "B" else "A") + p[2].substring(1), p[3]).joinToString(":")
        assertThrows(IllegalArgumentException::class.java) { Safe.parseKit(typo) }
        assertEquals(Safe.PAD_MIN, Safe.pad(ByteArray(10)).size)
        assertEquals(2 * Safe.PAD_MIN, Safe.pad(ByteArray(Safe.PAD_MIN - 3)).size)
        val x = ByteArray(1000) { it.toByte() }
        assertTrue(x.contentEquals(Safe.unpad(Safe.pad(x))))
    }
}
