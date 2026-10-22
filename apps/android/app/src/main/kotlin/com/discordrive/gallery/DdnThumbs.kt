package com.discordrive.gallery

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.widget.ImageView
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Thumbnails and previews of discordrive files: the encrypted pictures stored next to each file's manifest
 * (made by the device that uploaded it), opened on the phone. Memory cache + a disk cache of the DECRYPTED
 * pictures in the app's private cache folder (keyed by a hash of the version's manifestRef, so the name
 * says nothing about the file). A file without one keeps its type icon.
 */
object DdnThumbs {
    private val main = Handler(Looper.getMainLooper())
    private val pool = Executors.newFixedThreadPool(4)
    private val mem = object : LruCache<String, Bitmap>(24 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount / 1024
    }
    /** Versions known to have no picture of a kind (this run). */
    private val none = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())

    private fun key(ref: String, kind: Char) = MessageDigest.getInstance("SHA-256").digest("$kind|$ref".toByteArray()).joinToString("") { "%02x".format(it) }.take(32)

    /** Decoded picture or null (none stored / failed). Blocking: off the main thread. */
    fun load(s: DdnSession, ref: String, kind: Char, maxPx: Int): Bitmap? {
        val k = key(ref, kind)
        mem.get("$k:$maxPx")?.let { return it }
        if (k in none) return null
        val dir = File(s.discordCacheDir(), "ddn-thumbs").apply { mkdirs() }
        val f = File(dir, k)
        val bytes = if (f.exists()) f.readBytes() else {
            val p = runCatching { s.files.preview(ref, kind) }.getOrNull()
            if (p == null) { none += k; return null }
            f.writeBytes(p.data)
            p.data
        }
        val b = decode(bytes, maxPx) ?: return null
        mem.put("$k:$maxPx", b)
        return b
    }

    fun decode(bytes: ByteArray, maxPx: Int): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        var sample = 1
        while (maxOf(o.outWidth, o.outHeight) / (sample * 2) >= maxPx) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    /** Put the thumbnail into `target` when it arrives (the view's tag guards against recycled rows). */
    fun into(s: DdnSession, ref: String?, target: ImageView, maxPx: Int = 320, kind: Char = 't', onNone: () -> Unit = {}) {
        if (ref == null) return onNone()
        target.tag = ref
        val k = key(ref, kind)
        mem.get("$k:$maxPx")?.let { target.setImageBitmap(it); return }
        pool.execute {
            val b = load(s, ref, kind, maxPx)
            main.post {
                if (target.tag != ref) return@post
                if (b != null) target.setImageBitmap(b) else onNone()
            }
        }
    }
}

private fun DdnSession.discordCacheDir(): File = DdnSessionDirs.cacheDir ?: throw IllegalStateException("no cache dir")

/** Set once by the app (Application.cacheDir). */
object DdnSessionDirs {
    @Volatile var cacheDir: File? = null
}
