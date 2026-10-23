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
        root.addView(text(getString(R.string.ddn_set_trash_note) + (DdnApp.lastClean(this)?.let { "\n" + getString(R.string.ddn_set_trash_last, it.substringAfter(' ')) } ?: ""), dim = true))

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
            !DdnApp.canInstall(this) -> AlertDialog.Builder(this).setMessage(R.string.update_need_permission)
                .setPositiveButton(android.R.string.ok) { _, _ -> startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
                .setNegativeButton(android.R.string.cancel, null).show()
            else -> downloadAndInstall(b)
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

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // ── for the instrumentation test ──
    internal fun updateStateForTest(): String = updState.text.toString()
    internal fun foundForTest(): AppUpdates.Build? = found
}
