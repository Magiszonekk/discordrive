package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest

/**
 * Updates of the Android app from GitHub Releases (no store): the pre-release `android-main-build` holds the
 * signed APK of the newest main and `android-build.json` ({versionCode, versionName, commit, apk, sha256}).
 * A build is offered only when its versionCode is higher than the installed one (CI: the run number grows);
 * the APK is checked against the SHA-256 of that file before the system installer gets it, and the system
 * checks the signature (an APK signed with another key cannot replace the app).
 */
class AppUpdates(
    private val http: OkHttpClient = defaultHttp(),
    private val apiBase: String = "https://api.github.com",
    private val repo: String = "Magiszonekk/discordrive",
    private val tag: String = "android-main-build",
) {
    data class Build(val versionCode: Long, val versionName: String, val commit: String, val apkUrl: String, val apkSize: Long, val sha256: String, val publishedAt: String, val notes: String)

    class UpdateException(message: String) : RuntimeException(message)

    /** The published build (null: no release, or GitHub refused / rate-limited). */
    fun latest(): Build? {
        val rel = get("$apiBase/repos/$repo/releases/tags/$tag", "application/vnd.github+json") ?: return null
        val o = json.parseToJsonElement(rel.toString(Charsets.UTF_8)).jsonObject
        val assets = (o["assets"] as? JsonArray)?.map { it.jsonObject } ?: return null
        fun asset(name: String) = assets.firstOrNull { it.strOrNull("name") == name }
        val info = asset("android-build.json")?.strOrNull("browser_download_url")?.let { get(it, null) } ?: return null
        val bi = json.parseToJsonElement(info.toString(Charsets.UTF_8)).jsonObject
        val apk = asset(bi.str("apk")) ?: return null
        return Build(
            versionCode = bi.getValue("versionCode").jsonPrimitive.long,
            versionName = bi.strOrNull("versionName") ?: "",
            commit = bi.strOrNull("commit") ?: "",
            apkUrl = apk.str("browser_download_url"),
            apkSize = apk.longOrNull("size") ?: 0,
            sha256 = bi.str("sha256").lowercase(),
            publishedAt = o.strOrNull("published_at") ?: "",
            notes = o.strOrNull("body") ?: "",
        )
    }

    /**
     * Download the APK into `dest`, checking its SHA-256 (a mismatch deletes the file). An earlier download of
     * the same build that is still complete and matches is reused. `progress(done, total)`.
     */
    fun download(b: Build, dest: File, progress: (Long, Long) -> Unit = { _, _ -> }, cancelled: () -> Boolean = { false }): File {
        if (dest.isFile && sha256File(dest) == b.sha256) return dest
        val part = File(dest.path + ".part")
        val md = MessageDigest.getInstance("SHA-256")
        http.newCall(Request.Builder().url(b.apkUrl).header("user-agent", "discordrive-android").build()).execute().use { res ->
            if (!res.isSuccessful) throw UpdateException("download: HTTP ${res.code}")
            val body = res.body ?: throw UpdateException("download: empty answer")
            val total = body.contentLength().takeIf { it > 0 } ?: b.apkSize
            var done = 0L
            part.outputStream().use { out: OutputStream ->
                body.byteStream().use { inp ->
                    val buf = ByteArray(128 * 1024)
                    while (true) {
                        if (cancelled()) { part.delete(); throw UpdateException("cancelled") }
                        val n = inp.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        md.update(buf, 0, n)
                        done += n
                        progress(done, total)
                    }
                }
            }
        }
        val got = md.digest().joinToString("") { "%02x".format(it) }
        if (got != b.sha256) {
            part.delete()
            throw UpdateException("the downloaded file does not match its checksum (deleted)")
        }
        dest.delete()
        if (!part.renameTo(dest)) throw UpdateException("cannot keep the downloaded file")
        return dest
    }

    private fun get(url: String, accept: String?): ByteArray? {
        val rb = Request.Builder().url(url).header("user-agent", "discordrive-android")
        if (accept != null) rb.header("accept", accept)
        return runCatching { http.newCall(rb.build()).execute().use { r -> if (r.isSuccessful) r.body?.bytes() else null } }.getOrNull()
    }

    companion object {
        /** Offer it? Only a higher versionCode (a lower or equal one is this build or an older one). */
        fun isNewer(installed: Long, b: Build?): Boolean = b != null && b.versionCode > installed

        fun sha256File(f: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            f.inputStream().use { i -> val buf = ByteArray(128 * 1024); while (true) { val n = i.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
