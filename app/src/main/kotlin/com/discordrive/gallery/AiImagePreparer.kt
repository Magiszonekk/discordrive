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

    // Video frame sampling: ~1 frame per this many seconds, clamped to [1, MAX].
    private const val SECONDS_PER_FRAME = 8
    private const val MAX_VIDEO_FRAMES = 8
    private const val SHORT_VIDEO_MS = 3_000L

    /** Returns JPEG bytes ready for the vision endpoint. */
    fun prepare(context: Context, asset: MediaAsset): ByteArray {
        val bitmap = if (asset.isVideo) videoFrame(context, asset) else decodeDownscaled(context, asset)
        return toJpeg(bitmap)
    }

    /**
     * Samples several frames from a video, spread evenly across its duration
     * (more frames for longer clips), each downscaled to a JPEG. Used for
     * frame-by-frame video analysis. Falls back to a single frame.
     */
    fun prepareVideoFrames(context: Context, asset: MediaAsset, maxFrames: Int = MAX_VIDEO_FRAMES): List<ByteArray> {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(context, asset.uri)
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            val (dstW, dstH) = scaledFrameSize(retriever)
            val count = frameCountFor(durationMs, maxFrames)
            val durationUs = durationMs * 1000

            val frames = ArrayList<ByteArray>(count)
            for (i in 1..count) {
                // spread across the clip, skipping the very start/end
                val timeUs = if (durationUs > 0) durationUs * i / (count + 1) else 0L
                val bmp = scaledFrame(retriever, timeUs, dstW, dstH) ?: continue
                frames.add(toJpeg(bmp))
            }
            if (frames.isEmpty()) {
                (scaledFrame(retriever, 0, dstW, dstH) ?: retriever.frameAtTime)?.let { frames.add(toJpeg(it)) }
            }
            return frames
        } finally {
            retriever.release()
        }
    }

    private fun frameCountFor(durationMs: Long, maxFrames: Int): Int {
        if (durationMs <= SHORT_VIDEO_MS) return 1
        val byDuration = (durationMs / 1000 / SECONDS_PER_FRAME).toInt()
        return byDuration.coerceIn(2, maxFrames)
    }

    /** Target frame size honouring aspect ratio + rotation, capped at MAX_DIMENSION. */
    private fun scaledFrameSize(retriever: MediaMetadataRetriever): Pair<Int, Int> {
        var w = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: MAX_DIMENSION
        var h = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: MAX_DIMENSION
        val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
        if (rotation == 90 || rotation == 270) { val t = w; w = h; h = t }
        if (w <= 0 || h <= 0) return MAX_DIMENSION to MAX_DIMENSION
        val largest = maxOf(w, h)
        if (largest <= MAX_DIMENSION) return w to h
        val scale = MAX_DIMENSION.toDouble() / largest
        return (w * scale).toInt().coerceAtLeast(1) to (h * scale).toInt().coerceAtLeast(1)
    }

    private fun scaledFrame(retriever: MediaMetadataRetriever, timeUs: Long, dstW: Int, dstH: Int): Bitmap? =
        retriever.getScaledFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, dstW, dstH)
            ?: retriever.getFrameAtTime(timeUs)

    private fun toJpeg(bitmap: Bitmap): ByteArray = ByteArrayOutputStream().use { out ->
        bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
        bitmap.recycle()
        out.toByteArray()
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
