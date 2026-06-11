package com.discordrive.gallery

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.util.Size
import android.widget.ImageView
import java.util.concurrent.Executors

/**
 * Tiny async thumbnail loader over ContentResolver.loadThumbnail with an
 * in-memory LRU cache — enough for a smooth grid without pulling in Glide.
 */
object ThumbLoader {

    private val executor = Executors.newFixedThreadPool(3)
    private val mainHandler = Handler(Looper.getMainLooper())

    private val cache = object : LruCache<Long, Bitmap>(96 * 1024) { // KB budget
        override fun sizeOf(key: Long, value: Bitmap) = value.byteCount / 1024
    }

    fun load(context: Context, asset: MediaAsset, target: ImageView, sizePx: Int = 384) {
        target.tag = asset.id
        cache.get(asset.id)?.let {
            target.setImageBitmap(it)
            return
        }
        target.setImageDrawable(null)

        executor.execute {
            val bitmap = decode(context, asset.uri, sizePx) ?: return@execute
            cache.put(asset.id, bitmap)
            mainHandler.post {
                if (target.tag == asset.id) target.setImageBitmap(bitmap)
            }
        }
    }

    private fun decode(context: Context, uri: Uri, sizePx: Int): Bitmap? =
        runCatching { context.contentResolver.loadThumbnail(uri, Size(sizePx, sizePx), null) }.getOrNull()
}
