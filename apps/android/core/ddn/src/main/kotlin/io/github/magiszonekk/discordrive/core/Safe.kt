package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import java.nio.ByteBuffer
import java.text.Normalizer

/**
 * The Safe on the phone (the same formats as packages/metadata-client/src/safe.ts, checked by safe-vectors.json):
 * a part of the account closed with its own password. Its state is one slot on the instance (GET/PUT
 * /v1/slots/safe, compare-and-swap on the revision):
 *   blob   = "DDNS" || u32 BE header length || sealed header || sealed state
 *   header = { format, version, kdf, sealedMaster } sealed with the account subkey "safe" (AAD ddn-safe-head-v1|account|revision)
 *   master = 32 bytes sealed with HKDF(Argon2id(password), "ddn-safe-wrap-v1") (AAD ddn-safe-key-v1|account)
 *   state  = JSON padded to 64 KiB · 2^k, sealed with HKDF(master, "ddn-safe-state-v1") (AAD ddn-safe-state-v1|account|revision)
 * The account key never wraps the master: a paired device or the account's rescue kit cannot open the Safe.
 */
object Safe {
    const val SLOT = "safe"
    const val FORMAT = "ddn-safe"
    const val VERSION = 1
    const val PAD_MIN = 64 * 1024
    const val PAD_MAX = 1024 * 1024
    const val MIN_PASSWORD = 10
    /** The account password's parameters: 64 MiB, 3 passes, 4 lanes. */
    val ARGON2 = Kdf(65536, 3, 4, "")
    private val MAGIC = "DDNS".toByteArray(Charsets.US_ASCII)

    data class Kdf(val memoryKiB: Int, val iterations: Int, val parallelism: Int, val saltB64: String) {
        fun toJson(): JsonObject = buildJsonObject { put("alg", "argon2id"); put("memoryKiB", memoryKiB); put("iterations", iterations); put("parallelism", parallelism); put("saltB64", saltB64) }
        companion object {
            /** The accepted range (the same as the web app's checkArgon2Params). */
            fun parse(o: JsonObject): Kdf {
                val k = Kdf(o.getValue("memoryKiB").jsonPrimitive.int, o.getValue("iterations").jsonPrimitive.int, o.getValue("parallelism").jsonPrimitive.int, o.str("saltB64"))
                require(o.str("alg") == "argon2id" && k.memoryKiB in 19456..1048576 && k.iterations in 2..10 && k.parallelism in 1..8 && Regex("^[A-Za-z0-9+/]{22}==$").matches(k.saltB64)) { "bad_kdf_params" }
                return k
            }
        }
    }

    data class Header(val kdf: Kdf, val sealedMaster: String) {
        fun toJson(): JsonObject = buildJsonObject { put("format", FORMAT); put("version", VERSION); put("kdf", kdf.toJson()); put("sealedMaster", sealedMaster) }
        companion object {
            fun parse(o: JsonObject): Header {
                require(o.str("format") == FORMAT && o.getValue("version").jsonPrimitive.int == VERSION) { "unsupported Safe format" }
                return Header(Kdf.parse(o.getValue("kdf").jsonObject), o.str("sealedMaster"))
            }
        }
    }

    class BadPasswordException : Exception("wrong Safe password")
    class RollbackException(seen: Long, got: Long) : Exception("the Safe went back from revision $seen to $got: refusing")

