package com.discordrive.gallery

import android.content.Context
import android.os.Build
import com.discordrive.gallery.api.DiscorDriveClient

/**
 * Holds the live API client + filesKey and persists the session across app
 * restarts: server/email in plain prefs, ARK + refresh token Keystore-wrapped.
 * The password itself is never stored.
 */
object SessionManager {

    var client: DiscorDriveClient? = null
        private set
    var filesKey: ByteArray? = null
        private set
    var email: String? = null
        private set
    var serverUrl: String? = null
        private set

    @Volatile
    private var refreshToken: String? = null

    val isLoggedIn: Boolean get() = client != null && filesKey != null

    /** Refreshes the access JWT on expiry (so the session doesn't die after 1h). */
    private fun installAuthRefresh(c: DiscorDriveClient) {
        c.graphql.onAuthError = {
            val rt = refreshToken
            rt != null && runCatching { c.refreshAccessToken(rt) }.isSuccess
        }
    }

    fun login(context: Context, server: String, user: String, password: String) {
        val newClient = DiscorDriveClient(server)
        val session = newClient.login(user, password, deviceName = "${Build.MANUFACTURER} ${Build.MODEL}")

        client = newClient
        filesKey = session.filesKey
        email = session.user.email
        serverUrl = server
        refreshToken = session.refreshToken
        installAuthRefresh(newClient)

        val secure = SecureStore(context)
        secure.putBytes(SecureStore.ARK, session.ark)
        session.refreshToken?.let { secure.putString(SecureStore.REFRESH_TOKEN, it) }
        context.getSharedPreferences("session", Context.MODE_PRIVATE).edit()
            .putString("serverUrl", server)
            .putString("email", session.user.email)
            .apply()
        // keep the configured server (Settings) in sync with what we logged into
        context.getSharedPreferences("settings", Context.MODE_PRIVATE).edit()
            .putString("serverUrl", server)
            .apply()

        // Recover E2EE settings backup (AI endpoint/key/toggles) for this account.
        runCatching { SettingsSync.pull(context, newClient, session.filesKey) }
    }

    /** Restores a persisted session (refresh token → fresh JWT). Blocking. */
    fun restore(context: Context): Boolean {
        if (isLoggedIn) return true

        val prefs = context.getSharedPreferences("session", Context.MODE_PRIVATE)
        val server = prefs.getString("serverUrl", null) ?: return false
        val savedEmail = prefs.getString("email", null) ?: return false
        val secure = SecureStore(context)
        val ark = secure.getBytes(SecureStore.ARK) ?: return false
        val refreshToken = secure.getString(SecureStore.REFRESH_TOKEN) ?: return false

        return runCatching {
            val newClient = DiscorDriveClient(server)
            newClient.refreshAccessToken(refreshToken)
            client = newClient
            filesKey = ark
            email = savedEmail
            serverUrl = server
            this.refreshToken = refreshToken
            installAuthRefresh(newClient)
            // Recover E2EE settings (AI endpoint/key) if local config is unset —
            // login() pulls unconditionally, but the common path is silent restore.
            runCatching { SettingsSync.pullIfMissing(context, newClient, ark) }
        }.isSuccess
    }

    fun logout(context: Context) {
        client = null
        filesKey = null
        email = null
        serverUrl = null
        refreshToken = null
        SecureStore(context).clear()
        context.getSharedPreferences("session", Context.MODE_PRIVATE).edit().clear().apply()
        // NOTE: deliberately keep asset_map + enrichment. They're per-account local
        // caches (asset→fileId map, decrypted AI tags) — wiping them on logout forced
        // a full re-upload + re-analyze on the next login. Stale entries self-heal via
        // the cloud-existence check in syncAssets, so they're safe to keep.
    }
}
