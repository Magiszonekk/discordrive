package com.discordrive.gallery

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import java.io.ByteArrayOutputStream

/**
 * Prepares media for AI analysis: images are downscaled (privacy + payload
 * size — the AI endpoint never receives the original), videos contribute a
 * representative frame.
 */
object AiImagePreparer {

    private const val MAX_DIMENSION = 1024
    private const val JPEG_QUALITY = 80

    /** Returns JPEG bytes ready for the vision endpoint. */
    fun prepare(context: Context, asset: MediaAsset): ByteArray {
        val bitmap = if (asset.isVideo) videoFrame(context, asset) else decodeDownscaled(context, asset)
        return ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            bitmap.recycle()
            out.toByteArray()
        }
    }

    private fun decodeDownscaled(context: Context, asset: MediaAsset): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(asset.uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }

        var sampleSize = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sampleSize * 2) >= MAX_DIMENSION) sampleSize *= 2

        val options = BitmapFactory.Options().apply { inSampleSize = sampleSize }
        return context.contentResolver.openInputStream(asset.uri)?.use {
            BitmapFactory.decodeStream(it, null, options)
        } ?: throw IllegalStateException("Cannot decode ${asset.displayName}")
    }

    private fun videoFrame(context: Context, asset: MediaAsset): Bitmap {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(context, asset.uri)
            return retriever.getFrameAtTime(1_000_000) // 1s in
                ?: retriever.frameAtTime
                ?: throw IllegalStateException("No frame in ${asset.displayName}")
        } finally {
            retriever.release()
        }
    }
}
