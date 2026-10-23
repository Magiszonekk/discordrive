package com.discordrive.gallery

import android.content.Intent
import android.graphics.Bitmap
import android.util.Log
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.magiszonekk.discordrive.core.AccountSync
import io.github.magiszonekk.discordrive.core.Ed25519Key
import io.github.magiszonekk.discordrive.core.InstanceApi
import io.github.magiszonekk.discordrive.core.InteropScenario
import io.github.magiszonekk.discordrive.core.Pairing
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import android.net.Uri
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The app's browsing screens on a real account (apps/android/interop/harness.mts --app): pair through the
 * instance, then Files (root → the photo folder), the Gallery grid with the thumbnail of a web upload, the
 * viewer of the photo. Screenshots go to the app's files dir (adb pull). Skipped unless the harness started it.
 */
@RunWith(AndroidJUnit4::class)
class BrowseUiTest {
    private val inst = InstrumentationRegistry.getInstrumentation()
    private val ctx = inst.targetContext

    private fun shot(name: String) {
        Thread.sleep(800)
        val b: Bitmap = inst.uiAutomation.takeScreenshot()
        val dir = File(ctx.getExternalFilesDir(null), "shots").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { b.compress(Bitmap.CompressFormat.PNG, 90, it) }
    }

    private fun waitUntil(ms: Long = 30_000, f: () -> Boolean): Boolean {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) { if (runCatching(f).getOrDefault(false)) return true; Thread.sleep(200) }
        return false
    }

    private fun items(s: ActivityScenario<out DdnActivity>): Int {
        var n = -1
        s.onActivity { a -> n = a.findRecycler()?.adapter?.itemCount ?: -1 }
        return n
    }

    private fun uploads(sc: InteropScenario, r: LinkedHashMap<String, Boolean>) {
        val cr = ctx.contentResolver
        // A photo in DCIM/Camera (MediaStore, as the camera app writes it).
        val bmp = Bitmap.createBitmap(1600, 1200, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.rgb(30, 120, 200)) }
        val name = "PXL_test_${System.currentTimeMillis()}.jpg"
        val values = android.content.ContentValues().apply {
            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "DCIM/Camera")
        }
        val uri = cr.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
        cr.openOutputStream(uri)!!.use { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        val photoBytes = cr.openInputStream(uri)!!.use { it.readBytes() }
        try {
            // A shared file (a text file the app reads through a content URI of its own).
            val shared = File(ctx.cacheDir, "notatka z telefonu.txt").apply { writeText("z telefonu " + "x".repeat(150_000)) }
            val sharedUri = Uri.fromFile(shared)
            DdnUploads.queue(ctx, listOf(sharedUri), null)
            DdnBackup.set(ctx, on = true, wifi = false, charging = false, buckets = setOf("Camera"))
            val wm = androidx.work.WorkManager.getInstance(ctx)
            DdnBackup.runNow(ctx)
            r["uploadJobDone"] = waitUntil(180_000) { wm.getWorkInfosForUniqueWork(DdnBackup.WORK_NOW).get().let { l -> l.isNotEmpty() && l.all { it.state.isFinished } } && DdnBackup.status(ctx)?.waiting == 0 }
            val st = DdnBackup.status(ctx)
            Log.i("ddn-ui", "upload status: $st")
            val sess = DdnSession.get(ctx)!!
            val phoneRoot = sess.children("root").firstOrNull { it.name == DdnBackup.rootName(sess.acct.deviceName) }
            val cam = phoneRoot?.let { f -> sess.children(f.id).firstOrNull { it.name == "Camera" } }
            val copy = cam?.let { f -> sess.children(f.id).firstOrNull { it.name == name } }
            r["autoCopyInCameraFolder"] = copy != null && copy.size == photoBytes.size.toLong()
            val z = sess.children("root").firstOrNull { it.name == DdnUploads.SHARED_FOLDER }
            r["sharedInZTelefonu"] = z != null && sess.children(z.id).any { it.name == "notatka z telefonu.txt" && it.size == shared.length() }
            if (copy != null) {
                val v = sc.rpc("phoneUpload", buildJsonObject {
                    put("folder", cam.id); put("name", name); put("sha", io.github.magiszonekk.discordrive.core.sha256Hex(photoBytes)); put("thumbSha", "")
                }).jsonObject
                r["webDownloadsAutoCopy"] = v.getValue("sha").jsonPrimitive.content == "true"
                r["autoCopyHasThumbnail"] = v["thumbW"]?.jsonPrimitive?.content == "320"
            }
            // A second run copies nothing again.
            DdnBackup.runNow(ctx)
            Thread.sleep(2000)
            waitUntil(60_000) { wm.getWorkInfosForUniqueWork(DdnBackup.WORK_NOW).get().all { it.state.isFinished } }
            sess.refresh()
            r["copiedOnce"] = DdnBackup.status(ctx)?.copied == 0 && cam != null && sess.children(cam.id).count { it.name == name } == 1 &&
                z != null && sess.children(z.id).count { it.name.startsWith("notatka z telefonu") } == 1
        } finally {
            DdnBackup.set(ctx, on = false)
            cr.delete(uri, null, null)
        }
    }

    @Test
    fun filesGalleryViewer() {
        val args = InstrumentationRegistry.getArguments()
        val rpc = args.getString("ddnRpc")
        assumeTrue("started by apps/android/interop/harness.mts --app", rpc != null)
        val server = args.getString("ddnServer")!!
        val sc = InteropScenario(rpc!!, server, args.getString("ddnDiscord")!!)
        // Pair this app with the TS account (as the Join screen does).
        DdnSession.forget(ctx)
        DdnAccount.forget(ctx)
        val dev = Ed25519Key.generate()
        val p = Pairing.start(dev.publicKey)
        sc.rpc("offer", JsonPrimitive(p.offer))
        val anon = InstanceApi(server, null, null, null)
        val res = p.complete(anon.pairingTake(p.pairingId)!!)
        DdnAccount.save(ctx, AccountSync.finishPairing(server, "Pixel 7 (UI test)", dev, res, anon))
        val r = LinkedHashMap<String, Boolean>()

        // The harness's fake Discord (adb reverse to 127.0.0.1) instead of discord.com.
        DdnSession.testDiscordOrigin = args.getString("ddnDiscord")!!.takeUnless { it == "none" }
        DdnSessionDirs.cacheDir = ctx.cacheDir
        ActivityScenario.launch<DdnActivity>(Intent(ctx, DdnActivity::class.java)).use { s ->
            r["filesRoot"] = waitUntil { items(s) >= 39 }
            shot("1-files-root")
            s.onActivity { a -> a.openFolderForTest("fold-0000000001", "Zdjęcia 1") }
            r["photoFolder"] = waitUntil { items(s) == 3 }
            shot("2-folder")
            s.onActivity { a -> a.showGalleryForTest() }
            r["galleryTwoMedia"] = waitUntil { items(s) == 2 }
            // The thumbnail of the photo (stored by the web upload) is decrypted through the tiles' path; on an
            // unlocked screen the tile shows it too (a locked phone draws no window: then only the first check).
            val sess = DdnSession.get(ctx)!!
            val photoRow = sess.media(10, null).first { it.name.endsWith(".jpg") }
            r["thumbnailDecoded"] = DdnThumbs.load(sess, photoRow.manifestRef!!, 't', 320)?.let { it.width == 320 && it.height == 240 } == true
            val drawn = waitUntil(5_000) { var ok = false; s.onActivity { a -> ok = a.isDrawn() }; ok }
            if (drawn) r["thumbnailShown"] = waitUntil { var ok = false; s.onActivity { a -> ok = a.firstCellHasPicture() }; ok }
            Log.i("ddn-ui", "window drawn: $drawn")
            shot("3-gallery")
        }
        val photo = DdnSession.get(ctx)!!.media(10, null).first { it.name.endsWith(".jpg") }
        DdnViewerActivity.pending = listOf(photo)
        ActivityScenario.launch<DdnViewerActivity>(Intent(ctx, DdnViewerActivity::class.java).putExtra("id", photo.id)).use { v ->
            r["viewerPicture"] = waitUntil { var ok = false; v.onActivity { a -> ok = a.hasPictureForTest() }; ok }
            shot("4-viewer")
        }
        // Upload from the phone (PR 4): a file shared into the queue and a photo of the camera folder copied
        // automatically, both through the background job (WorkManager, as in the app); the TS device downloads
        // them and checks the bytes and the thumbnail made on the phone.
        uploads(sc, r)
        Log.i("ddn-ui", "RESULT $r")
        sc.rpc("done", kotlinx.serialization.json.JsonObject(r.mapValues { JsonPrimitive(it.value) }))
        assertTrue("ui checks: $r", r.values.all { it })
    }
}
