package com.discordrive.gallery.crypto

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * HKDF (RFC 5869) with HMAC-SHA256, matching WebCrypto's `deriveBits` as used
 * by DiscorDrive: salt is always empty (treated as 32 zero bytes per RFC).
 */
object Hkdf {
    private const val HASH_LEN = 32

    fun deriveBits(ikm: ByteArray, info: String, lengthBytes: Int = 32): ByteArray {
        val prk = hmacSha256(ByteArray(HASH_LEN), ikm) // extract with empty (zero) salt
        return expand(prk, info.toByteArray(Charsets.UTF_8), lengthBytes)
    }

    private fun expand(prk: ByteArray, info: ByteArray, lengthBytes: Int): ByteArray {
        require(lengthBytes <= 255 * HASH_LEN) { "HKDF output too long" }
        val output = ByteArray(lengthBytes)
        var previous = ByteArray(0)
        var generated = 0
        var counter = 1
        while (generated < lengthBytes) {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(previous)
            mac.update(info)
            mac.update(counter.toByte())
            previous = mac.doFinal()
            val toCopy = minOf(HASH_LEN, lengthBytes - generated)
            System.arraycopy(previous, 0, output, generated, toCopy)
            generated += toCopy
            counter++
        }
        return output
    }

    fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // JCA rejects empty keys; an all-zero key block is what HMAC does with
        // an empty key anyway (zero-padded to block size)
        mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(HASH_LEN) else key, "HmacSHA256"))
        return mac.doFinal(message)
    }
}
