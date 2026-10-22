package com.discordrive.gallery

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.discordrive.gallery.api.UploadEngine

/**
 * Full-quality bitmap loading for the wallpaper cropper and photo editor:
 * local assets decode from MediaStore, cloud-only assets download the full
 * file first (needs a live session). Decodes are size-capped to keep memory
 * sane on huge photos.
 */
object PhotoLoader {

    /** Decodes [asset] with the longer edge capped at [maxDim] px. */
    fun decodeAsset(context: Context, asset: MediaAsset, maxDim: Int): Bitmap? {
        return if (asset.cloudFileId != null) {
            val client = SessionManager.client ?: error(context.getString(R.string.viewer_needs_session))
            val filesKey = SessionManager.filesKey ?: error(context.getString(R.string.viewer_needs_session))
            val file = client.file(asset.cloudFileId) ?: error("plik zniknął z chmury")
            val bytes = UploadEngine(client).downloadFile(file, filesKey)
            decodeLimited(maxDim) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, it) }
        } else {
            decodeLimited(maxDim) { opts ->
                context.contentResolver.openInputStream(asset.uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
            }
        }
    }

    /** Screen-appropriate cap: twice the longer screen edge, at most 4096. */
    fun screenMaxDim(context: Context): Int =
        (2 * maxOf(context.resources.displayMetrics.widthPixels, context.resources.displayMetrics.heightPixels))
            .coerceAtMost(4096)

    /** Two-pass decode (bounds, then sampled) keeping the longer edge under [maxDim]. */
    private fun decodeLimited(maxDim: Int, decode: (BitmapFactory.Options) -> Bitmap?): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        decode(bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxDim) sample *= 2
        return decode(BitmapFactory.Options().apply { inSampleSize = sample })
    }
}
