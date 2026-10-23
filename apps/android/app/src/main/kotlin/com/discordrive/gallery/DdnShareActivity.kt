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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uris: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.parcel(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> intent.parcelList(Intent.EXTRA_STREAM)
            else -> emptyList()
        }
        if (DdnAccount.load(this) == null) {
            Toast.makeText(this, R.string.ddn_up_no_account, Toast.LENGTH_LONG).show()
            startActivity(Intent(this, JoinActivity::class.java)); finish(); return
        }
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
    fun queue(c: android.content.Context, uris: List<Uri>, folderId: String?): Int {
        val s = DdnSession.get(c) ?: throw IllegalStateException("no account")
        val folder = folderId ?: s.folderPath(listOf(SHARED_FOLDER))
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = getString(R.string.ddn_backup)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        fun text(s: CharSequence, size: Float = 14f) = TextView(this).apply { text = s; textSize = size; setTextColor(getColor(R.color.text)); setPadding(0, pad / 2, 0, pad / 2) }

        val on = SwitchCompat(this).apply { text = getString(R.string.ddn_backup_on); isChecked = DdnBackup.enabled(this@DdnBackupActivity); textSize = 16f }
        val wifi = CheckBox(this).apply { text = getString(R.string.ddn_backup_wifi); isChecked = DdnBackup.wifiOnly(this@DdnBackupActivity) }
        val charging = CheckBox(this).apply { text = getString(R.string.ddn_backup_charging); isChecked = DdnBackup.chargingOnly(this@DdnBackupActivity) }
        val where = text(getString(R.string.ddn_backup_where, DdnBackup.rootName(DdnAccount.load(this)?.deviceName ?: "?")), 13f).apply { setTextColor(getColor(R.color.text_dim)) }
        folders = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val now = Button(this).apply { text = getString(R.string.ddn_backup_now) }
        state = text("", 13f).apply { setTextColor(getColor(R.color.text_dim)) }
        val partial = text(getString(R.string.ddn_backup_partial), 13f).apply { setTextColor(getColor(R.color.text_dim)) }

        on.setOnCheckedChangeListener { _, v -> if (v && !hasMedia()) askMedia() else DdnBackup.set(this, on = v) }
        wifi.setOnCheckedChangeListener { _, v -> DdnBackup.set(this, wifi = v) }
        charging.setOnCheckedChangeListener { _, v -> DdnBackup.set(this, charging = v) }
        now.setOnClickListener { if (!hasMedia()) askMedia() else { DdnBackup.runNow(this); Toast.makeText(this, R.string.ddn_backup_started, Toast.LENGTH_SHORT).show() } }

        for (v in listOf(on, where, wifi, charging, text(getString(R.string.ddn_backup_folders), 15f), folders, now, state, partial)) root.addView(v)
        setContentView(ScrollView(this).apply { addView(root) })
        Insets.apply(root)
        WorkManager.getInstance(this).getWorkInfosForUniqueWorkLiveData(DdnBackup.WORK_NOW).observe(this) { paintState(it) }
        paintFolders()
        paintState(emptyList())
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
        if (hasMedia()) { DdnBackup.set(this, on = true); recreate() }
    }

    private fun paintFolders() {
        thread {
            val all = runCatching { DdnBackup.allBuckets(this) }.getOrDefault(emptyMap())
            runOnUiThread {
                folders.removeAllViews()
                val chosen = DdnBackup.buckets(this).toMutableSet()
                for ((b, n) in all) folders.addView(CheckBox(this).apply {
                    text = "$b ($n)"; isChecked = b in chosen
                    setOnCheckedChangeListener { _, v -> if (v) chosen += b else chosen -= b; DdnBackup.set(this@DdnBackupActivity, buckets = chosen.toSet()) }
                }, ViewGroup.LayoutParams(-1, -2))
                if (all.isEmpty()) folders.addView(TextView(this).apply { text = getString(R.string.ddn_backup_no_folders); setTextColor(getColor(R.color.text_dim)) })
            }
        }
    }

    private fun paintState(infos: List<WorkInfo>) {
        val run = infos.firstOrNull { it.state == WorkInfo.State.RUNNING }
        val st = DdnBackup.status(this)
        state.text = buildString {
            if (run != null) append(getString(R.string.ddn_backup_running, run.progress.getInt("done", 0), run.progress.getInt("total", 0), run.progress.getString("line") ?: "")).append("\n")
            if (st != null) {
                append(getString(R.string.ddn_backup_last, DateUtils.getRelativeTimeSpanString(st.at), st.copied, st.waiting))
                st.error?.let { append("\n").append(getString(R.string.ddn_error, it)) }
            } else append(getString(R.string.ddn_backup_never))
        }
    }
}
