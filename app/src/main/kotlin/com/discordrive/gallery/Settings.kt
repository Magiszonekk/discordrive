package com.discordrive.gallery

import android.content.Context
import org.json.JSONObject

/** App settings: AI endpoint config (key Keystore-encrypted) + toggles. */
object Settings {

    private fun prefs(context: Context) = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    /** Default DiscorDrive instance (our test server) — self-hosters can change it. */
    const val DEFAULT_SERVER = "https://example.com"

    /** Configured DiscorDrive server URL used at login (defaults to [DEFAULT_SERVER]). */
    fun serverUrl(context: Context): String =
        prefs(context).getString("serverUrl", DEFAULT_SERVER)?.ifBlank { DEFAULT_SERVER } ?: DEFAULT_SERVER

    fun aiUrl(context: Context): String = prefs(context).getString("aiUrl", "") ?: ""
    fun aiModel(context: Context): String = prefs(context).getString("aiModel", "nex-agi/nex-n2-pro:free") ?: ""
    fun aiKey(context: Context): String = SecureStore(context).getString(SecureStore.AI_KEY) ?: ""
    fun aiAutoAfterSync(context: Context): Boolean = prefs(context).getBoolean("aiAuto", false)

    /** Max analyses per run (rate-limited gateways); 0 = unlimited. */
    fun aiLimit(context: Context): Int = prefs(context).getInt("aiLimit", 50)

    /** Parallel AI requests (e.g. a gateway fronting N OpenRouter accounts → N). */
    fun aiConcurrency(context: Context): Int = prefs(context).getInt("aiConcurrency", 1).coerceIn(1, 8)

    fun aiConfigured(context: Context): Boolean = aiUrl(context).isNotBlank() && aiModel(context).isNotBlank()

    // Optional speech-to-text endpoint (OpenAI /v1/audio/transcriptions format) —
    // adds an audio transcript as context to video AI analysis. Off when URL blank.
    fun transcriptionUrl(context: Context): String = prefs(context).getString("transcribeUrl", "") ?: ""
    fun transcriptionModel(context: Context): String = prefs(context).getString("transcribeModel", "whisper-1") ?: "whisper-1"
    fun transcriptionKey(context: Context): String = SecureStore(context).getString(SecureStore.TRANSCRIBE_KEY) ?: ""
    fun transcriptionConfigured(context: Context): Boolean = transcriptionUrl(context).isNotBlank()

    fun bgSyncEnabled(context: Context): Boolean = prefs(context).getBoolean("bgSync", false)
    fun bgWifiOnly(context: Context): Boolean = prefs(context).getBoolean("bgWifiOnly", true)
    fun bgChargingOnly(context: Context): Boolean = prefs(context).getBoolean("bgChargingOnly", false)

    // === Accent colour (UI theme) ===

    /** A selectable accent. [overlayStyle] is null for the default (blue) theme. */
    data class Accent(val key: String, val labelRes: Int, val overlayStyle: Int?)

    val ACCENTS = listOf(
        Accent("blue", R.string.accent_blue, null),
        Accent("purple", R.string.accent_purple, R.style.ThemeOverlay_Gallery_Purple),
        Accent("green", R.string.accent_green, R.style.ThemeOverlay_Gallery_Green),
        Accent("orange", R.string.accent_orange, R.style.ThemeOverlay_Gallery_Orange),
        Accent("pink", R.string.accent_pink, R.style.ThemeOverlay_Gallery_Pink),
        Accent("teal", R.string.accent_teal, R.style.ThemeOverlay_Gallery_Teal),
    )

    fun accentKey(context: Context): String = prefs(context).getString("accent", "blue") ?: "blue"

    fun setAccent(context: Context, key: String) {
        prefs(context).edit().putString("accent", key).apply()
    }

    /** Theme overlay res id for the chosen accent, or null for the default blue. */
    fun accentOverlay(context: Context): Int? =
        ACCENTS.firstOrNull { it.key == accentKey(context) }?.overlayStyle

