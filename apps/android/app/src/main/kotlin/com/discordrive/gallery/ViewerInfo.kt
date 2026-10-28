package com.discordrive.gallery

import android.content.Context
import android.net.Uri
import io.github.magiszonekk.discordrive.core.IndexReplica

/**
 * What Info shows from the file itself: a photo's dimensions, camera, date taken and GPS position (its EXIF,
 * read from the first fragment), a video's dimensions, length and recorded position (the container, read
 * through ranges: only the fragments the reader touches are fetched).
 */
object ViewerInfo {
    data class Meta(
        val width: Int? = null,
        val height: Int? = null,
        val camera: String? = null,
        val exposure: String? = null,
        val taken: Long? = null,
        val lat: Double? = null,
        val lon: Double? = null,
        val durationMs: Long? = null,
    )

    /** EXIF is at the start of a photo: this much is read (one fragment for most files). */
    private const val HEAD = 256 * 1024

    /** Off the main thread. Null for files that are neither photos nor videos. */
    fun read(s: DdnSession, c: IndexReplica.Child): Meta? {
        val ref = c.manifestRef ?: return null
        val size = c.size ?: return null
        if (size <= 0) return null
        return when {
            DdnSession.isImage(c.name) -> photo(s.files.range(ref, size, 0, minOf(size, HEAD.toLong()) - 1))
            DdnSession.isVideo(c.name) -> video(s, ref, size)
            else -> null
        }
    }

