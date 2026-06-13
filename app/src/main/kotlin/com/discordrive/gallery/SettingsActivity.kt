package com.discordrive.gallery

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.snackbar.Snackbar

class SettingsActivity : SessionActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        Insets.apply(findViewById(R.id.settingsRoot))

        findViewById<MaterialToolbar>(R.id.toolbar).setNavigationOnClickListener { finish() }

        val loggedIn = SessionManager.isLoggedIn
        findViewById<TextView>(R.id.accountInfo).text =
            if (loggedIn) "${SessionManager.email ?: "—"}\n${SessionManager.serverUrl ?: "—"}"
            else getString(R.string.settings_not_logged_in)
        findViewById<Button>(R.id.loginButton).apply {
            visibility = if (loggedIn) android.view.View.GONE else android.view.View.VISIBLE
            // requireSession restores or shows login, then recreate() refreshes this screen
            // (and pulls the E2EE settings backup applied during login).
            setOnClickListener { requireSession { recreate() } }
        }
        findViewById<Button>(R.id.logoutButton).visibility =
            if (loggedIn) android.view.View.VISIBLE else android.view.View.GONE

        val serverUrl = findViewById<EditText>(R.id.serverUrlInput)
        val aiUrl = findViewById<EditText>(R.id.aiUrlInput)
        val aiKey = findViewById<EditText>(R.id.aiKeyInput)
        val aiModel = findViewById<EditText>(R.id.aiModelInput)
        val aiLimit = findViewById<EditText>(R.id.aiLimitInput)
        val aiAuto = findViewById<MaterialSwitch>(R.id.aiAutoSwitch)
        val bgSync = findViewById<MaterialSwitch>(R.id.bgSyncSwitch)
        val bgWifi = findViewById<MaterialSwitch>(R.id.bgWifiSwitch)
        val bgCharging = findViewById<MaterialSwitch>(R.id.bgChargingSwitch)

        serverUrl.setText(Settings.serverUrl(this))
        aiUrl.setText(Settings.aiUrl(this))
        aiKey.setText(Settings.aiKey(this))
        aiModel.setText(Settings.aiModel(this))
        aiLimit.setText(Settings.aiLimit(this).toString())
        aiAuto.isChecked = Settings.aiAutoAfterSync(this)
        bgSync.isChecked = Settings.bgSyncEnabled(this)
        bgWifi.isChecked = Settings.bgWifiOnly(this)
        bgCharging.isChecked = Settings.bgChargingOnly(this)

        findViewById<Button>(R.id.saveButton).setOnClickListener {
            Settings.save(
                this,
                serverUrl = serverUrl.text.toString(),
                aiUrl = aiUrl.text.toString(),
                aiKey = aiKey.text.toString(),
                aiModel = aiModel.text.toString(),
                aiAuto = aiAuto.isChecked,
                aiLimit = aiLimit.text.toString().toIntOrNull() ?: 50,
                bgSync = bgSync.isChecked,
                bgWifiOnly = bgWifi.isChecked,
                bgChargingOnly = bgCharging.isChecked,
            )
            Snackbar.make(findViewById(R.id.settingsRoot), R.string.settings_saved, Snackbar.LENGTH_SHORT).show()
            // Back up settings E2EE so they follow the account (best-effort).
            val client = SessionManager.client
            val filesKey = SessionManager.filesKey
            if (client != null && filesKey != null) {
                kotlin.concurrent.thread {
                    runCatching { SettingsSync.push(this, client, filesKey) }
                        .onFailure { AppLog.w("Settings", "settings backup push failed", it) }
                }
            }
        }

        findViewById<Button>(R.id.copyLogsButton).setOnClickListener { copyLogs() }
        findViewById<Button>(R.id.sendLogsButton).setOnClickListener { sendLogs() }
        findViewById<Button>(R.id.clearAiButton).setOnClickListener { confirmClearAllAnalyses() }

        findViewById<Button>(R.id.logoutButton).setOnClickListener {
            SessionManager.logout(this)
            // Offline-first: drop back into the local gallery, don't force login.
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK))
        }

        findViewById<TextView>(R.id.versionInfo).text =
            "DiscorDrive Gallery v${packageManager.getPackageInfo(packageName, 0).versionName}"
    }

    /** Deletes every AI analysis (cloud enrichment blobs + local cache). */
    private fun confirmClearAllAnalyses() = requireSession {
        val client = SessionManager.client ?: return@requireSession
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.settings_clear_ai)
            .setMessage(R.string.settings_clear_ai_confirm)
            .setPositiveButton(R.string.action_delete_cloud) { _, _ ->
                kotlin.concurrent.thread {
                    val deleted = runCatching { client.deleteEnrichments(null) }
                        .onFailure { AppLog.w("Settings", "clear all AI failed", it) }
                        .getOrDefault(0)
                    AppDb(this).clearAllEnrichments()
                    runOnUiThread {
                        Snackbar.make(findViewById(R.id.settingsRoot), getString(R.string.ai_cleared, deleted), Snackbar.LENGTH_LONG).show()
                    }
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // === Diagnostics ===

    private fun copyLogs() {
        val text = AppLog.readAll()
        if (text.isBlank()) {
            Snackbar.make(findViewById(R.id.settingsRoot), R.string.diag_empty, Snackbar.LENGTH_SHORT).show()
            return
        }
        val clipboard = getSystemService(android.content.ClipboardManager::class.java)
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("DiscorDrive Gallery logs", text))
        Snackbar.make(findViewById(R.id.settingsRoot), R.string.diag_copied, Snackbar.LENGTH_SHORT).show()
    }

    /** E2EE log upload: encrypted with the filesKey, stored as gallery state `log:<timestamp>`. */
    private fun sendLogs() {
        val client = SessionManager.client
        val filesKey = SessionManager.filesKey
        if (client == null || filesKey == null) {
            Snackbar.make(findViewById(R.id.settingsRoot), "Zaloguj się ponownie", Snackbar.LENGTH_SHORT).show()
            return
        }
        val text = AppLog.readAll()
        if (text.isBlank()) {
            Snackbar.make(findViewById(R.id.settingsRoot), R.string.diag_empty, Snackbar.LENGTH_SHORT).show()
            return
        }
        kotlin.concurrent.thread {
            try {
                val header = "DiscorDrive Gallery v${packageManager.getPackageInfo(packageName, 0).versionName} · " +
                    "Android ${android.os.Build.VERSION.RELEASE} (SDK ${android.os.Build.VERSION.SDK_INT}) · " +
                    "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}\n"
                val key = "log:" + java.time.Instant.now().toString()
                client.setGalleryState(key, com.discordrive.gallery.crypto.DdvCrypto.encryptMeta(filesKey, header + text))
                runOnUiThread {
                    Snackbar.make(findViewById(R.id.settingsRoot), getString(R.string.diag_sent, key), Snackbar.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                AppLog.w("Settings", "log upload failed", e)
                runOnUiThread {
                    Snackbar.make(findViewById(R.id.settingsRoot), "Błąd wysyłki: ${e.message}", Snackbar.LENGTH_LONG).show()
                }
            }
        }
    }
}
