package com.discordrive.gallery

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.discordrive.gallery.crypto.AesGcm
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Persists the Account Root Key wrapped under an Android Keystore key, so the
 * user types their password only once per device.
 *
 * Trade-off (accepted by design): the Keystore key does NOT require user
 * authentication, because background sync must run unattended. Compromise of
 * an unlocked, rooted device exposes the ARK — same boundary as threat A6 in
 * the gallery threat model. Biometric/PIN gating protects the UI, not this key.
 *
 * The device-session refresh token should be stored the same way (encrypted
 * via [encrypt]/[decrypt]) in app-private storage.
 */
class KeystoreArkStore(private val context: Context) {

    private val prefs by lazy { context.getSharedPreferences("ark-store", Context.MODE_PRIVATE) }

    fun saveArk(ark: ByteArray) {
        prefs.edit().putString(PREF_WRAPPED_ARK, AesGcmKeystore.encryptToB64(keystoreKey(), ark)).apply()
    }

    fun loadArk(): ByteArray? {
        val packedB64 = prefs.getString(PREF_WRAPPED_ARK, null) ?: return null
        return AesGcmKeystore.decryptFromB64(keystoreKey(), packedB64)
    }

    fun clear() {
        prefs.edit().remove(PREF_WRAPPED_ARK).apply()
    }

    private fun keystoreKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // Unattended background sync needs the key without user-auth
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    private object AesGcmKeystore {
        fun encryptToB64(key: SecretKey, plaintext: ByteArray): String {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key) // Keystore generates the IV
            val packed = cipher.iv + cipher.doFinal(plaintext)
            return java.util.Base64.getEncoder().encodeToString(packed)
        }

        fun decryptFromB64(key: SecretKey, packedB64: String): ByteArray {
            val packed = java.util.Base64.getDecoder().decode(packedB64)
            val iv = packed.copyOfRange(0, AesGcm.IV_LENGTH)
            val ciphertext = packed.copyOfRange(AesGcm.IV_LENGTH, packed.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
            return cipher.doFinal(ciphertext)
        }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "ddv4-ark-wrap"
        const val PREF_WRAPPED_ARK = "wrapped_ark"
    }
}