    internal fun photo(head: ByteArray): Meta {
        val exif = runCatching { android.media.ExifInterface(head.inputStream()) }.getOrNull()
        var w = exif?.getAttributeInt(android.media.ExifInterface.TAG_PIXEL_X_DIMENSION, 0)?.takeIf { it > 0 }
            ?: exif?.getAttributeInt(android.media.ExifInterface.TAG_IMAGE_WIDTH, 0)?.takeIf { it > 0 }
        var h = exif?.getAttributeInt(android.media.ExifInterface.TAG_PIXEL_Y_DIMENSION, 0)?.takeIf { it > 0 }
            ?: exif?.getAttributeInt(android.media.ExifInterface.TAG_IMAGE_LENGTH, 0)?.takeIf { it > 0 }
        if (w == null || h == null) {
            val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeByteArray(head, 0, head.size, o)
            if (o.outWidth > 0 && o.outHeight > 0) { w = o.outWidth; h = o.outHeight }
        }
        // A photo turned by its orientation tag is shown (and counted) the other way round.
        val turned = exif?.getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1) in setOf(5, 6, 7, 8)
        if (turned) { val t = w; w = h; h = t }
        val make = exif?.getAttribute(android.media.ExifInterface.TAG_MAKE)?.trim().orEmpty()
        val model = exif?.getAttribute(android.media.ExifInterface.TAG_MODEL)?.trim().orEmpty()
        val camera = when {
            model.isEmpty() -> make.ifEmpty { null }
            make.isEmpty() || model.startsWith(make, ignoreCase = true) -> model
            else -> "$make $model"
        }
        val parts = ArrayList<String>()
        exif?.getAttributeDouble(android.media.ExifInterface.TAG_F_NUMBER, 0.0)?.takeIf { it > 0 }?.let { parts += "f/" + trim(it) }
        exif?.getAttributeDouble(android.media.ExifInterface.TAG_EXPOSURE_TIME, 0.0)?.takeIf { it > 0 }?.let { parts += if (it < 1) "1/${Math.round(1 / it)} s" else "${trim(it)} s" }
        exif?.getAttributeDouble(android.media.ExifInterface.TAG_FOCAL_LENGTH, 0.0)?.takeIf { it > 0 }?.let { parts += "${trim(it)} mm" }
        exif?.getAttributeInt(android.media.ExifInterface.TAG_ISO_SPEED_RATINGS, 0)?.takeIf { it > 0 }?.let { parts += "ISO $it" }
        val ll = FloatArray(2).takeIf { exif?.getLatLong(it) == true }?.map { it.toDouble() }
        val taken = (exif?.getAttribute(android.media.ExifInterface.TAG_DATETIME_ORIGINAL) ?: exif?.getAttribute(android.media.ExifInterface.TAG_DATETIME))?.let { d ->
            runCatching { java.text.SimpleDateFormat("yyyy:MM:dd HH:mm:ss", java.util.Locale.US).parse(d)?.time }.getOrNull()
        }
        return Meta(w, h, camera, parts.joinToString(" · ").ifEmpty { null }, taken, ll?.get(0), ll?.get(1))
    }

    private fun video(s: DdnSession, ref: String, size: Long): Meta {
        val r = android.media.MediaMetadataRetriever()
        try {
            r.setDataSource(object : android.media.MediaDataSource() {
                override fun getSize() = size
                override fun readAt(position: Long, buffer: ByteArray, offset: Int, n: Int): Int {
                    if (position >= size) return -1
                    val b = s.files.range(ref, size, position, minOf(size, position + n) - 1)
                    System.arraycopy(b, 0, buffer, offset, b.size)
                    return b.size
                }
                override fun close() {}
            })
            fun k(key: Int) = r.extractMetadata(key)
            var w = k(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
            var h = k(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
            if (k(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull()?.let { it % 180 != 0 } == true) { val t = w; w = h; h = t }
            val ll = k(android.media.MediaMetadataRetriever.METADATA_KEY_LOCATION)?.let(::iso6709)
            val taken = k(android.media.MediaMetadataRetriever.METADATA_KEY_DATE)?.let { d ->
                runCatching { java.text.SimpleDateFormat("yyyyMMdd'T'HHmmss.SSS'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.parse(d)?.time }.getOrNull()
            }?.takeIf { it > 0 }
            return Meta(w, h, null, null, taken, ll?.first, ll?.second, k(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull())
        } finally {
            runCatching { r.release() }
        }
    }

    /** "+52.2297+021.0122/" (ISO 6709, as phones record it) → (lat, lon). */
    internal fun iso6709(v: String): Pair<Double, Double>? {
        val m = Regex("""^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)""").find(v.trim()) ?: return null
        val lat = m.groupValues[1].toDoubleOrNull() ?: return null
        val lon = m.groupValues[2].toDoubleOrNull() ?: return null
        if (lat == 0.0 && lon == 0.0) return null
        return lat to lon
    }

    /** The lines Info adds for `m` (dimensions, length, camera, exposure, position). */
    fun lines(c: Context, m: Meta): List<String> {
        val out = ArrayList<String>()
        if (m.width != null && m.height != null) {
            val mp = m.width.toLong() * m.height / 1_000_000.0
            out += c.getString(R.string.ddn_info_dims, m.width, m.height) + if (m.durationMs == null && mp >= 0.1) " (${trim(Math.round(mp * 10) / 10.0)} Mpx)" else ""
        }
        m.durationMs?.let { out += c.getString(R.string.ddn_info_length, android.text.format.DateUtils.formatElapsedTime(it / 1000)) }
        m.camera?.let { out += c.getString(R.string.ddn_info_camera, it) }
        m.exposure?.let { out += c.getString(R.string.ddn_info_exposure, it) }
        if (m.lat != null && m.lon != null) out += c.getString(R.string.ddn_info_place, "%.5f, %.5f".format(java.util.Locale.US, m.lat, m.lon))
        return out
    }

    fun geoUri(lat: Double, lon: Double): Uri = Uri.parse("geo:$lat,$lon?q=$lat,$lon")
    fun webMapUri(lat: Double, lon: Double): Uri = Uri.parse("https://www.openstreetmap.org/?mlat=$lat&mlon=$lon#map=16/$lat/$lon")

    private fun trim(d: Double): String = if (d == Math.floor(d)) d.toLong().toString() else "%.1f".format(java.util.Locale.US, d).trimEnd('0').trimEnd('.')
}
