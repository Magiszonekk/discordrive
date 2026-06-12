package com.discordrive.gallery

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.snackbar.Snackbar

class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        Insets.apply(findViewById(R.id.settingsRoot))

        findViewById<MaterialToolbar>(R.id.toolbar).setNavigationOnClickListener { finish() }

        findViewById<TextView>(R.id.accountInfo).text =
            "${SessionManager.email ?: "—"}\n${SessionManager.serverUrl ?: "—"}"

        val aiUrl = findViewById<EditText>(R.id.aiUrlInput)
        val aiKey = findViewById<EditText>(R.id.aiKeyInput)
        val aiModel = findViewById<EditText>(R.id.aiModelInput)
        val aiLimit = findViewById<EditText>(R.id.aiLimitInput)
        val aiAuto = findViewById<MaterialSwitch>(R.id.aiAutoSwitch)
        val bgSync = findViewById<MaterialSwitch>(R.id.bgSyncSwitch)
        val bgWifi = findViewById<MaterialSwitch>(R.id.bgWifiSwitch)
        val bgCharging = findViewById<MaterialSwitch>(R.id.bgChargingSwitch)

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
        }

        findViewById<Button>(R.id.copyLogsButton).setOnClickListener { copyLogs() }
        findViewById<Button>(R.id.sendLogsButton).setOnClickListener { sendLogs() }

        findViewById<Button>(R.id.logoutButton).setOnClickListener {
            SessionManager.logout(this)
            startActivity(Intent(this, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK))
        }

        findViewById<TextView>(R.id.versionInfo).text =
            "DiscorDrive Gallery v${packageManager.getPackageInfo(packageName, 0).versionName}"
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
