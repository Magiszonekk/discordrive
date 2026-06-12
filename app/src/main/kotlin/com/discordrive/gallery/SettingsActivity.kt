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

        findViewById<Button>(R.id.logoutButton).setOnClickListener {
            SessionManager.logout(this)
            startActivity(Intent(this, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK))
        }

        findViewById<TextView>(R.id.versionInfo).text =
            "DiscorDrive Gallery v${packageManager.getPackageInfo(packageName, 0).versionName}"
    }
}
