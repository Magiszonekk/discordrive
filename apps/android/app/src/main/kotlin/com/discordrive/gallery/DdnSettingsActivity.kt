package com.discordrive.gallery

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.format.Formatter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
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
    private lateinit var updButton: Button
    private lateinit var updProgress: ProgressBar
    private var found: AppUpdates.Build? = null
    @Volatile private var downloading = false
    private lateinit var pinButton: Button
    private lateinit var removePin: Button
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
        super.onCreate(savedInstanceState)
        title = getString(R.string.ddn_settings)
        val pad = dp(16)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad); setBackgroundColor(getColor(R.color.bg)) }
        fun head(s: Int) = TextView(this).apply { text = getString(s); textSize = 13f; setTextColor(getColor(R.color.accent)); setPadding(0, dp(18), 0, dp(6)) }
        fun text(s: CharSequence, dim: Boolean = false) = TextView(this).apply { text = s; textSize = if (dim) 13f else 15f; setTextColor(getColor(if (dim) R.color.text_dim else R.color.text)); setPadding(0, dp(4), 0, dp(4)) }
        fun button(s: Int, f: () -> Unit) = Button(this).apply { text = getString(s); setOnClickListener { f() } }

        val acct = DdnAccount.load(this)
        root.addView(head(R.string.ddn_set_account))
        root.addView(text(if (acct != null) getString(R.string.ddn_set_device, acct.deviceName, Uri.parse(acct.serverUrl).host ?: acct.serverUrl) else getString(R.string.ddn_up_no_account)))

        // Version and updates.
        val (code, name) = DdnApp.installedVersion(this)
        root.addView(head(R.string.ddn_set_updates))
        root.addView(text(getString(R.string.ddn_set_version, name, code)).apply { tag = "ddn-version" })
        root.addView(SwitchCompat(this).apply {
            text = getString(R.string.ddn_set_check_updates); isChecked = DdnApp.checkUpdates(this@DdnSettingsActivity)
            textSize = 15f; setTextColor(getColor(R.color.text)); setPadding(0, dp(4), 0, dp(4))
            setOnCheckedChangeListener { _, v -> DdnApp.setCheckUpdates(this@DdnSettingsActivity, v) }
        })
        updState = text("", dim = true)
        updProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000; visibility = android.view.View.GONE }
        updButton = button(R.string.ddn_upd_check) { onUpdateButton() }
        root.addView(updState)
        root.addView(updProgress)
        root.addView(updButton)

        // Automatic copy, trash.
        root.addView(head(R.string.ddn_set_more))
        root.addView(button(R.string.ddn_backup) { startActivity(Intent(this, DdnBackupActivity::class.java)) })
        root.addView(button(R.string.ddn_trash) { DdnTrashActivity.open(this) })
        root.addView(button(R.string.ddn_free) { startActivity(Intent(this, DdnFreeUpActivity::class.java)) })
        root.addView(button(R.string.ddn_ai_title) { startActivity(Intent(this, DdnAiActivity::class.java)) })

        // Private albums: the PIN (set, change, remove) and fingerprint.
        root.addView(head(R.string.private_title))
        root.addView(text(getString(R.string.ddn_private_note), dim = true))
        pinButton = button(if (PrivateAlbums.hasPin(this)) R.string.private_change_pin else R.string.private_set_pin) { setPinDialog() }
        removePin = button(R.string.ddn_pin_remove) { removePinDialog() }.apply { visibility = if (PrivateAlbums.hasPin(this@DdnSettingsActivity)) android.view.View.VISIBLE else android.view.View.GONE }
        root.addView(pinButton)
        root.addView(removePin)
        root.addView(SwitchCompat(this).apply {
            text = getString(R.string.private_biometric_switch); textSize = 15f; setTextColor(getColor(R.color.text)); setPadding(0, dp(4), 0, dp(4))
            isChecked = PrivateAlbums.biometricsEnabled(this@DdnSettingsActivity)
            setOnCheckedChangeListener { v, on ->
                when {
                    on && !PrivateAlbums.hasPin(this@DdnSettingsActivity) -> { v.isChecked = false; Toast.makeText(this@DdnSettingsActivity, R.string.private_need_pin_first, Toast.LENGTH_SHORT).show() }
                    on && !PrivateUnlock.biometricsAvailable(this@DdnSettingsActivity) -> { v.isChecked = false; Toast.makeText(this@DdnSettingsActivity, R.string.private_biometric_unavailable, Toast.LENGTH_LONG).show() }
                    else -> PrivateAlbums.setBiometricsEnabled(this@DdnSettingsActivity, on)
                }
            }
        })
        root.addView(text(getString(R.string.ddn_set_trash_note) + (DdnApp.lastClean(this)?.let { "\n" + getString(R.string.ddn_set_trash_last, cleanText(it)) } ?: ""), dim = true))

        // Opening photos and videos from other apps (Files, a messenger): the system's "Open with" / default app.
        root.addView(head(R.string.ddn_set_open_with))
        root.addView(text(getString(R.string.ddn_set_open_with_note), dim = true))
        root.addView(button(R.string.ddn_set_default_gallery) { openDefaults() })

        // Leave the account on this phone.
        root.addView(head(R.string.ddn_set_leave_h))
        root.addView(button(R.string.ddn_set_leave) { confirmLeave() })

        setContentView(ScrollView(this).apply { addView(root) })
        Insets.apply(root)
        checkUpdate(manual = false)
    }

    private fun onUpdateButton() {
        val b = found
        when {
            downloading -> return
            b == null -> checkUpdate(manual = true)
            !DdnApp.canInstall(this) -> AlertDialog.Builder(this).setMessage(getString(R.string.update_need_permission) + "\n\n" + getString(R.string.ddn_upd_play_protect))
                .setPositiveButton(android.R.string.ok) { _, _ -> installAfterPermission = true; startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
                .setNegativeButton(android.R.string.cancel, null).show()
            else -> AlertDialog.Builder(this).setTitle(getString(R.string.ddn_upd_available, b.versionName)).setMessage(R.string.ddn_upd_play_protect)
                .setPositiveButton(R.string.ddn_upd_install) { _, _ -> downloadAndInstall(b) }
                .setNegativeButton(android.R.string.cancel, null).show()
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
        AlertDialog.Builder(this).setTitle(R.string.ddn_set_leave).setMessage(R.string.ddn_set_leave_ask)
            .setPositiveButton(R.string.ddn_set_leave) { _, _ ->
                DdnBackup.set(this, on = false)
                DdnSession.forget(this)
                DdnAccount.forget(this)
                startActivity(Intent(this, JoinActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                finish()
            }
            .setNegativeButton(android.R.string.cancel, null).show()
    }

    /** "<time> purged N" / "<time> <reason>" (the background job's note) in words. */
    private fun cleanText(note: String): String {
        val at = note.substringBefore(' ').toLongOrNull()?.let { android.text.format.DateUtils.getRelativeTimeSpanString(it).toString() } ?: ""
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
        }
        val old = field(R.string.private_pin_old)
        val new1 = field(R.string.private_pin_new)
        val new2 = field(R.string.private_pin_repeat)
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), 0); if (has) addView(old); addView(new1); addView(new2) }
        val d = AlertDialog.Builder(this).setTitle(if (has) R.string.private_change_pin else R.string.private_set_pin).setView(box)
            .setPositiveButton(android.R.string.ok, null).setNegativeButton(android.R.string.cancel, null).create()
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
    }

    /** Remove the PIN (after it): every private album becomes public again, nothing stays locked without a PIN. */
    private fun removePinDialog() {
        PrivateUnlock.unlock(this) {
            AlertDialog.Builder(this).setMessage(R.string.ddn_pin_remove_ask)
                .setPositiveButton(R.string.ddn_pin_remove) { _, _ ->
                    SecureStore(this).remove(SecureStore.PRIVATE_PIN)
                    PrivateAlbums.setBiometricsEnabled(this, false)
                    DdnPrivate.clear(this)
                    pinButton.text = getString(R.string.private_set_pin)
                    removePin.visibility = android.view.View.GONE
                    Toast.makeText(this, R.string.ddn_pin_removed, Toast.LENGTH_SHORT).show()
                }
                .setNegativeButton(android.R.string.cancel, null).show()
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // ── for the instrumentation test ──
    internal fun updateStateForTest(): String = updState.text.toString()
    internal fun foundForTest(): AppUpdates.Build? = found
}
