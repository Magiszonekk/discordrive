package com.discordrive.gallery

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.format.Formatter
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import io.github.magiszonekk.discordrive.core.AppUpdates
import kotlin.concurrent.thread

/**
 * Settings of the discordrive part: this device and its account, the version and updates (GitHub Releases, the
 * system installer; nothing is installed without the user), the automatic copy, the trash, opening photos from
 * other apps, leaving the account on this phone.
 */
class DdnSettingsActivity : AppCompatActivity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var updState: TextView
    private lateinit var updButton: com.google.android.material.button.MaterialButton
    private lateinit var updProgress: ProgressBar
    private var found: AppUpdates.Build? = null
    @Volatile private var downloading = false
    private lateinit var pinButton: com.google.android.material.button.MaterialButton
    private lateinit var removePin: com.google.android.material.button.MaterialButton
    /** The user was sent to allow "install unknown apps": continue the install when back with it allowed. */
    private var installAfterPermission = false

    override fun onResume() {
        super.onResume()
        val b = found
        if (installAfterPermission && b != null && DdnApp.canInstall(this)) {
            installAfterPermission = false
            downloadAndInstall(b)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        val ui = CobaltUi(this)
        val page = ui.screen(R.string.ddn_settings)
        val acct = DdnAccount.load(this)

        // Account and this device.
        ui.section(page, R.string.ddn_set_account).also { c ->
            ui.add(c, ui.text(if (acct != null) getString(R.string.ddn_set_device, acct.deviceName, Uri.parse(acct.serverUrl).host ?: acct.serverUrl) else getString(R.string.ddn_up_no_account)), top = 6)
        }

        // Look: the accent colour (the same choice as the gallery's, applied to every screen).
        ui.section(page, R.string.ddn_set_look, getString(R.string.ddn_set_look_note)).also { c ->
            ui.add(c, ui.button(R.string.accent_picker_title, icon = R.drawable.ic_palette) { pickAccent() })
        }

        // Copies, AI, trash, freeing space.
        ui.section(page, R.string.ddn_set_more, getString(R.string.ddn_set_trash_note) + (DdnApp.lastClean(this)?.let { "\n" + getString(R.string.ddn_set_trash_last, cleanText(it)) } ?: "")).also { c ->
            ui.add(c, ui.button(R.string.ddn_backup, icon = R.drawable.ic_sync) { startActivity(Intent(this, DdnBackupActivity::class.java)) })
            ui.add(c, ui.button(R.string.ddn_ai_title, icon = R.drawable.ic_ai) { startActivity(Intent(this, DdnAiActivity::class.java)) }, top = 8)
            ui.add(c, ui.button(R.string.ddn_trash, icon = R.drawable.ic_delete) { DdnTrashActivity.open(this) }, top = 8)
            ui.add(c, ui.button(R.string.ddn_free, icon = R.drawable.ic_cloud_done) { startActivity(Intent(this, DdnFreeUpActivity::class.java)) }, top = 8)
        }

        // The Safe (its own password; the same Safe as in the browser).
        ui.section(page, R.string.safe_title, getString(R.string.safe_settings_note)).also { c ->
            ui.add(c, ui.button(R.string.safe_title, icon = R.drawable.ic_lock) { DdnSafeActivity.open(this) }, top = 6)
        }

        // Private folders: the PIN (set, change, remove) and fingerprint — here, not the gallery's old screen.
        ui.section(page, R.string.private_title, getString(R.string.ddn_private_note)).also { c ->
            pinButton = ui.button(if (PrivateAlbums.hasPin(this)) R.string.private_change_pin else R.string.private_set_pin, icon = R.drawable.ic_lock) { setPinDialog() }
            removePin = ui.button(R.string.ddn_pin_remove, CobaltUi.Kind.DANGER) { removePinDialog() }.apply { visibility = if (PrivateAlbums.hasPin(this@DdnSettingsActivity)) android.view.View.VISIBLE else android.view.View.GONE }
            ui.add(c, pinButton)
            ui.add(c, removePin, top = 8)
            ui.switchRow(c, R.string.private_biometric_switch, PrivateAlbums.biometricsEnabled(this)) { v, on ->
                when {
                    on && !PrivateAlbums.hasPin(this) -> { v.isChecked = false; Toast.makeText(this, R.string.private_need_pin_first, Toast.LENGTH_SHORT).show() }
                    on && !PrivateUnlock.biometricsAvailable(this) -> { v.isChecked = false; Toast.makeText(this, R.string.private_biometric_unavailable, Toast.LENGTH_LONG).show() }
                    else -> PrivateAlbums.setBiometricsEnabled(this, on)
                }
            }
        }

        // Opening photos and videos from other apps (Files, a messenger): the system's "Open with" / default app.
        ui.section(page, R.string.ddn_set_open_with, getString(R.string.ddn_set_open_with_note)).also { c ->
            ui.add(c, ui.button(R.string.ddn_set_default_gallery) { openDefaults() })
        }

        // Version and updates.
        val (code, name) = DdnApp.installedVersion(this)
        ui.section(page, R.string.ddn_set_updates).also { c ->
            ui.add(c, ui.text(getString(R.string.ddn_set_version, name, code)).apply { tag = "ddn-version" }, top = 6)
            ui.switchRow(c, R.string.ddn_set_check_updates, DdnApp.checkUpdates(this)) { _, v -> DdnApp.setCheckUpdates(this, v) }
            updState = ui.note("")
            ui.add(c, updState, top = 4)
            updProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000; visibility = android.view.View.GONE }
            ui.add(c, updProgress, top = 4)
            updButton = ui.button(R.string.ddn_upd_check, CobaltUi.Kind.PRIMARY) { onUpdateButton() }
            ui.add(c, updButton)
        }

        // Diagnostics: the technical state (moved here from the files' top bar).
        DdnSession.get(this)?.let { sess ->
            ui.section(page, R.string.ddn_set_diag).also { c ->
                ui.add(c, ui.note(getString(R.string.ddn_status, sess.acct.deviceName, sess.headSeq, sess.engineName)), top = 6)
            }
        }

        // Danger zone: leave the account on this phone (only when there is one).
        if (acct != null) ui.section(page, R.string.ddn_set_danger, getString(R.string.ddn_set_leave_ask), danger = true).also { c ->
            ui.add(c, ui.button(R.string.ddn_set_leave, CobaltUi.Kind.DANGER) { confirmLeave() })
        }

        ui.footer(page, getString(R.string.ddn_set_version, name, code))
        checkUpdate(manual = false)
    }

    /** The accent colour (the gallery's list); applies at once (the screen is made again). */
    private fun pickAccent() {
        val labels = com.discordrive.gallery.Settings.ACCENTS.map { getString(it.labelRes) }.toTypedArray()
        val current = com.discordrive.gallery.Settings.ACCENTS.indexOfFirst { it.key == com.discordrive.gallery.Settings.accentKey(this) }.coerceAtLeast(0)
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(R.string.accent_picker_title)
            .setSingleChoiceItems(labels, current) { d, which ->
                com.discordrive.gallery.Settings.setAccent(this, com.discordrive.gallery.Settings.ACCENTS[which].key)
                d.dismiss()
                recreate()
            }
            .setNegativeButton(R.string.cobalt_cancel, null)
            .show()
    }

    private fun onUpdateButton() {
        val b = found
        when {
            downloading -> return
            b == null -> checkUpdate(manual = true)
            !DdnApp.canInstall(this) -> com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setMessage(getString(R.string.update_need_permission) + "\n\n" + getString(R.string.ddn_upd_play_protect))
                .setPositiveButton(R.string.cobalt_ok) { _, _ -> installAfterPermission = true; startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
                .setNegativeButton(R.string.cobalt_cancel, null).show()
            else -> com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setTitle(getString(R.string.ddn_upd_available, b.versionName)).setMessage(R.string.ddn_upd_play_protect)
                .setPositiveButton(R.string.ddn_upd_install) { _, _ -> downloadAndInstall(b) }
                .setNegativeButton(R.string.cobalt_cancel, null).show()
        }
    }

    private fun checkUpdate(manual: Boolean) {
        updState.text = getString(R.string.ddn_upd_checking)
        thread {
            val latest = runCatching { DdnApp.updates().latest() }.getOrNull()
            val installed = DdnApp.installedVersion(this).first
            main.post {
                found = latest?.takeIf { AppUpdates.isNewer(installed, it) }
                updState.text = when {
                    latest == null -> getString(R.string.update_check_failed)
                    found != null -> getString(R.string.ddn_upd_available, found!!.versionName) + " · " + Formatter.formatShortFileSize(this, found!!.apkSize)
                    else -> getString(R.string.update_up_to_date)
                }
                updButton.text = getString(if (found != null) R.string.ddn_upd_install else R.string.ddn_upd_check)
                if (manual && latest == null) Toast.makeText(this, R.string.update_check_failed, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun downloadAndInstall(b: AppUpdates.Build) {
        downloading = true
        updButton.isEnabled = false
        updProgress.visibility = android.view.View.VISIBLE
        thread {
            val r = runCatching {
                val f = DdnApp.download(this, b, { done, total ->
                    main.post {
                        updProgress.progress = if (total > 0) (done * 1000 / total).toInt() else 0
                        updState.text = getString(R.string.ddn_upd_downloading, Formatter.formatShortFileSize(this, done), Formatter.formatShortFileSize(this, total))
                    }
                })
                DdnApp.install(this, f)
            }
            main.post {
                downloading = false
                updButton.isEnabled = true
                updProgress.visibility = android.view.View.GONE
                updState.text = r.fold({ getString(R.string.ddn_upd_confirm) }, { getString(R.string.ddn_upd_failed, it.message) })
            }
        }
    }

    /**
     * Android has no API for an app to make itself the default viewer of images (the gallery role is for system
     * apps only): the system's "Default apps" screen, or the "Open with" choice ("Always") the first time a
     * photo is opened from another app, picks it.
     */
    private fun openDefaults() {
        runCatching { startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)) }
            .onFailure { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
    }

    private fun confirmLeave() {
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setTitle(R.string.ddn_set_leave).setMessage(R.string.ddn_set_leave_ask)
            .setPositiveButton(R.string.ddn_set_leave) { _, _ ->
                // This phone's entry on the account goes too (no stale device left in the list). Offline or the
                // instance refusing: the phone still forgets the account, and says the entry stayed.
                val acct = DdnAccount.load(this)
                // The join screen offers this address again (the same preference it keeps).
                acct?.let { getSharedPreferences("ddn-join", MODE_PRIVATE).edit().putString("server", it.serverUrl).apply() }
                kotlin.concurrent.thread {
                    val revoked = acct == null || runCatching { DdnLeave.revokeSelf(acct) }.isSuccess
                    runOnUiThread {
                        DdnBackup.set(this, on = false)
                        DdnSession.forget(this)
                        DdnAccount.forget(this)
                        if (!revoked) android.widget.Toast.makeText(this, R.string.ddn_set_leave_kept, android.widget.Toast.LENGTH_LONG).show()
                        startActivity(Intent(this, JoinActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                        finish()
                    }
                }
            }
            .setNegativeButton(R.string.cobalt_cancel, null).show()
    }

    /** "<time> purged N" / "<time> <reason>" (the background job's note) in words. */
    private fun cleanText(note: String): String {
        val at = note.substringBefore(' ').toLongOrNull()?.let { Ago.of(this, it) } ?: ""
        val what = note.substringAfter(' ')
        val words = when {
            what.startsWith("purged ") -> getString(R.string.ddn_clean_purged, what.removePrefix("purged ").toIntOrNull() ?: 0)
            what == "primary_cleans" -> getString(R.string.ddn_clean_primary)
            what == "metered" -> getString(R.string.ddn_clean_metered)
            what == "nothing_expired" -> getString(R.string.ddn_clean_nothing)
            else -> getString(R.string.ddn_clean_not_synced)
        }
        return "$at — $words"
    }

    /** Set or change the PIN (the current one first when there is one): two plain number fields. */
    private fun setPinDialog() {
        val has = PrivateAlbums.hasPin(this)
        fun field(hint: Int) = android.widget.EditText(this).apply {
            setHint(hint); inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD
            importantForAutofill = android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            typeface = androidx.core.content.res.ResourcesCompat.getFont(this@DdnSettingsActivity, R.font.inter_regular)
        }
        val old = field(R.string.private_pin_old)
        val new1 = field(R.string.private_pin_new)
        val new2 = field(R.string.private_pin_repeat)
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), 0); if (has) addView(old); addView(new1); addView(new2) }
        val d = com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setTitle(if (has) R.string.private_change_pin else R.string.private_set_pin).setView(box)
            .setPositiveButton(R.string.cobalt_ok, null).setNegativeButton(R.string.cobalt_cancel, null).create()
        d.setOnShowListener {
            d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                when {
                    has && !PrivateAlbums.verifyPin(this, old.text.toString()) -> old.error = getString(R.string.private_pin_wrong)
                    new1.text.length < 4 -> new1.error = getString(R.string.private_pin_short)
                    new1.text.toString() != new2.text.toString() -> new2.error = getString(R.string.private_pin_mismatch)
                    else -> {
                        PrivateAlbums.setPin(this, new1.text.toString())
                        pinButton.text = getString(R.string.private_change_pin)
                        removePin.visibility = android.view.View.VISIBLE
                        Toast.makeText(this, R.string.private_pin_saved, Toast.LENGTH_SHORT).show()
                        d.dismiss()
                    }
                }
            }
        }
        d.show()
        lastDialog = d
    }
    private var lastDialog: androidx.appcompat.app.AlertDialog? = null
    internal fun openPinDialogForTest(): androidx.appcompat.app.AlertDialog? { setPinDialog(); return lastDialog }

    /** Remove the PIN (after it): every private album becomes public again, nothing stays locked without a PIN. */
    private fun removePinDialog() {
        PrivateUnlock.unlock(this) {
            com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setMessage(R.string.ddn_pin_remove_ask)
                .setPositiveButton(R.string.ddn_pin_remove) { _, _ ->
                    SecureStore(this).remove(SecureStore.PRIVATE_PIN)
                    PrivateAlbums.setBiometricsEnabled(this, false)
                    DdnPrivate.clear(this)
                    pinButton.text = getString(R.string.private_set_pin)
                    removePin.visibility = android.view.View.GONE
                    Toast.makeText(this, R.string.ddn_pin_removed, Toast.LENGTH_SHORT).show()
                }
                .setNegativeButton(R.string.cobalt_cancel, null).show()
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // ── for the instrumentation test ──
    internal fun updateStateForTest(): String = updState.text.toString()
    internal fun foundForTest(): AppUpdates.Build? = found
}
