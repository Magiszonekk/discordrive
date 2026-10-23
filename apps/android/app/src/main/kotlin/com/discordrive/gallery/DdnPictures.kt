package com.discordrive.gallery

import android.content.ContentResolver
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.util.Size
import io.github.magiszonekk.discordrive.core.FileWrite
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The thumbnail and preview stored with an uploaded photo or video, as the web app makes them (thumbs.ts):
 * thumbnail short side 320 (long side at most 640), ≤ 48 KB; preview long side 1280, ≤ 400 KB; WebP, quality
 * 0.7 → 0.55 → 0.4, then smaller. From the system's own thumbnailer (ContentResolver.loadThumbnail: photos
 * and video frames, EXIF orientation applied). Anything it cannot decode gets no pictures (the file still
 * uploads).
 */
object DdnPictures {
    fun make(cr: ContentResolver, uri: Uri): List<FileWrite.Picture> {
        val viaSystem = listOfNotNull(
            runCatching { one(cr, uri, 't') }.onFailure { android.util.Log.w("ddn-backup", "loadThumbnail: ${it.message}") }.getOrNull(),
            runCatching { one(cr, uri, 'p') }.getOrNull(),
        )
        // Only when the system gave enough pixels: some (the emulator) answer a small cached thumbnail whatever
        // size is asked, and the pictures would be smaller than the web app's.
        if (viaSystem.any { it.kind == 't' && min(it.width, it.height) >= 320 }) return viaSystem
        // The system thumbnailer may not have the item yet (just written) or refuse it: decode the file itself.
        return runCatching { fromStream(cr, uri) }.onFailure { android.util.Log.w("ddn-backup", "decode: ${it.message}") }.getOrDefault(viaSystem)
    }

    private fun fromStream(cr: ContentResolver, uri: Uri): List<FileWrite.Picture> {
        val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        cr.openInputStream(uri)!!.use { android.graphics.BitmapFactory.decodeStream(it, null, o) }
        if (o.outWidth <= 0) return emptyList()
        // EXIF orientation: the decoder does not apply it (the system thumbnailer did).
        val deg: Int = runCatching { cr.openInputStream(uri)!!.use { when (android.media.ExifInterface(it).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) { 6 -> 90; 3 -> 180; 8 -> 270; else -> 0 } } }.getOrDefault(0)
        var sample = 1
        while (max(o.outWidth, o.outHeight) / (sample * 2) >= 1280) sample *= 2
        val raw = cr.openInputStream(uri)!!.use { android.graphics.BitmapFactory.decodeStream(it, null, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }) } ?: return emptyList()
        val b = if (deg == 0) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, android.graphics.Matrix().apply { postRotate(deg.toFloat()) }, true).also { if (it !== raw) raw.recycle() }
        return try { listOfNotNull(runCatching { encode(b, 't') }.getOrNull(), runCatching { encode(b, 'p') }.getOrNull()) } finally { b.recycle() }
    }

    /** From a file (a shared photo or video copied into the queue): decoded with sampling, or a video frame. */
    fun fromFile(f: java.io.File): List<FileWrite.Picture> {
        val bmp = runCatching {
            val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeFile(f.path, o)
            if (o.outWidth > 0) {
                var s = 1
                while (max(o.outWidth, o.outHeight) / (s * 2) >= 1280) s *= 2
                val b = android.graphics.BitmapFactory.decodeFile(f.path, android.graphics.BitmapFactory.Options().apply { inSampleSize = s })
                // EXIF orientation (a phone photo is usually stored sideways).
                val deg: Int = runCatching {
                    when (android.media.ExifInterface(f.path).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) { 6 -> 90; 3 -> 180; 8 -> 270; else -> 0 }
                }.getOrDefault(0)
                if (b != null && deg != 0) Bitmap.createBitmap(b, 0, 0, b.width, b.height, android.graphics.Matrix().apply { postRotate(deg.toFloat()) }, true).also { if (it !== b) b.recycle() } else b
            } else {
                val r = android.media.MediaMetadataRetriever()
                try { r.setDataSource(f.path); r.getScaledFrameAtTime(1_000_000, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 1280, 1280) } finally { r.release() }
            }
        }.getOrNull() ?: return emptyList()
        return try { listOfNotNull(runCatching { encode(bmp, 't') }.getOrNull(), runCatching { encode(bmp, 'p') }.getOrNull()) } finally { bmp.recycle() }
    }

    private fun fit(kind: Char, w: Int, h: Int): Pair<Int, Int> {
        var s = if (kind == 't') 320.0 / min(w, h) else 1280.0 / max(w, h)
        if (kind == 't' && max(w, h) * s > 640) s = 640.0 / max(w, h)
        s = min(1.0, s)
        return max(1, (w * s).roundToInt()) to max(1, (h * s).roundToInt())
    }

    private fun one(cr: ContentResolver, uri: Uri, kind: Char): FileWrite.Picture? {
        val ask = if (kind == 't') 640 else 1280
        val src = cr.loadThumbnail(uri, Size(ask, ask), null)
        try {
            if (min(src.width, src.height) < (if (kind == 't') 320 else 0) && max(src.width, src.height) < ask) return null
            return encode(src, kind)
        } finally {
            src.recycle()
        }
    }

    internal fun encode(src: Bitmap, kind: Char): FileWrite.Picture? {
        run {
            var (w, h) = fit(kind, src.width, src.height)
            val maxBytes = if (kind == 't') 48 * 1024 else 400 * 1024
            @Suppress("DEPRECATION")
            val fmt = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP
            repeat(4) {
                val b = if (w == src.width && h == src.height) src else Bitmap.createScaledBitmap(src, w, h, true)
                try {
                    for (q in intArrayOf(70, 55, 40)) {
                        val out = ByteArrayOutputStream()
                        b.compress(fmt, q, out)
                        if (out.size() <= maxBytes) return FileWrite.Picture(kind, "image/webp", w, h, out.toByteArray()).takeIf(FileWrite::pictureOk)
                    }
                } finally {
                    if (b !== src) b.recycle()
                }
                w = max(1, (w * 0.8).roundToInt()); h = max(1, (h * 0.8).roundToInt())
            }
            return null
        }
    }
}
