package com.discordrive.gallery

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.ExifInterface
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The editor's copy keeps the original's EXIF: date taken, camera, exposure and GPS position stay, the
 * orientation becomes normal because the saved pixels are already turned as the original was shown.
 */
@RunWith(AndroidJUnit4::class)
class EditExifTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    /** 300 × 200, left half red, right half blue; stored sideways (orientation 6 = turn 90° to show). */
    private fun original(): ByteArray {
        val b = Bitmap.createBitmap(300, 200, Bitmap.Config.ARGB_8888)
        Canvas(b).apply {
            drawRect(0f, 0f, 150f, 200f, Paint().apply { color = Color.RED })
            drawRect(150f, 0f, 300f, 200f, Paint().apply { color = Color.BLUE })
        }
        val f = File(ctx.cacheDir, "edit-exif-src.jpg")
        f.outputStream().use { b.compress(Bitmap.CompressFormat.JPEG, 95, it) }
        // AndroidX writes every standard tag (the system class skips the lens ones).
        androidx.exifinterface.media.ExifInterface(f.path).apply {
            setAttribute(ExifInterface.TAG_MAKE, "Google")
            setAttribute("LensMake", "Google")
            setAttribute("LensModel", "Pixel 7 back camera 6.81mm f/1.85")
            setAttribute(ExifInterface.TAG_MODEL, "Pixel 7")
            setAttribute(ExifInterface.TAG_F_NUMBER, "1.85")
            setAttribute(ExifInterface.TAG_EXPOSURE_TIME, "0.008")
            setAttribute(ExifInterface.TAG_ISO_SPEED_RATINGS, "100")
            setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, "2019:07:14 18:05:09")
            setAttribute("OffsetTimeOriginal", "+02:00")
            setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
            setAttribute(ExifInterface.TAG_GPS_LATITUDE, "52/1,13/1,469/10")
            setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, "N")
            setAttribute(ExifInterface.TAG_GPS_LONGITUDE, "21/1,0/1,439/10")
            setAttribute(ExifInterface.TAG_GPS_LONGITUDE_REF, "E")
            saveAttributes()
        }
        return f.readBytes().also { f.delete() }
    }

    @Test
    fun copyKeepsExifAndIsUpright() {
        val src = original()
        val exif = ExifInterface(src.inputStream())
        val exifX = androidx.exifinterface.media.ExifInterface(src.inputStream())
        assertEquals("Pixel 7 back camera 6.81mm f/1.85", exifX.getAttribute("LensModel"))
        // 2019-07-14 18:05:09 at +02:00.
        assertEquals(1563120309000L, DdnPictures.takenAt(exif))
        // As the editor loads it: decoded, then turned by the orientation tag (shown 200 × 300, red on top).
        val shown = DdnThumbs.upright(BitmapFactory.decodeByteArray(src, 0, src.size), exif)
        assertEquals(200, shown.width)
        assertEquals(300, shown.height)
        assertTrue(Color.red(shown.getPixel(100, 40)) > 200 && Color.blue(shown.getPixel(100, 40)) < 60)
        assertTrue(Color.blue(shown.getPixel(100, 260)) > 200 && Color.red(shown.getPixel(100, 260)) < 60)

        val plain = ByteArrayOutputStream().also { shown.compress(Bitmap.CompressFormat.JPEG, 92, it) }.toByteArray()
        val copy = DdnEditActivity.withExif(plain, exifX, ctx.cacheDir)
        val out = ExifInterface(copy.inputStream())
        // The lens stays too (read back with AndroidX: the system class does not know these tags).
        val outX = androidx.exifinterface.media.ExifInterface(copy.inputStream())
        assertEquals("Google", outX.getAttribute("LensMake"))
        assertEquals("Pixel 7 back camera 6.81mm f/1.85", outX.getAttribute("LensModel"))
        assertEquals("2019:07:14 18:05:09", out.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL))
        assertEquals(DdnPictures.takenAt(exif), DdnPictures.takenAt(out))
        assertEquals(ExifInterface.ORIENTATION_NORMAL, out.getAttributeInt(ExifInterface.TAG_ORIENTATION, 0))
        val ll = FloatArray(2)
        assertTrue(out.getLatLong(ll))
        assertEquals(52.2297, ll[0].toDouble(), 1e-3)
        assertEquals(21.0122, ll[1].toDouble(), 1e-3)
        // What the viewer's Info shows for the copy: the same camera, exposure, date and place, upright size.
        val m = ViewerInfo.photo(copy)
        assertEquals(200, m.width)
        assertEquals(300, m.height)
        assertEquals("Google Pixel 7", m.camera)
        assertTrue(m.exposure, m.exposure!!.contains("f/1.9") && m.exposure!!.contains("ISO 100"))
        assertNotNull(m.taken)
        assertEquals(52.2297, m.lat!!, 1e-3)
        // The pixels are the edited ones (not the original's), still a valid JPEG.
        val back = BitmapFactory.decodeByteArray(copy, 0, copy.size)
        assertEquals(200, back.width)
        assertEquals(300, back.height)
    }

    /** The photo viewer decodes the whole file the same way: a sideways-stored photo is shown upright. */
    @Test
    fun viewerShowsSidewaysPhotoUpright() {
        val src = original()
        val shown = DdnThumbs.decodeUpright(src, 4096)!!
        assertEquals(200, shown.width)
        assertEquals(300, shown.height)
        assertTrue(Color.red(shown.getPixel(100, 40)) > 200 && Color.blue(shown.getPixel(100, 40)) < 60)
        assertTrue(Color.blue(shown.getPixel(100, 260)) > 200 && Color.red(shown.getPixel(100, 260)) < 60)
        // Downscaled (a big photo) it is still turned; without an orientation tag it stays as stored.
        val small = DdnThumbs.decodeUpright(src, 100)!!
        assertTrue(small.height > small.width)
        val plain = ByteArrayOutputStream().also { Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
        val flat = DdnThumbs.decodeUpright(plain, 4096)!!
        assertEquals(40, flat.width)
        assertEquals(30, flat.height)
    }

    /**
     * A big file without a stored preview is decoded from the cache, scaled down while decoding and turned:
     * 6000 × 4000 stored sideways → at most 4096 on the long side, taller than wide.
     */
    @Test
    fun bigFileFromDiskIsScaledAndUpright() {
        val b = Bitmap.createBitmap(6000, 4000, Bitmap.Config.RGB_565)
        Canvas(b).apply {
            drawRect(0f, 0f, 3000f, 4000f, Paint().apply { color = Color.RED })
            drawRect(3000f, 0f, 6000f, 4000f, Paint().apply { color = Color.BLUE })
        }
        val f = File(ctx.cacheDir, "edit-big-test.jpg")
        try {
            f.outputStream().use { b.compress(Bitmap.CompressFormat.JPEG, 80, it) }
            b.recycle()
            ExifInterface(f.path).apply { setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString()); saveAttributes() }
            val shown = DdnEditActivity.decodeFileUpright(f, 4096)!!
            assertTrue("${shown.width}x${shown.height}", shown.height > shown.width && maxOf(shown.width, shown.height) <= 4096)
            assertEquals(3000, shown.height)
            // Turned right: the left (red) half is now on top.
            assertTrue(Color.red(shown.getPixel(shown.width / 2, shown.height / 8)) > 200)
            assertTrue(Color.blue(shown.getPixel(shown.width / 2, shown.height * 7 / 8)) > 200)
            // Not a picture: no bitmap.
            f.writeBytes(ByteArray(1000) { 7 })
            assertEquals(null, DdnEditActivity.decodeFileUpright(f, 4096))
        } finally {
            f.delete()
        }
    }

    @Test
    fun withoutExifTheCopyIsAsEncoded() {
        val plain = ByteArrayOutputStream().also { Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
        val none = androidx.exifinterface.media.ExifInterface(plain.inputStream())
        assertArrayEquals(plain, DdnEditActivity.withExif(plain, none, ctx.cacheDir))
        assertEquals(null, DdnPictures.takenAt(ExifInterface(plain.inputStream())))
    }
}