    /** Argon2id (v1.3) of the NFC password: 32 bytes (the same as hash-wasm). */
    fun argon2(password: String, kdf: Kdf): ByteArray {
        val p = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id).withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withMemoryAsKB(kdf.memoryKiB).withIterations(kdf.iterations).withParallelism(kdf.parallelism).withSalt(B64.dec(kdf.saltB64)).build()
        val g = Argon2BytesGenerator().apply { init(p) }
        val out = ByteArray(32)
        g.generateBytes(Normalizer.normalize(password, Normalizer.Form.NFC).toByteArray(Charsets.UTF_8), out)
        return out
    }

    fun wrapKey(password: String, kdf: Kdf): ByteArray = Hkdf.derive(argon2(password, kdf), "ddn-safe-wrap-v1")
    fun stateKey(master: ByteArray): ByteArray = Hkdf.derive(master, "ddn-safe-state-v1")
    fun filesKey(master: ByteArray): ByteArray = Hkdf.derive(master, "ddn-safe-files-v1")

    private fun masterAad(acct: String) = "ddn-safe-key-v1|$acct"
    private fun headAad(acct: String, rev: Long) = "ddn-safe-head-v1|$acct|$rev"
    private fun stateAad(acct: String, rev: Long) = "ddn-safe-state-v1|$acct|$rev"

    fun newHeader(master: ByteArray, password: String, accountId: String, params: Kdf = ARGON2, salt: ByteArray = randomBytes(16)): Header {
        require(password.length >= MIN_PASSWORD) { "password_too_short" }
        val kdf = params.copy(saltB64 = B64.enc(salt))
        return Header(kdf, B64.enc(Seal.seal(wrapKey(password, kdf), master, masterAad(accountId))))
    }

    fun openMaster(h: Header, password: String, accountId: String): ByteArray {
        if (password.isEmpty()) throw BadPasswordException()
        val m = try { Seal.unseal(wrapKey(password, h.kdf), B64.dec(h.sealedMaster), masterAad(accountId), "Safe key") } catch (e: UnsealException) { throw BadPasswordException() }
        if (m.size != 32) throw BadPasswordException()
        return m
    }

    fun pad(plain: ByteArray): ByteArray {
        val need = plain.size + 4
        require(need <= PAD_MAX) { "the Safe's state is too large" }
        var size = PAD_MIN
        while (size < need) size *= 2
        return ByteBuffer.allocate(size).putInt(plain.size).put(plain).array()
    }
    fun unpad(p: ByteArray): ByteArray {
        val n = ByteBuffer.wrap(p).int
        require(n >= 0 && n + 4 <= p.size) { "Safe state: bad padding" }
        return p.copyOfRange(4, 4 + n)
    }

    fun sealSlot(key: AccountKey, accountId: String, revision: Long, header: Header, master: ByteArray, state: JsonElement): String {
        val head = Seal.sealJson(key.subkey("safe"), header.toJson(), headAad(accountId, revision))
        val body = Seal.seal(stateKey(master), pad(json.encodeToString(JsonElement.serializer(), state).toByteArray(Charsets.UTF_8)), stateAad(accountId, revision))
        return B64.enc(ByteBuffer.allocate(8 + head.size + body.size).put(MAGIC).putInt(head.size).put(head).put(body).array())
    }

    /** What the account key opens: the header (no names, no count) and the sealed state. */
    fun openHeader(key: AccountKey, accountId: String, revision: Long, blobB64: String): Pair<Header, ByteArray> {
        val b = B64.dec(blobB64)
        require(b.size >= 8 && b.copyOfRange(0, 4).contentEquals(MAGIC)) { "not a Safe" }
        val n = ByteBuffer.wrap(b, 4, 4).int
        require(n >= 0 && 8 + n <= b.size) { "not a Safe" }
        val h = Header.parse(Seal.unsealJson(key.subkey("safe"), b.copyOfRange(8, 8 + n), headAad(accountId, revision), "Safe header").jsonObject)
        return h to b.copyOfRange(8 + n, b.size)
    }

    fun openState(master: ByteArray, accountId: String, revision: Long, sealed: ByteArray): JsonElement =
        json.parseToJsonElement(unpad(Seal.unseal(stateKey(master), sealed, stateAad(accountId, revision), "Safe state")).toString(Charsets.UTF_8))

    /** The optional Safe kit: the master in text (whoever has it opens the Safe without the password). */
    fun kitText(accountId: String, master: ByteArray): String =
        "ddn-safe1:$accountId:" + B64.enc(master).replace('+', '-').replace('/', '_').trimEnd('=')
    fun parseKit(text: String): Pair<String, ByteArray> {
        val m = Regex("^ddn-safe1:([A-Za-z0-9_-]{4,80}):([A-Za-z0-9_-]{43})$").matchEntire(text.trim()) ?: throw IllegalArgumentException("not a Safe kit")
        val master = B64.dec(m.groupValues[2].replace('-', '+').replace('_', '/') + "=")
        require(master.size == 32) { "not a Safe kit" }
        return m.groupValues[1] to master
    }
}
