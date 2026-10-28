package com.discordrive.gallery

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import java.io.InputStream

/**
 * The GPS position in photos (and the location of videos) from the phone's media store. Without
 * ACCESS_MEDIA_LOCATION Android hands out a copy with the position zeroed (EXIF GPS 0/0), so a copy in the
 * account would lose it for good. The permission belongs to the "Photos and videos" group: with that access
 * already given, asking for it grants it without a dialog; it is asked whenever the app is about to read photos
 * (sharing, sending, the automatic copy) and when the app starts with access to photos but not to their location
 * (access given by an older version, or through the system settings).
 */
object MediaLocation {
    fun granted(c: Context): Boolean = c.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Access to (some of) the photos given: the location can be granted without a dialog. */
    fun hasMediaAccess(c: Context): Boolean = (when {
        Build.VERSION.SDK_INT >= 34 -> listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, "android.permission.READ_MEDIA_VISUAL_USER_SELECTED")
        Build.VERSION.SDK_INT >= 33 -> listOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else -> listOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }).any { c.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    /** A photo or a video (by its type or name): a file whose position matters. */
    fun isMedia(c: Context, u: Uri): Boolean {
        val t = runCatching { c.contentResolver.getType(u) }.getOrNull().orEmpty()
        if (t.startsWith("image/") || t.startsWith("video/")) return true
        val n = runCatching { DdnUploads.displayName(c, u) }.getOrDefault("")
        return DdnSession.isImage(n) || DdnSession.isVideo(n)
    }

    /** The phone's media store (directly or through its documents provider): it redacts the position. */
    fun fromMediaStore(u: Uri): Boolean = u.scheme == "content" && (u.authority == MediaStore.AUTHORITY || u.authority == MEDIA_DOCUMENTS)

    /** Ask before reading `uris` (photos or videos of the media store, the permission missing). */
    fun shouldAsk(c: Context, uris: List<Uri>): Boolean = !granted(c) && uris.any { u -> fromMediaStore(u) && isMedia(c, u) }

    private const val MEDIA_DOCUMENTS = "com.android.providers.media.documents"

    /**
     * The URI of the original bytes: the media store's (also its documents' provider) with the position kept
     * when the permission is granted, else the URI itself (a redacted copy; asking is the caller's part).
     */
    fun original(c: Context, u: Uri): Uri {
        if (!granted(c) || !fromMediaStore(u)) return u
        // A document of the media documents provider ("image:31") maps to its media store row.
        val ms = if (u.authority == MEDIA_DOCUMENTS) runCatching { MediaStore.getMediaUri(c, u) }.getOrNull() ?: return u else u
        return runCatching { MediaStore.setRequireOriginal(ms) }.getOrDefault(u)
    }

    /** Open the original bytes when allowed, else what the provider gives. */
    fun open(c: Context, u: Uri): InputStream {
        val o = original(c, u)
        if (o != u) runCatching { c.contentResolver.openInputStream(o) }.getOrNull()?.let { return it }
        return c.contentResolver.openInputStream(u) ?: throw java.io.FileNotFoundException(u.toString())
    }
}

/**
 * Asks for ACCESS_MEDIA_LOCATION before photos are read, then goes on (granted or not). Made as a property of
 * the activity (it registers for the permission's result). [fallback] runs when the answer comes to an activity
 * made again meanwhile (a rotation during the dialog).
 */
class LocationGate(private val a: androidx.activity.ComponentActivity, private val fallback: () -> Unit = {}) {
    private var next: (() -> Unit)? = null
    var asking = false
        private set
    private val launcher = a.registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { ok ->
        asking = false
        // Refused in the dialog (with access to photos: the dialog was shown): copies go without the position
        // and the app does not ask again by itself (the automatic copy screen offers it).
        if (!ok && MediaLocation.hasMediaAccess(a)) DdnBackup.setLocationDeclined(a, true)
        if (ok) DdnBackup.setLocationDeclined(a, false)
        val f = next ?: fallback
        next = null
        f()
    }

    /** Run [then] once the permission was asked for (at once when not needed for `uris`). */
    fun then(uris: List<android.net.Uri>, then: () -> Unit) {
        if (!DdnBackup.locationDeclined(a) && MediaLocation.shouldAsk(a, uris)) ask(then) else then()
    }

    /** Ask now (also after a refusal: the user tapped "Allow"); [then] after the answer. */
    fun ask(then: () -> Unit = {}) {
        next = then
        asking = true
        launcher.launch(android.Manifest.permission.ACCESS_MEDIA_LOCATION)
    }
}
