package com.discordrive.gallery

import android.content.Context

/** App settings: AI endpoint config (key Keystore-encrypted) + toggles. */
object Settings {

    private fun prefs(context: Context) = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    fun aiUrl(context: Context): String = prefs(context).getString("aiUrl", "") ?: ""
    fun aiModel(context: Context): String = prefs(context).getString("aiModel", "nex-agi/nex-n2-pro:free") ?: ""
    fun aiKey(context: Context): String = SecureStore(context).getString(SecureStore.AI_KEY) ?: ""
    fun aiAutoAfterSync(context: Context): Boolean = prefs(context).getBoolean("aiAuto", false)

    fun aiConfigured(context: Context): Boolean = aiUrl(context).isNotBlank() && aiModel(context).isNotBlank()

    fun save(context: Context, aiUrl: String, aiKey: String, aiModel: String, aiAuto: Boolean) {
        prefs(context).edit()
            .putString("aiUrl", aiUrl.trim().trimEnd('/'))
            .putString("aiModel", aiModel.trim())
            .putBoolean("aiAuto", aiAuto)
            .apply()
        if (aiKey.isNotBlank()) SecureStore(context).putString(SecureStore.AI_KEY, aiKey.trim())
    }
}
