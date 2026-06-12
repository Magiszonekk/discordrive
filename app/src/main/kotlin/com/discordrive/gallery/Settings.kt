package com.discordrive.gallery

import android.content.Context

/** App settings: AI endpoint config (key Keystore-encrypted) + toggles. */
object Settings {

    private fun prefs(context: Context) = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    fun aiUrl(context: Context): String = prefs(context).getString("aiUrl", "") ?: ""
    fun aiModel(context: Context): String = prefs(context).getString("aiModel", "nex-agi/nex-n2-pro:free") ?: ""
    fun aiKey(context: Context): String = SecureStore(context).getString(SecureStore.AI_KEY) ?: ""
    fun aiAutoAfterSync(context: Context): Boolean = prefs(context).getBoolean("aiAuto", false)

    /** Max analyses per run (rate-limited gateways); 0 = unlimited. */
    fun aiLimit(context: Context): Int = prefs(context).getInt("aiLimit", 50)

    fun aiConfigured(context: Context): Boolean = aiUrl(context).isNotBlank() && aiModel(context).isNotBlank()

    fun bgSyncEnabled(context: Context): Boolean = prefs(context).getBoolean("bgSync", false)
    fun bgWifiOnly(context: Context): Boolean = prefs(context).getBoolean("bgWifiOnly", true)
    fun bgChargingOnly(context: Context): Boolean = prefs(context).getBoolean("bgChargingOnly", false)

    fun save(
        context: Context,
        aiUrl: String,
        aiKey: String,
        aiModel: String,
        aiAuto: Boolean,
        aiLimit: Int,
        bgSync: Boolean,
        bgWifiOnly: Boolean,
        bgChargingOnly: Boolean,
    ) {
        prefs(context).edit()
            .putString("aiUrl", aiUrl.trim().trimEnd('/'))
            .putString("aiModel", aiModel.trim())
            .putBoolean("aiAuto", aiAuto)
            .putInt("aiLimit", aiLimit.coerceIn(0, 10_000))
            .putBoolean("bgSync", bgSync)
            .putBoolean("bgWifiOnly", bgWifiOnly)
            .putBoolean("bgChargingOnly", bgChargingOnly)
            .apply()
        if (aiKey.isNotBlank()) SecureStore(context).putString(SecureStore.AI_KEY, aiKey.trim())
        SyncWorker.applySchedule(context)
    }
}
