package com.discordrive.gallery

import android.content.Intent
import android.os.Bundle
import android.provider.MediaStore
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.snackbar.Snackbar
import kotlin.concurrent.thread

class SettingsActivity : SessionActivity() {

    private val wipeLocalLauncher =
        registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
            if (result.resultCode == RESULT_OK) {
                Snackbar.make(findViewById(R.id.settingsRoot), R.string.danger_wipe_local, Snackbar.LENGTH_SHORT).show()
            }
        }

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
        val aiConcurrency = findViewById<EditText>(R.id.aiConcurrencyInput)
        val transcribeUrl = findViewById<EditText>(R.id.transcribeUrlInput)
        val transcribeKey = findViewById<EditText>(R.id.transcribeKeyInput)
        val transcribeModel = findViewById<EditText>(R.id.transcribeModelInput)
        val aiAuto = findViewById<MaterialSwitch>(R.id.aiAutoSwitch)
        val bgSync = findViewById<MaterialSwitch>(R.id.bgSyncSwitch)
        val bgWifi = findViewById<MaterialSwitch>(R.id.bgWifiSwitch)
        val bgCharging = findViewById<MaterialSwitch>(R.id.bgChargingSwitch)

        serverUrl.setText(Settings.serverUrl(this))
        aiUrl.setText(Settings.aiUrl(this))
        aiKey.setText(Settings.aiKey(this))
        aiModel.setText(Settings.aiModel(this))
        aiLimit.setText(Settings.aiLimit(this).toString())
        aiConcurrency.setText(Settings.aiConcurrency(this).toString())
        transcribeUrl.setText(Settings.transcriptionUrl(this))
        transcribeKey.setText(Settings.transcriptionKey(this))
        transcribeModel.setText(Settings.transcriptionModel(this))
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
                aiConcurrency = aiConcurrency.text.toString().toIntOrNull() ?: 1,
                transcribeUrl = transcribeUrl.text.toString(),
                transcribeKey = transcribeKey.text.toString(),
                transcribeModel = transcribeModel.text.toString(),
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

        findViewById<Button>(R.id.aiModelsButton).setOnClickListener {
            pickModelFromEndpoint(aiUrl.text.toString(), aiKey.text.toString(), aiModel)
        }
        findViewById<Button>(R.id.transcribeModelsButton).setOnClickListener {
            pickModelFromEndpoint(transcribeUrl.text.toString(), transcribeKey.text.toString(), transcribeModel)
        }

        findViewById<Button>(R.id.syncToCloudButton).setOnClickListener {
            requireSession {
                SyncWorker.runNow(this, SyncWorker.MODE_SYNC)
                Snackbar.make(findViewById(R.id.settingsRoot), R.string.sync_started_bg, Snackbar.LENGTH_LONG).show()
            }
        }
        findViewById<Button>(R.id.syncFromCloudButton).setOnClickListener {
            requireSession { chooseDownloadMode() }
        }

        findViewById<Button>(R.id.accentButton).setOnClickListener { pickAccent() }
        findViewById<Button>(R.id.videoSeekButton).setOnClickListener { pickVideoSeek() }
        setupPrivateSection()
        findViewById<Button>(R.id.wipeCloudButton).setOnClickListener { confirmWipeCloud() }
        findViewById<Button>(R.id.wipeLocalButton).setOnClickListener { confirmWipeLocal() }

        findViewById<Button>(R.id.copyLogsButton).setOnClickListener { copyLogs() }
        findViewById<Button>(R.id.sendLogsButton).setOnClickListener { sendLogs() }
        findViewById<Button>(R.id.clearLogsButton).setOnClickListener { clearLogs() }
        findViewById<Button>(R.id.clearAiButton).setOnClickListener { confirmClearAllAnalyses() }

        findViewById<Button>(R.id.logoutButton).setOnClickListener {
            SessionManager.logout(this)
            // Offline-first: drop back into the local gallery, don't force login.
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK))
        }

        findViewById<TextView>(R.id.versionInfo).text =
            "DiscorDrive Gallery v${packageManager.getPackageInfo(packageName, 0).versionName}"

        findViewById<Button>(R.id.checkUpdateButton).setOnClickListener { Updater.check(this, manual = true) }
    }

    /** Asks whether to pull full files or just previews (offline gallery) from the cloud. */
    private fun chooseDownloadMode() {
        val options = arrayOf(
            getString(R.string.download_full_files),
            getString(R.string.download_previews_only),
        )
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.sync_from_cloud_action)
            .setItems(options) { _, which ->
                val mode = if (which == 0) SyncWorker.MODE_DOWNLOAD else SyncWorker.MODE_DOWNLOAD_PREVIEWS
                SyncWorker.runNow(this, mode)
                val msg = if (which == 0) R.string.download_started_bg else R.string.previews_started_bg
                Snackbar.make(findViewById(R.id.settingsRoot), msg, Snackbar.LENGTH_LONG).show()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /**
     * Fetches `GET {url}/v1/models` (OpenAI format) and lets the user pick one
     * into [target] — no more typing model names from memory. Reads the URL/key
     * straight from the (possibly unsaved) fields so it works pre-save.
     */
    private fun pickModelFromEndpoint(url: String, apiKey: String, target: EditText) {
        if (url.isBlank()) {
            Snackbar.make(findViewById(R.id.settingsRoot), R.string.models_need_url, Snackbar.LENGTH_SHORT).show()
            return
        }
        val bar = Snackbar.make(findViewById(R.id.settingsRoot), R.string.models_fetching, Snackbar.LENGTH_INDEFINITE)
        bar.show()
        thread {
            val result = runCatching { com.discordrive.gallery.api.AiVisionClient.fetchModels(url.trim(), apiKey.trim()) }
            runOnUiThread {
                bar.dismiss()
                if (isFinishing || isDestroyed) return@runOnUiThread
                result.onSuccess { models ->
                    if (models.isEmpty()) {
                        Snackbar.make(findViewById(R.id.settingsRoot), getString(R.string.models_fetch_failed, "pusta lista"), Snackbar.LENGTH_LONG).show()
                        return@onSuccess
                    }
                    val current = models.indexOf(target.text.toString().trim())
                    MaterialAlertDialogBuilder(this)
                        .setTitle(R.string.models_picker_title)
                        .setSingleChoiceItems(models.toTypedArray(), current) { dialog, which ->
                            target.setText(models[which])
                            dialog.dismiss()
                        }
                        .setNegativeButton(android.R.string.cancel, null)
                        .show()
                }.onFailure { e ->
                    AppLog.w("Settings", "fetch models failed", e)
                    Snackbar.make(findViewById(R.id.settingsRoot), getString(R.string.models_fetch_failed, e.message ?: "?"), Snackbar.LENGTH_LONG).show()
                }
            }
        }
    }

    /** Single-choice picker for the video double-tap seek step. */
    private fun pickVideoSeek() {
        val labels = Settings.VIDEO_SEEK_OPTIONS.map { getString(R.string.video_seek_option, it) }.toTypedArray()
        val current = Settings.VIDEO_SEEK_OPTIONS.indexOf(Settings.videoSeekSeconds(this)).coerceAtLeast(0)
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.video_seek_picker_title)
            .setSingleChoiceItems(labels, current) { dialog, which ->
                Settings.setVideoSeekSeconds(this, Settings.VIDEO_SEEK_OPTIONS[which])
                dialog.dismiss()
                backupSettings()
                Snackbar.make(findViewById(R.id.settingsRoot), R.string.settings_saved, Snackbar.LENGTH_SHORT).show()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // === Private folders ===

    private fun setupPrivateSection() {
        val pinButton = findViewById<Button>(R.id.privatePinButton)
        val biometric = findViewById<MaterialSwitch>(R.id.privateBiometricSwitch)
        pinButton.setText(if (PrivateAlbums.hasPin(this)) R.string.private_change_pin else R.string.private_set_pin)
        pinButton.setOnClickListener { changePinDialog(pinButton) }
        biometric.isChecked = PrivateAlbums.biometricsEnabled(this)
        biometric.setOnCheckedChangeListener { _, checked ->
            when {
                !checked -> PrivateAlbums.setBiometricsEnabled(this, false)
                !PrivateAlbums.hasPin(this) -> {
                    biometric.isChecked = false
                    Snackbar.make(findViewById(R.id.settingsRoot), R.string.private_need_pin_first, Snackbar.LENGTH_SHORT).show()
                }
                !PrivateUnlock.biometricsAvailable(this) -> {
                    biometric.isChecked = false
                    Snackbar.make(findViewById(R.id.settingsRoot), R.string.private_biometric_unavailable, Snackbar.LENGTH_LONG).show()
                }
                else -> PrivateAlbums.setBiometricsEnabled(this, true)
            }
        }
    }

    /** Sets or changes the private-folders PIN; changing requires the current code. */
    private fun changePinDialog(pinButton: Button) {
        val view = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(48, 16, 48, 0)
        }
        fun pinField(hintRes: Int) = EditText(this).apply {
            inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = getString(hintRes)
            view.addView(this)
        }
        val hasPin = PrivateAlbums.hasPin(this)
        val oldPin = if (hasPin) pinField(R.string.private_pin_old) else null
        val newPin = pinField(R.string.private_pin_new)
        val repeatPin = pinField(R.string.private_pin_repeat)

        MaterialAlertDialogBuilder(this)
            .setTitle(if (hasPin) R.string.private_change_pin else R.string.private_set_pin)
            .setView(view)
            .setPositiveButton(R.string.settings_save) { _, _ ->
                val error = when {
                    hasPin && !PrivateAlbums.verifyPin(this, oldPin?.text.toString()) -> R.string.private_pin_wrong
                    newPin.text.toString().length < 4 -> R.string.private_pin_short
                    newPin.text.toString() != repeatPin.text.toString() -> R.string.private_pin_mismatch
                    else -> null
                }
                if (error != null) {
                    Snackbar.make(findViewById(R.id.settingsRoot), error, Snackbar.LENGTH_LONG).show()
                } else {
                    PrivateAlbums.setPin(this, newPin.text.toString())
                    pinButton.setText(R.string.private_change_pin)
                    Snackbar.make(findViewById(R.id.settingsRoot), R.string.private_pin_saved, Snackbar.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // === Appearance ===

    /** Single-choice accent picker; applies immediately by recreating the screen. */
    private fun pickAccent() {
        val labels = Settings.ACCENTS.map { getString(it.labelRes) }.toTypedArray()
        val current = Settings.ACCENTS.indexOfFirst { it.key == Settings.accentKey(this) }.coerceAtLeast(0)
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.accent_picker_title)
            .setSingleChoiceItems(labels, current) { dialog, which ->
                Settings.setAccent(this, Settings.ACCENTS[which].key)
                dialog.dismiss()
                backupSettings()
                Snackbar.make(findViewById(R.id.settingsRoot), R.string.accent_changed, Snackbar.LENGTH_SHORT).show()
                recreate() // re-inflate with the new accent overlay
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** Best-effort E2EE push of the settings backup (so the pick follows the account). */
    private fun backupSettings() {
        val client = SessionManager.client ?: return
        val filesKey = SessionManager.filesKey ?: return
        thread {
            runCatching { SettingsSync.push(this, client, filesKey) }
                .onFailure { AppLog.w("Settings", "settings backup push failed", it) }
        }
    }

    // === Danger zone ===

    /** Confirms, then permanently deletes ALL files, folders and AI analyses from the cloud. */
    private fun confirmWipeCloud() = requireSession {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.danger_wipe_cloud_title)
            .setMessage(R.string.danger_wipe_cloud_msg)
            .setPositiveButton(R.string.danger_wipe_cloud_confirm) { _, _ -> wipeCloud() }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun wipeCloud() {
        val client = SessionManager.client ?: return
        val bar = Snackbar.make(findViewById(R.id.settingsRoot), R.string.danger_wipe_cloud_progress, Snackbar.LENGTH_INDEFINITE)
        bar.show()
        thread {
            var files = 0
            var folders = 0
            runCatching {
                // 1) trash every live file, then purge the whole trash (chunks + manifests + Discord msgs)
                val live = client.galleryDeltaAll(null).files.filter { it.deletedAt == null }
                for (f in live) runCatching { client.deleteFile(f.id); files++ }
                    .onFailure { AppLog.w("Settings", "wipe: deleteFile ${f.id} failed", it) }
                runCatching { client.emptyTrash() }.onFailure { AppLog.w("Settings", "wipe: emptyTrash failed", it) }
                // 2) remove now-empty folders
                for (folder in client.folders(null)) runCatching { client.deleteFolder(folder.id); folders++ }
                    .onFailure { AppLog.w("Settings", "wipe: deleteFolder ${folder.id} failed", it) }
                // 3) AI enrichments (all) + the E2EE cloud index
                runCatching { client.deleteEnrichments(null) }.onFailure { AppLog.w("Settings", "wipe: deleteEnrichments failed", it) }
                SessionManager.filesKey?.let { EnrichmentIndex.removeAll(client, it) }
                // 4) reset the stale local sync state + cached previews
                val db = AppDb(this)
                db.clearAssetMap(); db.clearCloudItems(); db.clearAllEnrichments()
                java.io.File(filesDir, "previews").deleteRecursively()
            }.onFailure { AppLog.e("Settings", "wipe cloud failed", it) }
            runOnUiThread {
                bar.dismiss()
                Snackbar.make(findViewById(R.id.settingsRoot), getString(R.string.danger_wipe_cloud_done, files, folders), Snackbar.LENGTH_LONG).show()
            }
        }
    }

    /** Confirms, then deletes every local photo/video from the device (MediaStore). */
    private fun confirmWipeLocal() {
        thread {
            val assets = MediaScanner(this).scanAll() // local-only uris
            runOnUiThread {
                if (assets.isEmpty()) {
                    Snackbar.make(findViewById(R.id.settingsRoot), R.string.danger_wipe_local_empty, Snackbar.LENGTH_SHORT).show()
                    return@runOnUiThread
                }
                MaterialAlertDialogBuilder(this)
                    .setTitle(R.string.danger_wipe_local_title)
                    .setMessage(getString(R.string.danger_wipe_local_msg, assets.size))
                    .setPositiveButton(R.string.danger_wipe_local_confirm) { _, _ -> wipeLocal(assets) }
                    .setNegativeButton(android.R.string.cancel, null)
                    .show()
            }
        }
    }

    private fun wipeLocal(assets: List<MediaAsset>) {
        val uris = assets.map { it.uri }
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            // Android shows its own batch delete confirmation for these uris.
            val request = MediaStore.createDeleteRequest(contentResolver, uris)
            wipeLocalLauncher.launch(IntentSenderRequest.Builder(request.intentSender).build())
        } else {
            thread {
                uris.forEach { runCatching { contentResolver.delete(it, null, null) } }
                runOnUiThread { Snackbar.make(findViewById(R.id.settingsRoot), R.string.danger_wipe_local, Snackbar.LENGTH_SHORT).show() }
            }
        }
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
                    val db = AppDb(this)
                    db.clearAllEnrichments()
                    SessionManager.filesKey?.let { EnrichmentIndex.removeAll(client, it) } // reflect clear in cloud index
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

    private fun clearLogs() {
        AppLog.clear()
        Snackbar.make(findViewById(R.id.settingsRoot), R.string.diag_cleared, Snackbar.LENGTH_SHORT).show()
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
