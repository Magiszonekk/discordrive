package io.github.magiszonekk.discordrive.core

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// Primitives with exactly the bytes of packages/metadata-client (WebCrypto there, JCA + BouncyCastle here):
// HKDF-SHA256 with an empty salt, AES-256-GCM, Ed25519, base64 / base64url without padding, gzip.

internal val random = SecureRandom()

fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }

object B64 {
    fun enc(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
    fun dec(s: String): ByteArray = Base64.getDecoder().decode(s.trim())

    /** base64url without padding (keys, signatures, pairing IDs). */
    fun encUrl(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    fun decUrl(s: String): ByteArray = Base64.getUrlDecoder().decode(s.trim().trimEnd('='))
}

fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
fun sha256Hex(b: ByteArray): String = sha256(b).joinToString("") { "%02x".format(it) }

/** HKDF (RFC 5869) with HMAC-SHA256 and an empty salt, as WebCrypto's HKDF with `salt: new Uint8Array()`. */
object Hkdf {
    fun derive(ikm: ByteArray, info: String, length: Int = 32): ByteArray {
        val prk = hmac(ByteArray(32), ikm)
        val out = ByteArray(length)
        var prev = ByteArray(0)
        var at = 0
        var i = 1
        while (at < length) {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(prev)
            mac.update(info.toByteArray(Charsets.UTF_8))
            mac.update(i.toByte())
            prev = mac.doFinal()
            val n = minOf(prev.size, length - at)
            System.arraycopy(prev, 0, out, at, n)
            at += n
            i++
        }
        return out
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }
}

class UnsealException(what: String) : Exception("cannot decrypt $what (wrong key, tampered data or wrong context)")

object Aes {
    const val IV = 12

    /** iv || ciphertext+tag (16 bytes), optional AAD. */
    fun encrypt(key: ByteArray, plain: ByteArray, aad: ByteArray? = null, iv: ByteArray = randomBytes(IV)): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        if (aad != null) c.updateAAD(aad)
        return iv + c.doFinal(plain)
    }

    fun decrypt(key: ByteArray, packed: ByteArray, aad: ByteArray? = null, what: String = "data"): ByteArray {
        if (packed.size < IV + 16) throw UnsealException(what)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, packed, 0, IV))
        if (aad != null) c.updateAAD(aad)
        return try {
            c.doFinal(packed, IV, packed.size - IV)
        } catch (e: AEADBadTagException) {
            throw UnsealException(what)
        }
    }
}

object Gzip {
    fun compress(b: ByteArray): ByteArray = ByteArrayOutputStream().also { o -> GZIPOutputStream(o).use { it.write(b) } }.toByteArray()
    fun decompress(b: ByteArray): ByteArray = GZIPInputStream(ByteArrayInputStream(b)).use { it.readBytes() }
}

/** An Ed25519 key: the 32-byte seed stays inside (it is the device's secret); public key as base64url. */
class Ed25519Key private constructor(private val priv: Ed25519PrivateKeyParameters) {
    val publicKey: String = B64.encUrl(priv.generatePublicKey().encoded)

    fun sign(message: String): String {
        val s = Ed25519Signer()
        s.init(true, priv)
        val m = message.toByteArray(Charsets.UTF_8)
        s.update(m, 0, m.size)
        return B64.encUrl(s.generateSignature())
    }

    /** The seed, for the device's own encrypted store only. */
    fun exportSeed(): ByteArray = priv.encoded

    companion object {
        fun generate(): Ed25519Key = Ed25519Key(Ed25519PrivateKeyParameters(random))
        fun fromSeed(seed: ByteArray): Ed25519Key {
            require(seed.size == 32) { "Ed25519 seed must be 32 bytes" }
            return Ed25519Key(Ed25519PrivateKeyParameters(seed, 0))
        }

        private val PUB = Regex("^[A-Za-z0-9_-]{43}$")
        private val SIG = Regex("^[A-Za-z0-9_-]{86}$")
        fun isPublicKey(s: String?): Boolean = s != null && PUB.matches(s)

        fun verify(publicKey: String, message: String, signature: String): Boolean {
            if (!isPublicKey(publicKey) || !SIG.matches(signature)) return false
            return try {
                val v = Ed25519Signer()
                v.init(false, Ed25519PublicKeyParameters(B64.decUrl(publicKey), 0))
                val m = message.toByteArray(Charsets.UTF_8)
                v.update(m, 0, m.size)
                v.verifySignature(B64.decUrl(signature))
            } catch (e: Exception) {
                false
            }
        }
    }
}
