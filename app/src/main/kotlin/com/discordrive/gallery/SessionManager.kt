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

    val isLoggedIn: Boolean get() = client != null && filesKey != null

    fun login(context: Context, server: String, user: String, password: String) {
        val newClient = DiscorDriveClient(server)
        val session = newClient.login(user, password, deviceName = "${Build.MANUFACTURER} ${Build.MODEL}")

        client = newClient
        filesKey = session.filesKey
        email = session.user.email
        serverUrl = server

        val secure = SecureStore(context)
        secure.putBytes(SecureStore.ARK, session.ark)
        session.refreshToken?.let { secure.putString(SecureStore.REFRESH_TOKEN, it) }
        context.getSharedPreferences("session", Context.MODE_PRIVATE).edit()
            .putString("serverUrl", server)
            .putString("email", session.user.email)
            .apply()
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
        }.isSuccess
    }

    fun logout(context: Context) {
        client = null
        filesKey = null
        email = null
        serverUrl = null
        SecureStore(context).clear()
        context.getSharedPreferences("session", Context.MODE_PRIVATE).edit().clear().apply()
        AppDb(context).writableDatabase.use { db ->
            db.execSQL("DELETE FROM asset_map")
            db.execSQL("DELETE FROM enrichment")
        }
    }
}
