package com.discordrive.gallery

import android.content.Context
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * App-level private albums: buckets marked private disappear from the normal
 * album list, favorites, search, the in-app picker and the SAF provider; they
 * show as locked, preview-less tiles at the very bottom (next to trash) and
 * EVERY open asks for the gallery PIN (or biometrics — see [PrivateUnlock]).
 * View-level privacy only: sync and cloud behaviour are unchanged.
 */
object PrivateAlbums {

    private fun prefs(context: Context) = context.getSharedPreferences("private-albums", Context.MODE_PRIVATE)

    fun all(context: Context): Set<String> =
        prefs(context).getStringSet("buckets", emptySet()) ?: emptySet()

    fun isPrivate(context: Context, bucket: String): Boolean = bucket in all(context)

    fun setPrivate(context: Context, bucket: String, private: Boolean) {
        val current = all(context).toMutableSet()
        if (private) current.add(bucket) else current.remove(bucket)
        prefs(context).edit().putStringSet("buckets", current).apply()
    }

    /** Drops items living in private albums — the shared hide-everywhere path. */
    fun filterVisible(context: Context, assets: List<MediaAsset>): List<MediaAsset> {
        val hidden = all(context)
        if (hidden.isEmpty()) return assets
        return assets.filter { it.bucketName !in hidden }
    }

    // === PIN (salted SHA-256, stored in the Keystore-encrypted SecureStore) ===

    fun hasPin(context: Context): Boolean =
        SecureStore(context).getString(SecureStore.PRIVATE_PIN) != null

    fun setPin(context: Context, pin: String) {
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val packed = b64(salt) + ":" + b64(hash(salt, pin))
        SecureStore(context).putString(SecureStore.PRIVATE_PIN, packed)
    }

    fun verifyPin(context: Context, pin: String): Boolean {
        val stored = SecureStore(context).getString(SecureStore.PRIVATE_PIN) ?: return false
        val parts = stored.split(':', limit = 2)
        if (parts.size != 2) return false
        val salt = runCatching { java.util.Base64.getDecoder().decode(parts[0]) }.getOrNull() ?: return false
        val expected = runCatching { java.util.Base64.getDecoder().decode(parts[1]) }.getOrNull() ?: return false
        return MessageDigest.isEqual(hash(salt, pin), expected)
    }

    fun biometricsEnabled(context: Context): Boolean = prefs(context).getBoolean("biometrics", false)

    fun setBiometricsEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean("biometrics", enabled).apply()
    }

    private fun hash(salt: ByteArray, pin: String): ByteArray =
        MessageDigest.getInstance("SHA-256").apply { update(salt) }.digest(pin.toByteArray(Charsets.UTF_8))

    private fun b64(bytes: ByteArray): String = java.util.Base64.getEncoder().encodeToString(bytes)
}
