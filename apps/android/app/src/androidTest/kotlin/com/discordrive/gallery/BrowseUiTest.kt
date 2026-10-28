package com.discordrive.gallery

import android.content.Intent
import android.graphics.Bitmap
import android.util.Log
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.magiszonekk.discordrive.core.IndexReplica
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
import kotlinx.serialization.json.int

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
            // The camera's photos go to the Gallery without an album (the timeline); nothing under Files.
            val cam = sess.galleryRoot
            val copy = sess.children(cam).firstOrNull { it.name == name }
            r["autoCopyInGallery"] = copy != null && copy.size == photoBytes.size.toLong() && sess.media(500, null).any { it.id == copy.id } &&
                sess.children("root").none { it.name == DdnBackup.rootName(sess.acct.deviceName) }
            val z = sess.children("root").firstOrNull { it.name == DdnUploads.SHARED_FOLDER }
            r["sharedInZTelefonu"] = z != null && sess.children(z.id).any { it.name == "notatka z telefonu.txt" && it.size == shared.length() }
            if (copy != null) {
                val v = sc.rpc("phoneUpload", buildJsonObject {
                    put("folder", cam); put("name", name); put("sha", io.github.magiszonekk.discordrive.core.sha256Hex(photoBytes)); put("thumbSha", "")
                }).jsonObject
                r["webDownloadsAutoCopy"] = v.getValue("sha").jsonPrimitive.content == "true"
                r["autoCopyHasThumbnail"] = v["thumbW"]?.jsonPrimitive?.content == "320"
                Log.i("ddn-ui", "auto-copy picture: short side ${v["thumbW"]}; made here: ${runCatching { DdnPictures.make(ctx.contentResolver, uri).map { "${it.kind} ${it.width}x${it.height} ${it.data.size}" } }.getOrElse { it.toString() }}")
            }
            // A second run copies nothing again.
            DdnBackup.runNow(ctx)
            Thread.sleep(2000)
            waitUntil(60_000) { wm.getWorkInfosForUniqueWork(DdnBackup.WORK_NOW).get().all { it.state.isFinished } }
            sess.refresh()
            r["copiedOnce"] = DdnBackup.status(ctx)?.copied == 0 && sess.children(cam).count { it.name == name } == 1 &&
                z != null && sess.children(z.id).count { it.name.startsWith("notatka z telefonu") } == 1
            // Free up space: the copied photo has a verified copy (same size and SHA-256, not in the trash).
            ActivityScenario.launch<DdnFreeUpActivity>(Intent(ctx, DdnFreeUpActivity::class.java)).use { f ->
                waitUntil(60_000) { var ok = false; f.onActivity { a -> ok = a.checkedForTest }; ok }
                var sc: DdnFreeUp.Scan? = null
                f.onActivity { a -> sc = a.scanForTest() }
                r["freeUpFindsCopied"] = sc?.ready?.any { it.name == name && it.size == photoBytes.size.toLong() } == true
                r["freeUpSystemRequest"] = sc?.let { DdnFreeUp.request(ctx, it.ready) } != null
                Log.i("ddn-ui", "free up: ready ${sc?.ready?.size}, not copied ${sc?.notCopied}, changed ${sc?.changed}, gone ${sc?.gone}")
                shot("10-free-up")
            }
            // Edited on the phone after the copy (same size and date kept): its bytes differ, so it is not offered.
            val edited = photoBytes.copyOf().also { it[it.size - 3] = (it[it.size - 3] + 1).toByte() }
            cr.openOutputStream(uri, "wt")!!.use { it.write(edited) }
            val now = DdnFreeUp.scan(ctx)
            r["freeUpSkipsChanged"] = now.ready.none { it.name == name }
        } finally {
            DdnBackup.set(ctx, on = false)
            cr.delete(uri, null, null)
        }
    }

    /**
     * A file the phone cannot send (the account's webhooks removed on Discord: 404): it stays in the queue with
     * its cause in words, the automatic copy screen lists it; webhooks back, Retry sends it; Remove drops one.
     */
    private fun failedUpload(sc: InteropScenario, r: LinkedHashMap<String, Boolean>) {
        if (sc.rpc("hooksOff").jsonPrimitive.int < 0) return // real Discord: not here
        val wm = androidx.work.WorkManager.getInstance(ctx)
        val f1 = File(ctx.cacheDir, "nie dojdzie.txt").apply { writeText("x".repeat(5000)) }
        val f2 = File(ctx.cacheDir, "do usunięcia.txt").apply { writeText("y".repeat(3000)) }
        try {
            DdnUploads.queue(ctx, listOf(Uri.fromFile(f1), Uri.fromFile(f2)), null)
            waitUntil(120_000) { wm.getWorkInfosForUniqueWork(DdnBackup.WORK_NOW).get().let { l -> l.isNotEmpty() && l.all { it.state.isFinished } } }
            val failed = DdnBackup.failed(ctx)
            Log.i("ddn-ui", "failed: ${failed.map { it.name + " / " + it.error }}")
            r["failedListed"] = failed.map { it.name }.toSet() == setOf("nie dojdzie.txt", "do usunięcia.txt")
            // Every channel removed: the cause says so (add a channel, remove the old ones).
            r["failedReasonInWords"] = failed.all { DdnBackup.reason(ctx, it.error!!) == ctx.getString(R.string.ddn_fail_all_channels_gone) }
            ActivityScenario.launch<DdnBackupActivity>(Intent(ctx, DdnBackupActivity::class.java)).use { b ->
                Thread.sleep(800)
                shot("13-failed-upload")
            }
            // Remove one, retry the other with the webhooks back.
            DdnBackup.Db(ctx).drop(failed.first { it.name == "do usunięcia.txt" }.id)
            sc.rpc("hooksOn")
            DdnBackup.Db(ctx).retry(failed.first { it.name == "nie dojdzie.txt" }.id)
            DdnBackup.runNow(ctx, autoCopy = false)
            Thread.sleep(1500)
            waitUntil(120_000) { wm.getWorkInfosForUniqueWork(DdnBackup.WORK_NOW).get().all { it.state.isFinished } }
            val s = DdnSession.get(ctx)!!
            s.refresh()
            val z = s.children("root").firstOrNull { it.name == DdnUploads.SHARED_FOLDER }
            r["retrySends"] = DdnBackup.failed(ctx).isEmpty() && z != null && s.children(z.id).any { it.name == "nie dojdzie.txt" } && s.children(z.id).none { it.name == "do usunięcia.txt" }

            // N16: the file sent while every webhook answered 404 is not there; a photo whose pieces are on a
            // removed channel shows "unavailable" in the viewer (the webhooks off again for it).
            run {
                s.refresh()
                val pic = s.media(50, null).firstOrNull { DdnSession.isImage(it.name) && (it.size ?: 0) > 0 }
                if (pic != null) {
                    sc.rpc("hooksOff")
                    io.github.magiszonekk.discordrive.core.FileWriter.dead.clear()
                    // The fragments are read through the webhooks (now gone); the session as it is.
                    DdnViewerActivity.pending = listOf(pic)
                    ActivityScenario.launch<DdnViewerActivity>(Intent(ctx, DdnViewerActivity::class.java).putExtra("id", pic.id)).use { v ->
                        r["viewerSaysUnavailable"] = waitUntil(30_000) { var ok = false; v.onActivity { a -> ok = a.textForTest().contains(ctx.getString(R.string.ddn_file_unavailable).take(16)) }; ok }
                        shot("13b-unavailable")
                    }
                    sc.rpc("hooksOn")
                }
            }
            // Two channels, one removed on Discord (the other works): the upload goes to the working one.
            io.github.magiszonekk.discordrive.core.FileWriter.dead.clear()
            val hooks = io.github.magiszonekk.discordrive.core.Vault.webhooks(s.sync.vault).filter { !it.retired }
            if (hooks.size >= 2) {
                sc.rpc("hooksOff", kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive(hooks[0].id))))
                val f3 = File(ctx.cacheDir, "drugi kanał.txt").apply { writeText("z".repeat(200_000)) }
                DdnUploads.queue(ctx, listOf(Uri.fromFile(f3)), null)
                Thread.sleep(1500)
                waitUntil(120_000) { wm.getWorkInfosForUniqueWork(DdnBackup.WORK_NOW).get().all { it.state.isFinished } }
                s.refresh()
                r["deadChannelSkipped"] = DdnBackup.failed(ctx).isEmpty() && z != null && s.children(z.id).any { it.name == "drugi kanał.txt" } &&
                    hooks[0].id in io.github.magiszonekk.discordrive.core.FileWriter.dead
                f3.delete()
            }
        } finally {
            sc.rpc("hooksOn")
            io.github.magiszonekk.discordrive.core.FileWriter.dead.clear()
        }
    }

    /**
     * The editor: the web upload's photo rotated and saved as a copy next to it ("<name> (edycja).jpg", with its
     * thumbnail; the TS device downloads it and reads its thumbnail; the original is unchanged). The account in
     * the system's picker: the provider's root, a folder's children, opening a file gives its bytes (checked
     * against the TS hash), a thumbnail.
     */
    private fun editAndPicker(sc: InteropScenario, r: LinkedHashMap<String, Boolean>) {
        val s = DdnSession.get(ctx)!!
        val f = sc.rpc("files").jsonObject
        val photo = s.children("fold-0000000001").first { it.name.endsWith(".jpg") }
        DdnEditActivity.savedForTest = null
        DdnEditActivity.loadedForTest = false
        ActivityScenario.launch<DdnEditActivity>(Intent(ctx, DdnEditActivity::class.java).putExtra(DdnEditActivity.EXTRA_ID, photo.id)).use { e ->
            r["editLoads"] = waitUntil(30_000) { DdnEditActivity.loadedForTest }
            r["editToolsEnabled"] = run { var ok = false; e.onActivity { a -> ok = a.toolsEnabledForTest() }; ok }
            e.onActivity { a -> a.rotateForTest() }
            shot("12-edit")
            e.onActivity { a -> a.findViewById<android.view.View>(R.id.saveButton).performClick() }
            r["editSaved"] = waitUntil(60_000) { DdnEditActivity.savedForTest != null }
        }
        val name = DdnEditActivity.editedName(photo.name)
        s.refresh()
        val copy = s.children("fold-0000000001").firstOrNull { it.name == name }
        r["editCopyNextToOriginal"] = copy != null && s.children("fold-0000000001").any { it.id == photo.id && it.size == photo.size }
        if (copy != null) {
            val v = sc.rpc("phoneUpload", buildJsonObject { put("folder", "fold-0000000001"); put("name", name); put("sha", copy.sha256 ?: ""); put("thumbSha", "") }).jsonObject
            r["webReadsEditedCopy"] = v.getValue("sha").jsonPrimitive.content == "true" && (v["thumbW"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0) > 0
        }

        // The provider (as the system picker calls it).
        val auth = "${ctx.packageName}.ddn.documents"
        val cr = ctx.contentResolver
        val roots = cr.query(android.provider.DocumentsContract.buildRootsUri(auth), null, null, null, null)!!.use { it.count }
        r["pickerRoot"] = roots == 1
        val kids = cr.query(android.provider.DocumentsContract.buildChildDocumentsUri(auth, "fold-0000000001"), null, null, null, null)!!.use { c ->
            buildList { while (c.moveToNext()) add(c.getString(c.getColumnIndexOrThrow(android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME))) }
        }
        r["pickerListsFolder"] = kids.containsAll(listOf(photo.name, "film.webm"))
        val top = cr.query(android.provider.DocumentsContract.buildChildDocumentsUri(auth, "root"), null, null, null, null)!!.use { c ->
            buildList { while (c.moveToNext()) add(c.getString(c.getColumnIndexOrThrow(android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID))) }
        }
        val recent = cr.query(android.provider.DocumentsContract.buildChildDocumentsUri(auth, DdnDocumentsProvider.RECENT), null, null, null, null)!!.use { it.count }
        r["pickerRecentFolder"] = top.firstOrNull() == DdnDocumentsProvider.RECENT && recent >= 2
        // What ACTION_OPEN_DOCUMENT hands back is the document URI: its type and size as the picker reports them.
        val docUri = android.provider.DocumentsContract.buildDocumentUri(auth, photo.id)
        r["openDocumentUri"] = cr.getType(docUri) == "image/jpeg" &&
            cr.query(docUri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME, android.provider.OpenableColumns.SIZE), null, null, null)!!.use { c -> c.moveToFirst() && c.getString(0) == photo.name && c.getLong(1) == photo.size }
        val big = s.children("fold-0000000001").firstOrNull { it.name == "film.webm" }
        if (big != null) {
            val bytes = cr.openInputStream(android.provider.DocumentsContract.buildDocumentUri(auth, big.id))!!.use { it.readBytes() }
            r["pickerOpensFile"] = io.github.magiszonekk.discordrive.core.sha256Hex(bytes) == f.getValue("files").jsonObject.getValue("film.webm").jsonObject.getValue("sha").jsonPrimitive.content
        }
        r["pickerThumbnail"] = runCatching {
            android.provider.DocumentsContract.getDocumentThumbnail(cr, android.provider.DocumentsContract.buildDocumentUri(auth, photo.id), android.graphics.Point(256, 256), null)
        }.getOrNull() != null
        // GET_CONTENT goes to the system picker, which lists this provider's root.
        r["getContentResolves"] = ctx.packageManager.queryIntentActivities(Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE), 0).isNotEmpty()
    }

    /**
     * Albums: the folder with the photo and the video is an album (cover = the newest, count 2). Made private
     * (a PIN set here): its media leave the Gallery, the tile shows the lock; the PIN check opens it. Then public
     * again (nothing of this reaches the account).
     */
    /**
     * The viewer (opened on the photo of the album "Zdjęcia 1", moved into the Gallery above): its pages are the
     * list it was opened from; a swipe goes to the next file (the video, which plays) and back (the video stops);
     * the top bar has Download, Share and ⋮ and hides by itself; ⋮ lists the gallery's actions; Info names the
     * place, the size and the photo's dimensions; Show in folder opens the album.
     */
    private fun viewer(r: LinkedHashMap<String, Boolean>) {
        val s = DdnSession.get(ctx)!!
        val list = s.albumMedia("fold-0000000001").sortedBy { if (it.name.endsWith(".jpg")) 0 else 1 }
        val photo = list.first { it.name.endsWith(".jpg") }
        val film = list.firstOrNull { it.name == "film.webm" }
        DdnViewerActivity.pending = list
        var folderIntent: Intent? = null
        ActivityScenario.launch<DdnViewerActivity>(Intent(ctx, DdnViewerActivity::class.java).putExtra("id", photo.id)).use { v ->
            fun <T> on(f: (DdnViewerActivity) -> T): T { var x: T? = null; v.onActivity { a -> x = f(a) }; @Suppress("UNCHECKED_CAST") return x as T }
            r["viewerPicture"] = waitUntil { on { it.hasPictureForTest() } }
            r["viewerPages"] = on { it.pagesForTest() == list.size && it.pageForTest() == 0 && it.titleForTest() == photo.name }
            // The top bar: Download, Share, ⋮ (nothing at the bottom any more).
            r["viewerActions"] = on { it.actionsForTest() } == listOf(R.string.ddn_download, R.string.ddn_share, R.string.ddn_more).map { ctx.getString(it) }
            shot("4-viewer")
            // Hides by itself (~3 s without a touch), a tap brings it back.
            r["viewerChromeAtStart"] = on { it.chromeShownForTest() }
            val pagerTop = on { it.pagerTopForTest() }
            r["viewerChromeHides"] = waitUntil(6_000) { !on { it.chromeShownForTest() } }
            shot("4a-viewer-hidden")
            // Full screen without a jump: the page stays where it was when the bars hide.
            r["viewerNoJump"] = on { it.pagerTopForTest() } == pagerTop
            on { it.tapForTest() }
            r["viewerChromeTap"] = waitUntil(2_000) { on { it.chromeShownForTest() } }
            // ⋮ of a photo in the Gallery: the gallery's actions; Info: where, size, dimensions (640 × 480).
            val menu = on { it.menuItems(s, photo).map { m -> m.first } }
            r["viewerMenu"] = menu == listOf(R.string.ddn_edit, R.string.ddn_info, R.string.viewer_set_wallpaper, R.string.action_move_to_album, R.string.ddn_to_drive, R.string.safe_to_safe, R.string.ddn_show_in_folder, R.string.ddn_delete).map { ctx.getString(it) }
            val meta = ViewerInfo.read(s, photo)
            val info = on { it.infoLines(s, photo, meta) }
            r["viewerInfo"] = info.contains(ctx.getString(R.string.ddn_info_where, "Galeria / Zdjęcia 1")) && info.any { it.startsWith(ctx.getString(R.string.ddn_info_size, "").trimEnd()) } &&
                info.any { it.startsWith(ctx.getString(R.string.ddn_info_dims, 640, 480)) }
            Log.i("ddn-ui", "viewer menu $menu, info $info")
            // Show in folder: the Files screen opens the album the photo is in.
            val shown = on { it.folderIntentForTest(s, photo) }
            r["viewerShowInFolder"] = shown.getStringExtra(DdnActivity.START) == "album" && shown.getStringExtra(DdnActivity.ALBUM_ID) == "fold-0000000001"
            folderIntent = shown
            // N62: moved (here to the Gallery's timeline) while open: ⋮, Info and Show in folder follow the new
            // place; the same move again says it is already there (not "another device").
            if (s.move(listOf(photo.id), s.galleryRoot) == "applied") {
                on { it.movedForTest(s.node(photo.id)!!) }
                val cur = on { it.currentForTest() }!!
                r["viewerMovedFollows"] = cur.parentId == s.galleryRoot && on { it.folderIntentForTest(s, cur) }.getStringExtra(DdnActivity.START) == "gallery" &&
                    on { it.infoLines(s, cur) }.contains(ctx.getString(R.string.ddn_info_where, "Galeria"))
                r["viewerMoveAgainInWords"] = s.move(listOf(photo.id), s.galleryRoot).let { DdnViewerActivity.moveOutcome(ctx, it, "ok") } == ctx.getString(R.string.ddn_move_noop)
                r["viewerMovedBack"] = s.move(listOf(photo.id), "fold-0000000001") == "applied"
                on { it.movedForTest(s.node(photo.id)!!) }
            } else r["viewerMovedFollows"] = false
            if (film != null) {
                // Swipe to the video: the next page, its name in the bar, it plays; its controls clear of the bars.
                val at = list.indexOf(film)
                repeat(at) { on { a -> a.dragForTest(-a.window.decorView.width * 0.8f) }; Thread.sleep(800) }
                r["viewerSwipeNext"] = waitUntil(5_000) { on { it.pageForTest() == at && it.titleForTest() == film.name } }
                r["viewerVideoPlays"] = waitUntil(10_000) { on { it.playingForTest() } == film.id }
                r["viewerVideoControlsClear"] = waitUntil(30_000) { on { a -> a.showControlsForTest(); a.controlsClearForTest() } == true }
                r["viewerVideoMenu"] = on { it.menuItems(s, film).map { m -> m.first } }.let { !it.contains(ctx.getString(R.string.ddn_edit)) && !it.contains(ctx.getString(R.string.viewer_set_wallpaper)) && it.contains(ctx.getString(R.string.action_move_to_album)) }
                shot("4b-viewer-video")
                // Back to the photo: the video stops (no player), the photo's page again.
                repeat(at) { on { a -> a.dragForTest(a.window.decorView.width * 0.8f) }; Thread.sleep(800) }
                r["viewerSwipeBack"] = waitUntil(5_000) { on { it.pageForTest() == 0 && it.titleForTest() == photo.name } }
                r["viewerVideoStops"] = waitUntil(5_000) { on { it.playingForTest() } == null }
            }
        }
        // (Each scenario starts a new task: these run after the viewer's.) Show in folder opens the album.
        ActivityScenario.launch<DdnActivity>(folderIntent!!).use { f -> r["viewerShowInFolderOpens"] = waitUntil { items(f) == list.size } }
        // Set as wallpaper: the photo of the account in the cropper (not applied: the device's wallpaper stays).
        ActivityScenario.launch<DdnWallpaperActivity>(Intent(ctx, DdnWallpaperActivity::class.java).putExtra(DdnWallpaperActivity.EXTRA_ID, photo.id)).use { w ->
            r["viewerWallpaperLoads"] = waitUntil { var ok = false; w.onActivity { a -> ok = a.loadedForTest() }; ok }
            shot("4c-wallpaper")
        }
    }

    private fun albums(r: LinkedHashMap<String, Boolean>) {
        val s = DdnSession.get(ctx)!!
        val al = s.albums()
        val a = al.firstOrNull { it.id == "fold-0000000001" }
        r["albumListed"] = a != null && a.count == 2 && a.name == "Zdjęcia 1"
        PrivateAlbums.setPin(ctx, "4321")
        DdnPrivate.set(ctx, "fold-0000000001", true)
        try {
            r["privateHiddenInGallery"] = s.media(100, null, DdnPrivate.all(ctx)).none { it.parentId == "fold-0000000001" } && s.media(100, null).any { it.parentId == "fold-0000000001" }
            ActivityScenario.launch<DdnActivity>(Intent(ctx, DdnActivity::class.java)).use { sc ->
                sc.onActivity { x -> x.showAlbumsForTest() }
                r["albumsTab"] = waitUntil { items(sc) >= 1 }
                shot("11-albums")
                sc.onActivity { x -> x.openAlbumForTest("fold-0000000001", "Zdjęcia 1") }
                r["albumOpens"] = waitUntil { items(sc) == 2 }
            }
            r["pinChecks"] = PrivateAlbums.verifyPin(ctx, "4321") && !PrivateAlbums.verifyPin(ctx, "0000")
        } finally {
            DdnPrivate.set(ctx, "fold-0000000001", false)
            SecureStore(ctx).remove(SecureStore.PRIVATE_PIN)
        }
        r["publicAgain"] = s.media(100, null, DdnPrivate.all(ctx)).any { it.parentId == "fold-0000000001" }
    }

    /**
     * Search (after aiDescriptions described the photos): by a word of the description, by the text on the
     * picture, by name; a private album's photos are not found; descriptions stored by another device reach
     * this phone's table (the local table cleared, syncDescriptions reads them from the account).
     */
    private fun search(sc: InteropScenario, r: LinkedHashMap<String, Boolean>) {
        val s = DdnSession.get(ctx)!!
        val db = DdnAi.Db(ctx)
        val acct = s.acct.accountId
        val described = db.records(acct)
        if (described.isEmpty()) { r["searchHasDescriptions"] = false; return }
        // As a new phone of the account: nothing in the table, the descriptions come from the stored files.
        db.clear(acct)
        val found = DdnAi.syncDescriptions(ctx, s)
        r["searchSyncsOtherDevices"] = found == described.size && db.records(acct).keys == described.keys
        val anyPhoto = s.media(100, null).first { it.manifestRef in described.keys }
        fun results(q: String): List<String> {
            var out: List<String> = emptyList()
            ActivityScenario.launch<DdnSearchActivity>(Intent(ctx, DdnSearchActivity::class.java).putExtra(DdnSearchActivity.QUERY, q)).use { a ->
                waitUntil { var ok = false; a.onActivity { x -> ok = x.readyForTest() }; ok }
                waitUntil(10_000) { a.onActivity { x -> out = x.resultsForTest() }; out.isNotEmpty() }
                Thread.sleep(800)
                a.onActivity { x -> out = x.resultsForTest() }
                if (q == "obraz testowy") shot("15-search")
            }
            return out
        }
        val all = s.media(100, null).filter { it.manifestRef in described.keys }.map { it.name }.toSet()
        r["searchByDescription"] = results("obraz testowy").toSet() == all
        r["searchByPictureText"] = results("discordrive 42").toSet() == all
        // Search by the date the content was made, not when it was sent: a file shared from the phone with an
        // mtime of 2024-05-17 (today's upload) is found under "2024-05"; the web client reads its takenAt.
        val old = File(ctx.cacheDir, "stare zdjecie.txt").apply { writeText("x".repeat(5000)); setLastModified(1715940000000L) }
        DdnUploads.queue(ctx, listOf(android.net.Uri.fromFile(old)), null)
        Thread.sleep(1500)
        waitUntil(120_000) { androidx.work.WorkManager.getInstance(ctx).getWorkInfosForUniqueWork(DdnBackup.WORK_NOW).get().all { it.state.isFinished } }
        s.refresh()
        r["takenAtStoredFromPhone"] = sc.rpc("takenOf", JsonPrimitive("stare zdjecie.txt")).let { it is JsonPrimitive && it.content == "1715940000000" }
        DdnAi.syncDescriptions(ctx, s)
        val may = results("2024-05")
        r["searchByTakenDate"] = "stare zdjecie.txt" in may && results("2024-05-17").contains("stare zdjecie.txt")
        r["searchWebTakenDate"] = s.children("fold-0000000001").none { it.name == "Wakacje \u017B.jpg" } || "Wakacje \u017B.jpg" in may
        old.delete()
        r["searchByName"] = s.children("fold-0000000001").none { it.name == "Wakacje \u017B.jpg" } || results("wakacje").isNotEmpty()
        // N58: a result moved to the trash from the viewer is gone from the results when the search comes back.
        ActivityScenario.launch<DdnSearchActivity>(Intent(ctx, DdnSearchActivity::class.java).putExtra(DdnSearchActivity.QUERY, "obraz testowy")).use { a ->
            waitUntil { var ok = false; a.onActivity { x -> ok = x.readyForTest() }; ok }
            var before: List<String> = emptyList()
            waitUntil(10_000) { a.onActivity { x -> before = x.resultIdsForTest() }; before.isNotEmpty() }
            Thread.sleep(800)
            a.onActivity { x -> before = x.resultIdsForTest() }
            val gone = before.first()
            a.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
            val trashed = s.moveToTrash(listOf(gone))
            a.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
            var after: List<String> = before
            val refreshed = waitUntil(10_000) { var ok = false; a.onActivity { x -> ok = x.refreshForTest; after = x.resultIdsForTest() }; ok }
            Log.i("ddn-ui", "search after trash: $trashed, refreshed $refreshed, ${before.size} -> ${after.size}")
            r["searchDropsTrashed"] = trashed == "applied" && refreshed && after.size == before.size - 1 && gone !in after
            s.restore(listOf(gone))
        }
        DdnPrivate.set(ctx, anyPhoto.parentId!!, true)
        try {
            r["searchPrivateLeftOut"] = anyPhoto.name !in results("obraz testowy")
        } finally {
            DdnPrivate.set(ctx, anyPhoto.parentId!!, false)
        }
    }

    /**
     * AI descriptions (Settings → AI search) against the harness's fake endpoint: a wrong key is a readable
     * error, the check describes the test picture, the background run describes the account's photos (a 429
     * answered once on the way), stores each description with the file (the web client opens it), and a second
     * run sends nothing again. A private album is left out.
     */
    private fun aiDescriptions(sc: InteropScenario, r: LinkedHashMap<String, Boolean>, aiApi: String?) {
        if (aiApi == null) return
        val s = DdnSession.get(ctx)!!
        s.refresh()
        DdnAi.Db(ctx).clear(s.acct.accountId)
        // An endpoint stored by an older app in the vault ("ai") moves to the account's settings when read.
        s.sync.updateVault { v -> io.github.magiszonekk.discordrive.core.Describe.withConfig(v, io.github.magiszonekk.discordrive.core.Describe.AiConfig(aiApi, "old-key", "old-model")) }
        DdnAi.reloadConfig()
        r["aiConfigMigrated"] = DdnAi.config(ctx, s)?.model == "old-model" && sc.rpc("aiSettings").toString().contains("old-model") &&
            io.github.magiszonekk.discordrive.core.Describe.configOf(s.sync.vault) == null
        DdnAi.saveConfig(ctx, s, null)
        // An older instance without account settings (404): the endpoint is read from and saved to the vault
        // as before; the account's settings take it over once the server has them.
        sc.rpc("settingsOff", JsonPrimitive(true))
        try {
            s.sync.updateVault { v -> io.github.magiszonekk.discordrive.core.Describe.withConfig(v, io.github.magiszonekk.discordrive.core.Describe.AiConfig(aiApi, "vault-key", "vault-model")) }
            DdnAi.reloadConfig()
            val fromVault = DdnAi.config(ctx, s)?.model == "vault-model"
            DdnAi.saveConfig(ctx, s, io.github.magiszonekk.discordrive.core.Describe.AiConfig(aiApi, "vault-key", "vault-model-2"))
            r["aiOldServerUsesVault"] = fromVault && io.github.magiszonekk.discordrive.core.Describe.configOf(s.sync.loadVault())?.model == "vault-model-2"
        } finally {
            sc.rpc("settingsOff", JsonPrimitive(false))
        }
        DdnAi.reloadConfig()
        r["aiMovesWhenServerHasSettings"] = DdnAi.config(ctx, s)?.model == "vault-model-2" && sc.rpc("aiSettings").toString().contains("vault-model-2")
        DdnAi.saveConfig(ctx, s, null)
        // A private album is left out: the folder of one photo locked, the candidates without it.
        val every = DdnAi.candidates(ctx, s)
        val lockedFolder = every.lastOrNull()?.parentId
        if (lockedFolder != null) DdnPrivate.set(ctx, lockedFolder, true)
        try {
            // The phone in English, the app in Polish: descriptions are asked for in the app's language.
            val sysLocale = java.util.Locale.getDefault()
            java.util.Locale.setDefault(java.util.Locale.US)
            ActivityScenario.launch<DdnAiActivity>(Intent(ctx, DdnAiActivity::class.java)).use { a ->
                a.onActivity { r["aiKeyMasked"] = it.keyMaskedForTest() }
                a.onActivity { it.fillForTest(aiApi, "bad", "fake-vision"); it.checkForTest() }
                r["aiBadKeyReadable"] = waitUntil { var t = ""; a.onActivity { x -> t = x.resultForTest() }; t.contains(ctx.getString(R.string.ddn_ai_err_auth)) }
                a.onActivity { it.fillForTest(aiApi, "good-key", "fake-vision"); it.checkForTest() }
                r["aiCheckDescribes"] = waitUntil { var t = ""; a.onActivity { x -> t = x.resultForTest() }; t.contains("DISCORDRIVE 42") }
                shot("14-ai-settings")
            }
            // In the account's settings (every mode), read by the web client; the vault has no "ai".
            r["aiConfigInAccountSettings"] = sc.rpc("aiSettings").let { it is kotlinx.serialization.json.JsonObject && it["model"]?.toString() == "\"fake-vision\"" } &&
                io.github.magiszonekk.discordrive.core.Describe.configOf(s.sync.vault) == null
            val photos = DdnAi.candidates(ctx, s)
            // "Describe now" works with the background describing off.
            DdnAi.set(ctx, on = false, wifi = false, charging = false)
            val wm = androidx.work.WorkManager.getInstance(ctx)
            val pl0 = sc.rpc("aiPolish").jsonPrimitive.content.toInt()
            val calls0 = sc.rpc("aiCalls").jsonPrimitive.content.toInt()
            DdnAi.runNow(ctx)
            Thread.sleep(1500)
            waitUntil(240_000) { wm.getWorkInfosForUniqueWork(DdnAi.WORK_NOW).get().all { it.state.isFinished } }
            val db = DdnAi.Db(ctx)
            java.util.Locale.setDefault(sysLocale)
            val calls1 = sc.rpc("aiCalls").jsonPrimitive.content.toInt()
            r["aiPolishOnEnglishPhone"] = calls1 > calls0 && sc.rpc("aiPolish").jsonPrimitive.content.toInt() - pl0 == calls1 - calls0
            // Every photo handled (described, or "none": nothing decodable to send); the web client's photo described.
            r["aiDescribedAll"] = photos.isNotEmpty() && photos.all { db.state(s.acct.accountId, it.manifestRef!!)?.first in setOf("ok", "none") }
            r["aiPrivateLeftOut"] = lockedFolder != null && photos.none { it.parentId == lockedFolder } && every.size > photos.size
            val first = photos.firstOrNull { db.record(s.acct.accountId, it.manifestRef!!) != null } ?: photos.first()
            val web = sc.rpc("descriptionOf", JsonPrimitive(first.id))
            r["aiWebReadsDescription"] = web is kotlinx.serialization.json.JsonObject && web["text"]?.toString()?.contains("DISCORDRIVE 42") == true &&
                web["webSearchFinds"]?.toString() == "true"
            r["aiStoredWithFile"] = s.files.description(first.manifestRef!!)?.tags?.contains("pasy") == true
            // Thumbnails stay readable after the message edit.
            r["aiThumbnailKept"] = first.manifestRef.let { runCatching { s.files.preview(it!!, 't') }.getOrNull() } != null || !DdnSession.isImage(first.name)
            // A second run: nothing left, nothing sent.
            val before = sc.rpc("aiCalls").jsonPrimitive.content.toInt()
            DdnAi.runNow(ctx)
            Thread.sleep(1500)
            waitUntil(120_000) { wm.getWorkInfosForUniqueWork(DdnAi.WORK_NOW).get().all { it.state.isFinished } }
            r["aiSecondRunSendsNothing"] = sc.rpc("aiCalls").jsonPrimitive.content.toInt() == before
            DdnAi.setLang(ctx, "en")
            val other = DdnAi.otherLang(ctx, s)
            DdnAi.runRelang(ctx)
            Thread.sleep(1500)
            waitUntil(240_000) { wm.getWorkInfosForUniqueWork(DdnAi.WORK_NOW).get().all { it.state.isFinished } }
            r["aiRelang"] = other.isNotEmpty() && DdnAi.otherLang(ctx, s).isEmpty() &&
                other.all { db.record(s.acct.accountId, it.manifestRef!!)?.lang == "en" } &&
                s.files.description(other.first().manifestRef!!)?.lang == "pl"
            DdnAi.setLang(ctx, ctx.getString(R.string.ddn_ai_lang))
            ActivityScenario.launch<DdnAiActivity>(Intent(ctx, DdnAiActivity::class.java)).use { a ->
                val n = minOf(db.count(s.acct.accountId, "ok"), photos.size)
                r["aiProgressShown"] = waitUntil { var t = ""; a.onActivity { x -> t = x.progressForTest() }; t.startsWith(ctx.getString(R.string.ddn_ai_described, n, photos.size)) }
            }
        } finally {
            DdnAi.set(ctx, on = false)
            if (lockedFolder != null) DdnPrivate.set(ctx, lockedFolder, false)
        }
    }

    /**
     * PR 5: the trash (a file to the trash from the list's long press path, the trash screen lists it, restore,
     * delete for good; the TS device sees the same state), Settings (version, a newer build found in the fake
     * releases API, downloaded with its SHA-256 checked, handed to the system installer), Open with (VIEW) of
     * a photo of another app.
     */
    /**
     * The Safe on the phone: the screen offers to create it; created with a password it opens empty; a file of
     * Files moved in (sent again, gone from Files); closed by the button (no names), a wrong password refused, the
     * right one opens it again; the web opens the phone's Safe with the password and reads the moved file.
     */
    private fun safe(sc: InteropScenario, r: LinkedHashMap<String, Boolean>) {
        val pw = "kot ma ale i psa 2026"
        val s = DdnSession.get(ctx)!!
        s.refresh()
        DdnSafe.forget(ctx)
        ActivityScenario.launch<DdnSafeActivity>(Intent(ctx, DdnSafeActivity::class.java)).use { a ->
            r["safeOffersCreate"] = waitUntil { var st = ""; a.onActivity { x -> st = x.stateForTest }; st == "new" }
            shot("6-safe-new")
        }
        DdnSafe.create(ctx, pw)
        r["safeOpenEmpty"] = DdnSafe.isOpen && DdnSafe.children(ctx, "root").isEmpty()
        // A file of its own (uploaded here): moving it in must not change what other steps counted.
        val bytes = ByteArray(70_003) { (it * 31).toByte() }
        val up = s.uploader().upload({ bytes.inputStream() }, bytes.size.toLong(), "do-sejfu.pdf", "root")
        s.refresh()
        val doc = s.children("root").first { it.id == up.nodeId }
        val moved = DdnSafe.moveIn(ctx, listOf(doc))
        r["safeMovedIn"] = moved == 1 && DdnSafe.children(ctx, "root").map { it.name } == listOf("do-sejfu.pdf") && s.children("root").none { it.id == doc.id }
        ActivityScenario.launch<DdnSafeActivity>(Intent(ctx, DdnSafeActivity::class.java)).use { a ->
            r["safeScreenOpen"] = waitUntil { var st = ""; a.onActivity { x -> st = x.stateForTest }; st == "open" }
            shot("7-safe-open")
            a.onActivity { DdnSafe.close(ctx) }
            r["safeClosedByButton"] = waitUntil { var st = ""; a.onActivity { x -> st = x.stateForTest }; st == "closed" } && !DdnSafe.isOpen
        }
        r["safeNoNamesWhenClosed"] = runCatching { DdnSafe.children(ctx, "root") }.isFailure
        r["safeWrongPassword"] = runCatching { DdnSafe.unlock(ctx, "zle haslo zle haslo") }.exceptionOrNull() is io.github.magiszonekk.discordrive.core.Safe.BadPasswordException
        DdnSafe.unlock(ctx, pw)
        r["safeReopened"] = DdnSafe.children(ctx, "root").map { it.name } == listOf("do-sejfu.pdf")
        val web = sc.rpc("safeWeb", buildJsonObject { put("password", pw); put("file", "do-sejfu.pdf"); put("sha", up.sha256) }).jsonObject
        r["safeWebOpensPhoneSafe"] = web["fileSame"]?.jsonPrimitive?.content == "true"
        // A file opened from the Safe sits in the cache only while it is open: past the idle time it closes and the
        // file goes (the system alarm is set while open); a new process (the old one killed) wipes what is left.
        val opened = DdnSafe.fetch(ctx, DdnSafe.children(ctx, "root").first())
        r["safeOpenedFileCached"] = opened.length() == bytes.size.toLong() && DdnSafe.alarmSetForTest(ctx)
        DdnSafe.expireForTest()
        r["safeExpiredRefused"] = !DdnSafe.isOpen && runCatching { DdnSafe.children(ctx, "root") }.isFailure
        var closedNow = false
        InstrumentationRegistry.getInstrumentation().runOnMainSync { closedNow = DdnSafe.closeIfIdle(ctx) }
        r["safeIdleWipesOpened"] = closedNow && !opened.exists() && !DdnSafe.alarmSetForTest(ctx)
        val left = java.io.File(ctx.cacheDir, "safe-open").apply { mkdirs() }.resolve("left.txt").apply { writeText("x") }
        DdnSafe.onProcessStart(ctx)
        r["safeNewProcessWipes"] = !left.exists()
        DdnSafe.close(ctx)
    }

    private fun trashAndSettings(sc: InteropScenario, r: LinkedHashMap<String, Boolean>, updatesApi: String?) {
        val s = DdnSession.get(ctx)!!
        s.refresh()
        val folder = s.children("fold-0000000001")
        val video = folder.first { it.name == "film.webm" }
        val big = folder.first { it.name == "duży.bin" }
        r["toTrash"] = s.moveToTrash(listOf(video.id)) == "applied" && s.moveToTrash(listOf(big.id)) == "applied" && s.children("fold-0000000001").none { it.id == video.id || it.id == big.id }
        // K2: Files open on the folder while the trash restores (the list shows it again when back).
        val files = ActivityScenario.launch<DdnActivity>(Intent(ctx, DdnActivity::class.java))
        files.onActivity { a -> a.openFolderForTest("fold-0000000001", "Zdjęcia 1") }
        waitUntil { var ok = false; files.onActivity { a -> ok = a.findRecycler()?.adapter?.itemCount == 1 }; ok }
        ActivityScenario.launch<DdnTrashActivity>(Intent(ctx, DdnTrashActivity::class.java)).use { t ->
            // K1: while it loads, an indicator (not an empty trash).
            var loadingFirst = false
            t.onActivity { a -> loadingFirst = a.openedLoadingForTest() }
            r["trashShowsLoading"] = loadingFirst
            r["trashScreenLists"] = waitUntil { var n = 0; t.onActivity { a -> n = a.countForTest() }; n >= 3 }
            r["trashLoadingGone"] = waitUntil { var on = true; t.onActivity { a -> on = a.loadingShownForTest() }; !on }
            shot("5-trash")
            t.onActivity { a -> a.selectForTest(video.id); a.actForTest(restore = true) }
            r["restoredFromScreen"] = waitUntil { DdnSession.get(ctx)!!.children("fold-0000000001").any { it.id == video.id } }
            t.onActivity { a -> a.selectForTest(big.id); a.actForTest(restore = false) }
            r["purgedFromScreen"] = waitUntil { DdnSession.get(ctx)!!.node(big.id) == null }
            // The replica lists the purged upload as released (e2ee / plain report these to the instance).
            r["purgeReleasesUpload"] = DdnSession.get(ctx)!!.ix { it.released(0) }.isNotEmpty()
        }
        // Back to Files: the restored video is in the list without a refresh by hand.
        r["filesShowRestored"] = waitUntil { var n = -1; files.onActivity { a -> n = a.findRecycler()?.adapter?.itemCount ?: -1 }; n == 2 }
        files.close()
        // The TS device: the same tree (sha of the canonical state after its pull).
        val want = sc.rpc("expect").jsonObject
        s.refresh()
        r["sameStateAsWebAfterTrash"] = s.ix { it.stateSha256() } == want.getValue("sha").jsonPrimitive.content
        // Q4 in the background job: a phone with a purge just made does not clean (the main device does).
        r["autoCleanWaits"] = s.autoCleanTrash(metered = false) == io.github.magiszonekk.discordrive.core.TrashPolicy.Decision.Skip("primary_cleans")

        // Settings and the update check.
        if (updatesApi != null) {
            DdnApp.testUpdatesApi = updatesApi
            ActivityScenario.launch<DdnSettingsActivity>(Intent(ctx, DdnSettingsActivity::class.java)).use { st ->
                r["updateFound"] = waitUntil(30_000) { var ok = false; st.onActivity { a -> ok = a.foundForTest() != null }; ok }
                shot("6-settings-update")
            }
            val b = DdnApp.newer(ctx)
            var last = 0L
            val f = b?.let { DdnApp.download(ctx, it, { d, _ -> last = d }) }
            r["updateDownloadedChecked"] = f != null && f.length() == b.apkSize && io.github.magiszonekk.discordrive.core.AppUpdates.sha256File(f) == b.sha256 && last == f.length()
            // The system installer gets it (a session is created and committed; the confirmation is the user's).
            r["installerSession"] = f != null && runCatching { DdnApp.install(ctx, f); true }.getOrElse { Log.w("ddn-ui", "install: $it"); false } &&
                ctx.packageManager.packageInstaller.mySessions.isNotEmpty()
            Thread.sleep(1500)
            shot("7-installer")
            DdnApp.testUpdatesApi = null
            ctx.packageManager.packageInstaller.mySessions.forEach { runCatching { ctx.packageManager.packageInstaller.abandonSession(it.sessionId) } }
        }

        // Open with → discordrive (VIEW) of a photo another app shares.
        val bmp = Bitmap.createBitmap(800, 600, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.rgb(200, 80, 40)) }
        val pic = File(ctx.cacheDir, "z innej aplikacji.jpg").apply { outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) } }
        val uri = androidx.core.content.FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", pic)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "image/jpeg").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        r["viewResolvesToApp"] = ctx.packageManager.queryIntentActivities(view, 0).any { it.activityInfo.name.endsWith(".DdnOpenActivity") }
        ActivityScenario.launch<DdnOpenActivity>(view.setClass(ctx, DdnOpenActivity::class.java)).use { o ->
            r["viewShowsPhoto"] = waitUntil(15_000) { var ok = false; o.onActivity { a -> ok = a.shownForTest() }; ok }
            shot("8-open-with")
        }
        // K4: a MediaStore URI (as the system gallery passes it): its name and type from MediaStore.
        val values = android.content.ContentValues().apply {
            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, "z galerii systemu.jpg")
            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Pictures")
        }
        val ms = ctx.contentResolver.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
        try {
            ctx.contentResolver.openOutputStream(ms)!!.use { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) }
            ActivityScenario.launch<DdnOpenActivity>(Intent(Intent.ACTION_VIEW).setDataAndType(ms, "*/*").setClass(ctx, DdnOpenActivity::class.java)).use { o ->
                r["mediaStoreViewShows"] = waitUntil(15_000) { var ok = false; o.onActivity { a -> ok = a.shownForTest() }; ok }
                var nm = ""
                o.onActivity { a -> nm = a.nameForTest() }
                r["mediaStoreName"] = nm == "z galerii systemu.jpg"
                Log.i("ddn-ui", "MediaStore view: name '$nm'")
                shot("9-open-with-mediastore")
            }
            // K5: the same file sent before is recognised (the screen asks instead of making "(2)").
            r["sentBeforeAsks"] = !DdnUploads.sentBefore(ctx, ms, "z galerii systemu.jpg") &&
                DdnUploads.markSent(ctx, ms, "z galerii systemu.jpg").let { DdnUploads.sentBefore(ctx, ms, "z galerii systemu.jpg") }
        } finally {
            ctx.contentResolver.delete(ms, null, null)
            ctx.getSharedPreferences("ddn-sent", android.content.Context.MODE_PRIVATE).edit().clear().apply()
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
            // Started in Files (never in the Gallery): a photo's long-press menu offers Move to the Gallery once the
            // first refresh has asked the instance (built on the main thread, as the real menu).
            r["filesMenuHasToGallery"] = waitUntil(30_000) {
                var ok = false
                s.onActivity { a -> ok = a.rowMenuForTest(IndexReplica.Child("x0000001", "IMG.jpg", "file", 1)).contains(a.getString(R.string.ddn_to_gallery)) }
                ok
            }
            // The account has the Gallery space: the Gallery tab shows only it (nothing there yet); the photo
            // folder moved into the Gallery (Move to the Gallery) becomes its album with its 2 media.
            val sess0 = DdnSession.get(ctx)!!
            r["gallerySpace"] = sess0.gallerySpace
            s.onActivity { a -> a.showGalleryForTest() }
            r["galleryEmptyFirst"] = waitUntil { items(s) == 0 }
            r["movedToGallery"] = sess0.move(listOf("fold-0000000001"), sess0.galleryRoot) == "applied" && sess0.children("root").none { it.id == "fold-0000000001" }
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
        viewer(r)
        albums(r)
        // Upload from the phone (PR 4): a file shared into the queue and a photo of the camera folder copied
        // automatically, both through the background job (WorkManager, as in the app); the TS device downloads
        // them and checks the bytes and the thumbnail made on the phone.
        uploads(sc, r)
        trashAndSettings(sc, r, args.getString("ddnUpdates"))
        // Last: the edited copy adds a file to the photo folder (the counts above stay as they were).
        editAndPicker(sc, r)
        failedUpload(sc, r)
        aiDescriptions(sc, r, args.getString("ddnAi"))
        if (args.getString("ddnAi") != null) search(sc, r)
        // Last: the Safe (it moves a file out of Files; nothing after it counts files).
        safe(sc, r)
        Log.i("ddn-ui", "RESULT $r")
        sc.rpc("done", kotlinx.serialization.json.JsonObject(r.mapValues { JsonPrimitive(it.value) }))
        assertTrue("ui checks: $r", r.values.all { it })
    }
}
