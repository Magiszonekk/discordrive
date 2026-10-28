package com.discordrive.gallery

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.text.format.DateUtils
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.work.WorkInfo
import androidx.work.WorkManager
import kotlin.concurrent.thread

/**
 * "Share → discordrive": files from other apps go into the upload queue (copied into the app's storage, a
 * share grant ends with the share), into the folder "Z telefonu" of the account; the upload job sends them in
 * the background with a notification.
 */
class DdnShareActivity : AppCompatActivity() {
    /** Photos of the phone keep their GPS position: the permission is asked for before they are read. */
    private val gate = LocationGate(this) { queue() }

    private fun uris(): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(intent.parcel(Intent.EXTRA_STREAM))
        Intent.ACTION_SEND_MULTIPLE -> intent.parcelList(Intent.EXTRA_STREAM)
        else -> emptyList()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (DdnAccount.load(this) == null) {
            Toast.makeText(this, R.string.ddn_up_no_account, Toast.LENGTH_LONG).show()
            startActivity(Intent(this, JoinActivity::class.java)); finish(); return
        }
        // Made again while the permission's dialog was up (a rotation): its answer comes to the gate's fallback.
        if (savedInstanceState?.getBoolean(ASKING) == true) return
        gate.then(uris()) { queue() }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(ASKING, gate.asking)
    }

    private fun queue() {
        val uris = uris()
        val folder = intent.getStringExtra(EXTRA_FOLDER)
        thread {
            val n = runCatching { DdnUploads.queue(this, uris, folder) }.getOrElse { e -> runOnUiThread { Toast.makeText(this, getString(R.string.ddn_error, e.message), Toast.LENGTH_LONG).show(); finish() }; return@thread }
            runOnUiThread {
                Toast.makeText(this, plq(R.plurals.ddn_up_queued, n, n), Toast.LENGTH_LONG).show()
                finish()
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun Intent.parcel(k: String): Uri? = if (Build.VERSION.SDK_INT >= 33) getParcelableExtra(k, Uri::class.java) else getParcelableExtra(k)
    @Suppress("DEPRECATION")
    private fun Intent.parcelList(k: String): List<Uri> = (if (Build.VERSION.SDK_INT >= 33) getParcelableArrayListExtra(k, Uri::class.java) else getParcelableArrayListExtra(k)) ?: emptyList()

    companion object {
        const val EXTRA_FOLDER = "folder"
        private const val ASKING = "asking-location"
    }
}

object DdnUploads {
    const val SHARED_FOLDER = "Z telefonu"

    /**
     * A shared file's name: the provider's DISPLAY_NAME (MediaStore and document providers answer it), else
     * MediaStore's columns for a content://media URI, else the last path segment with an extension from the
     * type (a bare "30" from content://media/.../30 gets ".jpg").
     */
    fun displayName(c: android.content.Context, u: Uri, type: String? = null): String {
        fun col(vararg cols: String): String? = runCatching {
            c.contentResolver.query(u, cols, null, null, null)?.use { cur -> if (cur.moveToFirst()) cols.indices.firstNotNullOfOrNull { i -> cur.getString(i)?.takeIf { it.isNotBlank() } } else null }
        }.getOrNull()
        col(OpenableColumns.DISPLAY_NAME)?.let { return it }
        if (u.authority == android.provider.MediaStore.AUTHORITY) col(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, android.provider.MediaStore.MediaColumns.TITLE)?.let { return it }
        val last = u.lastPathSegment?.substringAfterLast('/') ?: "plik"
        val t = type ?: runCatching { c.contentResolver.getType(u) }.getOrNull()
        val ext = t?.let { android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
        return if (ext != null && !last.contains('.')) "$last.$ext" else last
    }

    private fun sentPrefs(c: android.content.Context) = c.getSharedPreferences("ddn-sent", android.content.Context.MODE_PRIVATE)
    private fun sentKey(c: android.content.Context, u: Uri, name: String): String {
        val size = runCatching { c.contentResolver.query(u, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { if (it.moveToFirst()) it.getLong(0) else -1 } }.getOrNull() ?: -1
        return "$name|$size"
    }
    /** This file (name and size) was sent through "Open with" before on this phone. */
    fun sentBefore(c: android.content.Context, u: Uri, name: String) = sentPrefs(c).contains(sentKey(c, u, name))
    fun markSent(c: android.content.Context, u: Uri, name: String) = sentPrefs(c).edit().putLong(sentKey(c, u, name), System.currentTimeMillis()).apply()

    /** Queue `uris` into `folderId` (null: "Z telefonu" in the root, made when missing); starts the job. */
    /**
     * Queue `uris` into `folderId`; null: photos and videos only → the Gallery (when the account has it),
     * anything else → "Z telefonu" in the Drive's root (made when missing). Starts the job.
     */
    fun queue(c: android.content.Context, uris: List<Uri>, folderId: String?): Int {
        val s = DdnSession.get(c) ?: throw IllegalStateException("no account")
        val media = folderId == null && uris.isNotEmpty() && uris.all { u -> displayName(c, u).let { DdnSession.isImage(it) || DdnSession.isVideo(it) } }
        val folder = folderId ?: if (media && runCatching { s.gallerySpace }.getOrDefault(false)) s.galleryRoot else s.folderPath(listOf(SHARED_FOLDER))
        var n = 0
        for (u in uris) {
            val name = displayName(c, u)
            DdnBackup.enqueueCopy(c, u, name, folder)
            n++
        }
        if (n > 0) DdnBackup.runNow(c, autoCopy = false)
        return n
    }
}

/**
 * Automatic copy of photos and videos: on / off, the folders (camera by default), Wi-Fi only, while charging
 * only, "Copy now"; the state of the last run and of the running job.
 */
class DdnBackupActivity : AppCompatActivity() {
    private lateinit var state: TextView
    private lateinit var folders: LinearLayout
    private lateinit var failedBox: LinearLayout

    private lateinit var ui: CobaltUi

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        ui = CobaltUi(this)
        val page = ui.screen(R.string.ddn_backup)
        // Files that could not be sent: first, when there are any.
        failedBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        page.addView(failedBox)

        ui.section(page, R.string.ddn_backup, getString(R.string.ddn_backup_where, DdnBackup.rootName(DdnAccount.load(this)?.deviceName ?: "?"))).also { c ->
            ui.switchRow(c, R.string.ddn_backup_on, DdnBackup.enabled(this)) { v, on -> if (on && !hasMedia()) { v.isChecked = false; askMedia() } else { DdnBackup.set(this, on = on); paintLocation(); if (on) askLocationIfNeeded() } }
            ui.switchRow(c, R.string.ddn_backup_wifi, DdnBackup.wifiOnly(this)) { _, v -> DdnBackup.set(this, wifi = v) }
            ui.switchRow(c, R.string.ddn_backup_charging, DdnBackup.chargingOnly(this)) { _, v -> DdnBackup.set(this, charging = v) }
            // The GPS position of photos: without the permission the copies would have it zeroed.
            location = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            c.addView(location, ui.lp(top = 4))
        }
        ui.section(page, R.string.ddn_backup_folders).also { c ->
            folders = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            c.addView(folders, ui.lp(top = 4))
        }
        ui.section(page, R.string.ddn_backup_state_h, getString(R.string.ddn_backup_partial)).also { c ->
            state = ui.text("")
            ui.add(c, state, top = 6)
            ui.add(c, ui.button(R.string.ddn_backup_now, CobaltUi.Kind.PRIMARY, R.drawable.ic_sync) {
                if (!hasMedia()) askMedia()
                else if (!DdnBackup.mayCopyMedia(this)) gate.ask { paintLocation(); if (MediaLocation.granted(this)) { DdnBackup.runNow(this, manual = true); Toast.makeText(this, R.string.ddn_backup_started, Toast.LENGTH_SHORT).show() } }
                else if (DdnBackup.buckets(this).let { chosen -> chosen.isEmpty() || runCatching { DdnBackup.allBuckets(this).keys.none { it in chosen } }.getOrDefault(false) })
                    Toast.makeText(this, R.string.ddn_backup_no_chosen, Toast.LENGTH_LONG).show()
                else { DdnBackup.runNow(this, manual = true); Toast.makeText(this, R.string.ddn_backup_started, Toast.LENGTH_SHORT).show() }
            })
        }
        // Every job of the upload (Copy now, the periodic one, the trigger on new photos): any of them may be running.
        WorkManager.getInstance(this).getWorkInfosLiveData(androidx.work.WorkQuery.fromUniqueWorkNames(DdnBackup.WORKS)).observe(this) { infos = it; paintState(it) }
        paintFolders()
        paintState(emptyList())
        // Opened from "the automatic copy waits for the location" (or with the copy on and access to photos
        // given before): ask now; with access to photos the system grants it without a dialog.
        if (savedInstanceState == null && DdnBackup.enabled(this) && hasMedia()) askLocationIfNeeded()
    }

    private lateinit var location: LinearLayout
    private val gate = LocationGate(this) { paintLocation(); paintState(infos) }
    private var infos: List<WorkInfo> = emptyList()

    /** Asked once by itself; after a refusal only the screen's "Allow" asks again. */
    private fun askLocationIfNeeded() {
        if (!DdnBackup.mayCopyMedia(this)) gate.ask { paintLocation(); DdnBackup.cancelNeedLocation(this); if (MediaLocation.granted(this)) DdnBackup.runNow(this) }
    }

    override fun onResume() {
        super.onResume()
        paintLocation()
        paintState(infos)
    }

    /** Without the permission: why the copies would lose the position, and "Allow". */
    private fun paintLocation() {
        location.removeAllViews()
        // With the automatic copy off nothing waits ("Copy now" asks by itself when tapped).
        if (!DdnBackup.enabled(this) || MediaLocation.granted(this) || !hasMedia()) return
        location.addView(ui.note(getString(if (DdnBackup.locationDeclined(this)) R.string.ddn_loc_declined else R.string.ddn_loc_missing)), ui.lp(top = 8))
        ui.add(location, ui.button(R.string.ddn_loc_allow, CobaltUi.Kind.TONAL) {
            gate.ask {
                // Refused for good (no dialog any more): the app's permissions in the system settings.
                if (!MediaLocation.granted(this)) runCatching { startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
                else { DdnBackup.cancelNeedLocation(this); if (DdnBackup.enabled(this)) DdnBackup.runNow(this) }
                paintLocation()
            }
        }, top = 8)
    }

    private fun mediaPerms(): Array<String> = if (Build.VERSION.SDK_INT >= 33) {
        arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.ACCESS_MEDIA_LOCATION, Manifest.permission.POST_NOTIFICATIONS)
    } else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.ACCESS_MEDIA_LOCATION)

    private fun hasMedia(): Boolean = (if (Build.VERSION.SDK_INT >= 34) listOf(Manifest.permission.READ_MEDIA_IMAGES, "android.permission.READ_MEDIA_VISUAL_USER_SELECTED") else if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.READ_MEDIA_IMAGES) else listOf(Manifest.permission.READ_EXTERNAL_STORAGE))
        .any { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun askMedia() = requestPermissions(mediaPerms() + (if (Build.VERSION.SDK_INT >= 34) arrayOf("android.permission.READ_MEDIA_VISUAL_USER_SELECTED") else emptyArray()), 7)

    @Deprecated("Deprecated in Java")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Only the screen's own request (the location gate's answer also passes here).
        if (requestCode == 7 && hasMedia()) {
            // The dialog asked for the location too: its answer counts as the user's choice.
            if (permissions.contains(Manifest.permission.ACCESS_MEDIA_LOCATION)) DdnBackup.setLocationDeclined(this, !MediaLocation.granted(this))
            DdnBackup.set(this, on = true); recreate()
        }
    }

    private fun paintFolders() {
        thread {
            val all = runCatching { DdnBackup.allBuckets(this) }.getOrDefault(emptyMap())
            runOnUiThread {
                folders.removeAllViews()
                val chosen = DdnBackup.buckets(this).toMutableSet()
                // One switch per phone folder (Camera, Screenshots…) with its count.
                for ((b, n) in all) ui.switchRowText(folders, "$b ($n)", b in chosen) { _, v -> if (v) chosen += b else chosen -= b; DdnBackup.set(this@DdnBackupActivity, buckets = chosen.toSet()) }
                if (all.isEmpty()) folders.addView(ui.note(getString(R.string.ddn_backup_no_folders)))
            }
        }
    }

    /** Files that could not be sent (for good, not a network failure): cause, Retry, Remove. Shown first. */
    internal fun paintFailed() {
        val items = DdnBackup.failed(this)
        failedBox.removeAllViews()
        if (items.isEmpty()) return
        val c = ui.sectionText(failedBox, plq(R.plurals.ddn_fail_title, items.size, items.size), danger = true)
        for (q in items) {
            ui.add(c, ui.text("${q.name}\n${DdnBackup.reason(this@DdnBackupActivity, q.error!!)}"))
            val retry = ui.button(R.string.ddn_fail_retry, CobaltUi.Kind.TONAL) {
                thread { DdnBackup.Db(this@DdnBackupActivity).retry(q.id); runOnUiThread { DdnBackup.runNow(this@DdnBackupActivity, autoCopy = false); paintFailed() } }
            }
            val drop = ui.button(R.string.ddn_fail_remove, CobaltUi.Kind.DANGER) {
                thread { DdnBackup.Db(this@DdnBackupActivity).drop(q.id); runOnUiThread { DdnBackup.notifyFailed(this@DdnBackupActivity, DdnBackup.failed(this@DdnBackupActivity).size); paintFailed() } }
            }
            ui.actionBar(c, retry, drop)
        }
    }

    private fun paintState(infos: List<WorkInfo>) {
        paintFailed()
        val run = infos.firstOrNull { it.state == WorkInfo.State.RUNNING }
        state.text = stateText(this, run?.let { Running(it.progress.getInt("done", 0), it.progress.getInt("total", 0), it.progress.getString("line")) }, DdnBackup.status(this))
    }

    internal fun stateForTest(): String = state.text.toString()
    internal fun locationNoteForTest(): Boolean = location.childCount > 0

    /** A run in progress: the series' count (see [BackupSeries]) and the file being sent. */
    internal data class Running(val done: Int, val total: Int, val line: String?)

    companion object {
        /**
         * The state section: a run in progress first (its series count), then the last finished run. While a
         * run goes on, the last run's error is not shown: it belongs to the run before (a network failure, the
         * wait for the photos' location) and the current one is trying again.
         */
        internal fun stateText(c: android.content.Context, run: Running?, st: DdnBackup.Status?): String = buildString {
            if (run != null) append(if (run.total > 0) c.getString(R.string.ddn_backup_running, run.done, run.total, run.line ?: "") else c.getString(R.string.ddn_backup_running_start)).append("\n")
            if (st != null) {
                append(c.getString(R.string.ddn_backup_last, Ago.of(c, st.at), st.copied, st.waiting))
                if (run == null) st.error?.let { append("\n").append(c.getString(R.string.ddn_error, it)) }
            } else if (run == null) append(c.getString(R.string.ddn_backup_never))
        }.trimEnd()
    }
}
