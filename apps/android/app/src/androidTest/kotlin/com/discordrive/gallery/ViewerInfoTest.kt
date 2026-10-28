package com.discordrive.gallery

import android.graphics.Bitmap
import android.media.ExifInterface
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Info of the viewer from the file itself: a photo's EXIF (dimensions, camera, exposure, date, GPS), a video's position. */
@RunWith(AndroidJUnit4::class)
class ViewerInfoTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun photoExif() {
        val f = File(ctx.cacheDir, "exif-test.jpg")
        f.outputStream().use { Bitmap.createBitmap(300, 200, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.JPEG, 80, it) }
        ExifInterface(f.path).apply {
            setAttribute(ExifInterface.TAG_MAKE, "Google")
            setAttribute(ExifInterface.TAG_MODEL, "Pixel 7")
            setAttribute(ExifInterface.TAG_F_NUMBER, "1.85")
            setAttribute(ExifInterface.TAG_EXPOSURE_TIME, "0.008")
            setAttribute(ExifInterface.TAG_ISO_SPEED_RATINGS, "100")
            setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, "2024:05:17 12:30:00")
            setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
            setAttribute(ExifInterface.TAG_GPS_LATITUDE, "52/1,13/1,469/10")
            setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, "N")
            setAttribute(ExifInterface.TAG_GPS_LONGITUDE, "21/1,0/1,439/10")
            setAttribute(ExifInterface.TAG_GPS_LONGITUDE_REF, "E")
            saveAttributes()
        }
        val m = ViewerInfo.photo(f.readBytes())
        f.delete()
        // Turned by its orientation: shown 200 × 300.
        assertEquals(200, m.width)
        assertEquals(300, m.height)
        assertEquals("Google Pixel 7", m.camera)
        assertTrue(m.exposure, m.exposure!!.contains("f/1.9") && m.exposure!!.contains("1/125 s") && m.exposure!!.contains("ISO 100"))
        assertNotNull(m.taken)
        assertEquals(52.2297, m.lat!!, 1e-3)
        assertEquals(21.0122, m.lon!!, 1e-3)
        val lines = ViewerInfo.lines(ctx, m)
        assertTrue(lines.toString(), lines.contains(ctx.getString(R.string.ddn_info_camera, "Google Pixel 7")) && lines.any { it.startsWith(ctx.getString(R.string.ddn_info_dims, 200, 300)) } && lines.any { it.startsWith(ctx.getString(R.string.ddn_info_place, "52.2297").take(14)) })
    }

    @Test
    fun photoWithoutExif() {
        val bytes = java.io.ByteArrayOutputStream().also { Bitmap.createBitmap(64, 48, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        val m = ViewerInfo.photo(bytes)
        assertEquals(64, m.width)
        assertEquals(48, m.height)
        assertNull(m.camera)
        assertNull(m.lat)
    }

    /** N60: a photo whose position Android zeroed (no ACCESS_MEDIA_LOCATION): no position, no map. */
    @Test
    fun zeroedGpsIsNoPosition() {
        val f = File(ctx.cacheDir, "exif-zero.jpg")
        f.outputStream().use { Bitmap.createBitmap(30, 20, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.JPEG, 80, it) }
        ExifInterface(f.path).apply {
            setAttribute(ExifInterface.TAG_GPS_LATITUDE, "0/1,0/1,0/1"); setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, "N")
            setAttribute(ExifInterface.TAG_GPS_LONGITUDE, "0/1,0/1,0/1"); setAttribute(ExifInterface.TAG_GPS_LONGITUDE_REF, "E")
            saveAttributes()
        }
        val m = ViewerInfo.photo(f.readBytes())
        f.delete()
        assertNull(m.lat)
        assertNull(m.lon)
        assertTrue(ViewerInfo.lines(ctx, m).none { it.startsWith(ctx.getString(R.string.ddn_info_place, "").trimEnd()) })
    }

    @Test
    fun videoLocation() {
        assertEquals(52.2297 to 21.0122, ViewerInfo.iso6709("+52.2297+021.0122/"))
        assertEquals(-33.8688 to 151.2093, ViewerInfo.iso6709("-33.8688+151.2093+012.000/"))
        assertNull(ViewerInfo.iso6709("+00.0000+000.0000/"))
        assertNull(ViewerInfo.iso6709("nowhere"))
    }
}
