package com.discordrive.gallery

import android.content.Intent
import android.graphics.Bitmap
import android.media.ExifInterface
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A photo of the phone keeps its GPS position in the account. Started with ACCESS_MEDIA_LOCATION revoked and
 * the photos' access granted (revoking kills the process, so the CI script does it before): the media store
 * hands out the photo with the position zeroed, the app asks for the permission (the photos' access grants it
 * without a dialog) and then reads the original with the position.
 */
@RunWith(AndroidJUnit4::class)
class MediaLocationTest {
    private val ins = InstrumentationRegistry.getInstrumentation()
    private val ctx = ins.targetContext

    private fun shell(cmd: String) = ins.uiAutomation.executeShellCommand(cmd).let { ParcelFileDescriptor.AutoCloseInputStream(it).use { s -> s.readBytes().decodeToString() } }

    private var path = ""

    /** A JPG with GPS (Warsaw) written by the shell (not owned by the app: the media store redacts it for the app). */
    private fun photoWithGps(): Uri {
        val f = File(ctx.cacheDir, "gps.jpg")
        f.outputStream().use { Bitmap.createBitmap(64, 48, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.JPEG, 80, it) }
        ExifInterface(f.path).apply {
            setAttribute(ExifInterface.TAG_GPS_LATITUDE, "52/1,13/1,469/10"); setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, "N")
            setAttribute(ExifInterface.TAG_GPS_LONGITUDE, "21/1,0/1,439/10"); setAttribute(ExifInterface.TAG_GPS_LONGITUDE_REF, "E")
            saveAttributes()
        }
        path = "/sdcard/DCIM/Camera/ddn-gps-test-${System.currentTimeMillis()}.jpg"
        shell("mkdir -p /sdcard/DCIM/Camera")
        // The shell splits on spaces without quoting: tee writes its standard input to the path.
        val (read, write) = ins.uiAutomation.executeShellCommandRw("tee $path").let { it[0] to it[1] }
        ParcelFileDescriptor.AutoCloseOutputStream(write).use { o -> f.inputStream().use { it.copyTo(o) } }
        ParcelFileDescriptor.AutoCloseInputStream(read).use { it.readBytes() }
        f.delete()
        var uri: Uri? = null
        val done = CountDownLatch(1)
        MediaScannerConnection.scanFile(ctx, arrayOf(path), arrayOf("image/jpeg")) { _, u -> uri = u; done.countDown() }
        done.await(20, TimeUnit.SECONDS)
        return assertNotNull("scanned", uri).let { uri!! }
    }

    private fun latLong(u: Uri): FloatArray? = MediaLocation.open(ctx, u).use { ExifInterface(it) }.let { e -> FloatArray(2).takeIf { e.getLatLong(it) } }

    @Test
    fun askedAndKept() {
        assumeFalse("needs ACCESS_MEDIA_LOCATION revoked before the run", MediaLocation.granted(ctx))
        val prefs = ctx.getSharedPreferences("ddn-backup", android.content.Context.MODE_PRIVATE)
        val before = prefs.all.toMap()
        val u = photoWithGps()
        try {
            assertTrue("photos' access granted", MediaLocation.hasMediaAccess(ctx))
            // Without the permission: the position is zeroed, the app knows it must ask, the automatic copy waits.
            val redacted = latLong(u)
            assertTrue("redacted without the permission: ${redacted?.toList()}", redacted == null || (redacted[0] == 0f && redacted[1] == 0f))
            assertTrue("a share of the photo asks first", MediaLocation.shouldAsk(ctx, listOf(u)))
            assertFalse("a file of the app's own does not ask", MediaLocation.shouldAsk(ctx, listOf(Uri.fromFile(File(ctx.cacheDir, "x.jpg")))))
            DdnBackup.setLocationDeclined(ctx, false)
            assertFalse("the automatic copy waits", DdnBackup.mayCopyMedia(ctx))
            DdnBackup.setLocationDeclined(ctx, true)
            assertTrue("refused: copies go without the position", DdnBackup.mayCopyMedia(ctx))
            DdnBackup.setLocationDeclined(ctx, false)

            // The automatic copy is on: its screen asks by itself; the photos' access grants it without a dialog.
            prefs.edit().putBoolean("on", true).apply()
            val t0 = System.currentTimeMillis()
            ActivityScenario.launch<DdnBackupActivity>(Intent(ctx, DdnBackupActivity::class.java)).use {
                val until = System.currentTimeMillis() + 15_000
                while (!MediaLocation.granted(ctx) && System.currentTimeMillis() < until) Thread.sleep(200)
            }
            android.util.Log.i("ddn-ui", "media location granted after ${System.currentTimeMillis() - t0} ms")
            assertTrue("granted by the automatic copy screen", MediaLocation.granted(ctx))
            assertTrue("the automatic copy goes on", DdnBackup.mayCopyMedia(ctx))
            assertFalse("nothing more to ask", MediaLocation.shouldAsk(ctx, listOf(u)))
            // The original bytes, with the position.
            val ll = latLong(u)
            assertNotNull("position kept", ll)
            assertEquals(52.2297f, ll!![0], 0.001f)
            assertEquals(21.0122f, ll[1], 0.001f)
        } finally {
            // Not the app's file (the media store refuses its delete): the shell removes it, the scanner forgets it.
            shell("rm -f $path")
            MediaScannerConnection.scanFile(ctx, arrayOf(path), null, null)
            prefs.edit().clear().apply { before.forEach { (k, v) -> when (v) { is Boolean -> putBoolean(k, v); is Int -> putInt(k, v); is Long -> putLong(k, v); is String -> putString(k, v); is Set<*> -> putStringSet(k, v.map { it.toString() }.toSet()) } } }.apply()
        }
    }
}