    fun save(
        context: Context,
        serverUrl: String,
        aiUrl: String,
        aiKey: String,
        aiModel: String,
        aiAuto: Boolean,
        aiLimit: Int,
        aiConcurrency: Int,
        transcribeUrl: String,
        transcribeKey: String,
        transcribeModel: String,
        bgSync: Boolean,
        bgWifiOnly: Boolean,
        bgChargingOnly: Boolean,
    ) {
        prefs(context).edit()
            .putString("serverUrl", serverUrl.trim().trimEnd('/').ifBlank { DEFAULT_SERVER })
            .putString("aiUrl", aiUrl.trim().trimEnd('/'))
            .putString("aiModel", aiModel.trim())
            .putBoolean("aiAuto", aiAuto)
            .putInt("aiLimit", aiLimit.coerceIn(0, 10_000))
            .putInt("aiConcurrency", aiConcurrency.coerceIn(1, 8))
            .putString("transcribeUrl", transcribeUrl.trim().trimEnd('/'))
            .putString("transcribeModel", transcribeModel.trim().ifBlank { "whisper-1" })
            .putBoolean("bgSync", bgSync)
            .putBoolean("bgWifiOnly", bgWifiOnly)
            .putBoolean("bgChargingOnly", bgChargingOnly)
            .apply()
        if (aiKey.isNotBlank()) SecureStore(context).putString(SecureStore.AI_KEY, aiKey.trim())
        if (transcribeKey.isNotBlank()) SecureStore(context).putString(SecureStore.TRANSCRIBE_KEY, transcribeKey.trim())
        SyncWorker.applySchedule(context)
    }

    /** All settings (incl. the AI key) as JSON, for E2EE cloud backup. */
    fun toJson(context: Context): String = JSONObject().apply {
        put("schemaVersion", 1)
        put("serverUrl", serverUrl(context))
        put("aiUrl", aiUrl(context))
        put("aiModel", aiModel(context))
        put("aiKey", aiKey(context))
        put("aiAuto", aiAutoAfterSync(context))
        put("aiLimit", aiLimit(context))
        put("aiConcurrency", aiConcurrency(context))
        put("transcribeUrl", transcriptionUrl(context))
        put("transcribeModel", transcriptionModel(context))
        put("transcribeKey", transcriptionKey(context))
        put("bgSync", bgSyncEnabled(context))
        put("bgWifiOnly", bgWifiOnly(context))
        put("bgChargingOnly", bgChargingOnly(context))
        put("accent", accentKey(context))
    }.toString()

    /** Applies settings restored from the E2EE backup; missing fields keep current values. */
    fun applyJson(context: Context, jsonStr: String) {
        val o = JSONObject(jsonStr)
        if (o.has("accent")) setAccent(context, o.optString("accent", accentKey(context)))
        save(
            context,
            serverUrl = o.optString("serverUrl", serverUrl(context)),
            aiUrl = o.optString("aiUrl", aiUrl(context)),
            aiKey = o.optString("aiKey", ""), // blank → save() keeps the existing key
            aiModel = o.optString("aiModel", aiModel(context)),
            aiAuto = o.optBoolean("aiAuto", aiAutoAfterSync(context)),
            aiLimit = o.optInt("aiLimit", aiLimit(context)),
            aiConcurrency = o.optInt("aiConcurrency", aiConcurrency(context)),
            transcribeUrl = o.optString("transcribeUrl", transcriptionUrl(context)),
            transcribeKey = o.optString("transcribeKey", ""), // blank → save() keeps existing
            transcribeModel = o.optString("transcribeModel", transcriptionModel(context)),
            bgSync = o.optBoolean("bgSync", bgSyncEnabled(context)),
            bgWifiOnly = o.optBoolean("bgWifiOnly", bgWifiOnly(context)),
            bgChargingOnly = o.optBoolean("bgChargingOnly", bgChargingOnly(context)),
        )
    }
}
