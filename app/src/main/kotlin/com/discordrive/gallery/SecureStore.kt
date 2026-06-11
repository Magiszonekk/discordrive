package com.discordrive.gallery

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android-Keystore-encrypted key-value store for device secrets: the ARK,
 * the device-session refresh token and the AI API key.
 *
 * Trade-off (accepted by design): the Keystore key does NOT require user
 * authentication so background sync can run unattended — same boundary as
 * threat A6 in the gallery threat model.
 */
class SecureStore(context: Context) {

    private val prefs = context.getSharedPreferences("secure-store", Context.MODE_PRIVATE)

    fun putBytes(name: String, value: ByteArray) {
        prefs.edit().putString(name, encryptToB64(value)).apply()
    }

    fun getBytes(name: String): ByteArray? =
        prefs.getString(name, null)?.let { runCatching { decryptFromB64(it) }.getOrNull() }

    fun putString(name: String, value: String) = putBytes(name, value.toByteArray(Charsets.UTF_8))

    fun getString(name: String): String? = getBytes(name)?.toString(Charsets.UTF_8)

    fun remove(name: String) = prefs.edit().remove(name).apply()

    fun clear() = prefs.edit().clear().apply()

    private fun encryptToB64(plaintext: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
        val packed = cipher.iv + cipher.doFinal(plaintext)
        return java.util.Base64.getEncoder().encodeToString(packed)
    }

    private fun decryptFromB64(packedB64: String): ByteArray {
        val packed = java.util.Base64.getDecoder().decode(packedB64)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, packed.copyOfRange(0, 12)))
        return cipher.doFinal(packed.copyOfRange(12, packed.size))
    }

    private fun keystoreKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val KEY_ALIAS = "ddv4-secure-store"
        const val ARK = "ark"
        const val REFRESH_TOKEN = "refresh_token"
        const val AI_KEY = "ai_key"
    }
}
