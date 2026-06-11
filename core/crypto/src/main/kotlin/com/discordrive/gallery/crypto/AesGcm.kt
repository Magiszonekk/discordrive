package com.discordrive.gallery.crypto

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * AES-256-GCM with DiscorDrive's packing: `IV(12B) || ciphertext || tag(16B)`,
 * no AAD — byte-compatible with WebCrypto's AES-GCM as used in @ddv4/processing.
 */
object AesGcm {
    const val IV_LENGTH = 12
    private const val TAG_BITS = 128
    private val random = SecureRandom()

    fun encryptPacked(key: ByteArray, plaintext: ByteArray, iv: ByteArray = randomIv()): ByteArray {
        require(iv.size == IV_LENGTH) { "IV must be $IV_LENGTH bytes" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        val ciphertext = cipher.doFinal(plaintext)
        return iv + ciphertext
    }

    fun decryptPacked(key: ByteArray, packed: ByteArray): ByteArray {
        require(packed.size > IV_LENGTH) { "Packed payload too short" }
        val iv = packed.copyOfRange(0, IV_LENGTH)
        val ciphertext = packed.copyOfRange(IV_LENGTH, packed.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
        return cipher.doFinal(ciphertext)
    }

    fun randomIv(): ByteArray = ByteArray(IV_LENGTH).also { random.nextBytes(it) }

    fun randomKey(): ByteArray = ByteArray(32).also { random.nextBytes(it) }
}
