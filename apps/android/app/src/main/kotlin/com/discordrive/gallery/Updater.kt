package com.discordrive.gallery

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.FileProvider
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.progressindicator.LinearProgressIndicator
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Self-hosted APK auto-updater for the sideloaded build. Checks a small JSON
 * manifest next to the APK ([MANIFEST_URL]); if its versionCode is newer than
 * the installed one, downloads the APK and launches the system installer
 * (needs the user's one-time "install unknown apps" grant). No store involved.
 */
object Updater {

    private const val MANIFEST_URL = "https://example.com/apk/latest.json"

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    private data class Release(val versionCode: Long, val versionName: String, val url: String, val notes: String)

    /** @param manual true when triggered from Settings (shows "up to date" / errors). */
    fun check(activity: Activity, manual: Boolean = false) {
        thread {
            val release = runCatching { fetchLatest() }.getOrNull()
            val current = runCatching {
                activity.packageManager.getPackageInfo(activity.packageName, 0).longVersionCode
            }.getOrDefault(Long.MAX_VALUE)

            activity.runOnUiThread {
                when {
                    release == null -> if (manual) toast(activity, activity.getString(R.string.update_check_failed))
                    release.versionCode > current -> promptUpdate(activity, release)
                    manual -> toast(activity, activity.getString(R.string.update_up_to_date))
                }
            }
        }
    }

    private fun fetchLatest(): Release {
        http.newCall(Request.Builder().url(MANIFEST_URL).build()).execute().use { resp ->
            val body = resp.body?.string() ?: throw IllegalStateException("empty manifest")
            if (!resp.isSuccessful) throw IllegalStateException("HTTP ${resp.code}")
            val o = JSONObject(body)
            return Release(
                versionCode = o.getLong("versionCode"),
                versionName = o.optString("versionName"),
                url = o.getString("url"),
                notes = o.optString("notes"),
            )
        }
    }

    private fun promptUpdate(activity: Activity, release: Release) {
        val message = buildString {
            append(activity.getString(R.string.update_available_msg, release.versionName))
            if (release.notes.isNotBlank()) append("\n\n").append(release.notes)
        }
        MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.update_available_title)
            .setMessage(message)
            .setPositiveButton(R.string.update_install) { _, _ -> ensureCanInstall(activity) { download(activity, release) } }
            .setNegativeButton(R.string.update_later, null)
            .show()
    }

    /** Android 8+ needs per-app "install unknown apps"; route to settings if missing. */
    private fun ensureCanInstall(activity: Activity, onReady: () -> Unit) {
        if (activity.packageManager.canRequestPackageInstalls()) {
            onReady()
        } else {
            MaterialAlertDialogBuilder(activity)
                .setMessage(R.string.update_need_permission)
                .setPositiveButton(android.R.string.ok) { _, _ ->
                    activity.startActivity(
                        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
                    )
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }
    }

    private fun download(activity: Activity, release: Release) {
        val progress = LinearProgressIndicator(activity).apply { isIndeterminate = true; max = 100 }
        val label = TextView(activity).apply {
            text = activity.getString(R.string.update_downloading)
            setPadding(48, 48, 48, 24)
        }
        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            addView(label)
            addView(progress, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(48, 0, 48, 48) })
        }
        val dialog = MaterialAlertDialogBuilder(activity).setView(container).setCancelable(false).show()

        thread {
            val ok = runCatching {
                val file = File(activity.cacheDir, "update.apk")
                http.newCall(Request.Builder().url(release.url).build()).execute().use { resp ->
                    if (!resp.isSuccessful) throw IllegalStateException("HTTP ${resp.code}")
                    val body = resp.body ?: throw IllegalStateException("empty body")
                    val total = body.contentLength()
                    body.byteStream().use { input ->
                        file.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            var read: Int
                            var done = 0L
                            while (input.read(buf).also { read = it } >= 0) {
                                out.write(buf, 0, read)
                                done += read
                                if (total > 0) {
                                    val pct = (done * 100 / total).toInt()
                                    activity.runOnUiThread { progress.isIndeterminate = false; progress.progress = pct }
                                }
                            }
                        }
                    }
                }
                file
            }
            activity.runOnUiThread {
                dialog.dismiss()
                ok.onSuccess { installApk(activity, it) }
                    .onFailure {
                        AppLog.w("Updater", "download failed", it)
                        toast(activity, activity.getString(R.string.update_check_failed))
                    }
            }
        }
    }

    private fun installApk(activity: Activity, file: File) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { activity.startActivity(intent) }
            .onFailure { toast(activity, activity.getString(R.string.update_check_failed)) }
    }

    private fun toast(activity: Activity, msg: String) =
        android.widget.Toast.makeText(activity, msg, android.widget.Toast.LENGTH_LONG).show()
}
