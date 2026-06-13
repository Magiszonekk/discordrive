package com.discordrive.gallery

import android.content.Context
import com.discordrive.gallery.api.DiscorDriveClient
import com.discordrive.gallery.crypto.DdvCrypto

/**
 * E2EE backup of app settings (AI endpoint URL/key/model, toggles).
 *
 * Stored encrypted in gallery state (key `settings`, encryptMeta(filesKey)) so
 * the config follows the account across devices / reinstalls — the server only
 * ever sees ciphertext, including the AI key. Pushed on save; pulled and applied
 * on login.
 */
object SettingsSync {

    private const val STATE_KEY = "settings"

    fun push(context: Context, client: DiscorDriveClient, filesKey: ByteArray) {
        client.setGalleryState(STATE_KEY, DdvCrypto.encryptMeta(filesKey, Settings.toJson(context)))
    }

    /** Fetches + applies the cloud settings backup. Returns true if one existed. */
    fun pull(context: Context, client: DiscorDriveClient, filesKey: ByteArray): Boolean {
        val json = runCatching {
            client.getGalleryState(STATE_KEY)?.valueB64?.let { DdvCrypto.decryptMeta(filesKey, it) }
        }.getOrNull() ?: return false
        runCatching { Settings.applyJson(context, json) }
        return true
    }

    /**
     * Restores the backup only when the local config looks unset (e.g. after a
     * silent token-restore on a fresh install / post-logout, where the AI key
     * lives in the cleared Keystore). Avoids clobbering local edits on every
     * background restore.
     */
    fun pullIfMissing(context: Context, client: DiscorDriveClient, filesKey: ByteArray) {
        if (Settings.aiKey(context).isBlank() || Settings.aiUrl(context).isBlank()) {
            pull(context, client, filesKey)
        }
    }
}
