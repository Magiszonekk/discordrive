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
        // Items only (the Gallery's day headers are rows of the list too).
        s.onActivity { a -> n = if (a.findRecycler()?.adapter == null) -1 else a.itemCountForTest() }
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
            DdnBackup.db(ctx).drop(failed.first { it.name == "do usunięcia.txt" }.id)
            sc.rpc("hooksOn")
            DdnBackup.db(ctx).retry(failed.first { it.name == "nie dojdzie.txt" }.id)
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
        // The web upload has no EXIF date: the copy takes the original's stored date taken (2024-05-17 10:00 UTC),
        // so it sits next to it in the Gallery instead of under today.
        r["editCopyKeepsTaken"] = copy?.manifestRef?.let { ref -> runCatching { s.files.manifest(ref).second.takenAt }.getOrNull() } == 1715940000000L
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
        // The whole photo held back 2 s: a spinner shows while it comes and goes with the picture.
        DdnViewerActivity.fullDelayForTest = 2_000
        try { ActivityScenario.launch<DdnViewerActivity>(Intent(ctx, DdnViewerActivity::class.java).putExtra("id", photo.id)).use { v ->
            fun <T> on(f: (DdnViewerActivity) -> T): T { var x: T? = null; v.onActivity { a -> x = f(a) }; @Suppress("UNCHECKED_CAST") return x as T }
            // A swipe of 80 % of the width, one page at a time: ten moves a frame apart (not all in one go on the
            // UI thread, which a busy frame, e.g. a video starting, could swallow), then wait until the pager has
            // settled. A swipe the emulator dropped is tried again (at most twice more) and logged.
            fun swipeTo(target: Int): Boolean {
                repeat(3 * list.size) { attempt ->
                    waitUntil(3_000) { on { it.scrollStateForTest() } == androidx.viewpager2.widget.ViewPager2.SCROLL_STATE_IDLE }
                    val from = on { it.pageForTest() }
                    if (from == target) return true
                    val dx = (if (target > from) -1 else 1) * on { it.window.decorView.width } * 0.08f
                    val began = on { it.dragBeginForTest() }
                    if (began) { repeat(10) { on { a -> a.dragByForTest(dx) }; Thread.sleep(16) }; on { it.dragEndForTest() } }
                    waitUntil(3_000) { on { it.scrollStateForTest() } == androidx.viewpager2.widget.ViewPager2.SCROLL_STATE_IDLE }
                    val to = on { it.pageForTest() }
                    if (to != (if (target > from) from + 1 else from - 1)) Log.w("ddn-ui", "viewer swipe $from -> $target, attempt ${attempt + 1}: began $began, now at $to")
                }
                return on { it.pageForTest() } == target
            }
            r["viewerLoading"] = waitUntil(1_800) { on { it.loadingForTest() } }
            // The bar at the start (it hides by itself after ~3 s, which the held-back photo would outlast).
            r["viewerChromeAtStart"] = on { it.chromeShownForTest() }
            val pagerTop = on { it.pagerTopForTest() }
            r["viewerPicture"] = waitUntil { on { it.fullShownForTest() } } && on { it.hasPictureForTest() }
            r["viewerLoadingGone"] = !on { it.loadingForTest() }
            DdnViewerActivity.fullDelayForTest = 0
            r["viewerPages"] = on { it.pagesForTest() == list.size && it.pageForTest() == 0 && it.titleForTest() == photo.name }
            // The top bar: Download, Share, ⋮ (nothing at the bottom any more).
            r["viewerActions"] = on { it.actionsForTest() } == listOf(R.string.ddn_download, R.string.ddn_share, R.string.ddn_more).map { ctx.getString(it) }
            shot("4-viewer")
            // Hides by itself (~3 s without a touch), a tap brings it back.
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
                r["viewerSwipeNext"] = swipeTo(at) && waitUntil(5_000) { on { it.pageForTest() == at && it.titleForTest() == film.name } }
                r["viewerVideoPlays"] = waitUntil(10_000) { on { it.playingForTest() } == film.id }
                r["viewerVideoControlsClear"] = waitUntil(30_000) { on { a -> a.showControlsForTest(); a.controlsClearForTest() } == true }
                r["viewerVideoMenu"] = on { it.menuItems(s, film).map { m -> m.first } }.let { !it.contains(ctx.getString(R.string.ddn_edit)) && !it.contains(ctx.getString(R.string.viewer_set_wallpaper)) && it.contains(ctx.getString(R.string.action_move_to_album)) }
                shot("4b-viewer-video")
                // Back to the photo: the video stops (no player), the photo's page again.
                r["viewerSwipeBack"] = swipeTo(0) && waitUntil(5_000) { on { it.pageForTest() == 0 && it.titleForTest() == photo.name } }
                r["viewerVideoStops"] = waitUntil(5_000) { on { it.playingForTest() } == null }
            }
        } } finally { DdnViewerActivity.fullDelayForTest = 0 }
        // (Each scenario starts a new task: these run after the viewer's.) Show in folder opens the album.
        ActivityScenario.launch<DdnActivity>(folderIntent!!).use { f -> r["viewerShowInFolderOpens"] = waitUntil { items(f) == list.size } }
        // Set as wallpaper: the photo of the account in the cropper (not applied: the device's wallpaper stays).
        ActivityScenario.launch<DdnWallpaperActivity>(Intent(ctx, DdnWallpaperActivity::class.java).putExtra(DdnWallpaperActivity.EXTRA_ID, photo.id)).use { w ->
            r["viewerWallpaperLoads"] = waitUntil { var ok = false; w.onActivity { a -> ok = a.loadedForTest() }; ok }
            shot("4c-wallpaper")
        }
    }

    /**
     * Selection in the Gallery (as in Google Photos): a long press selects and replaces the bar with the count and
     * the actions (the bottom bar goes), a tap on the day selects the whole day, "Hide thumbnails" for all of them
     * at once and back ("Show thumbnails"), Back ends the selection.
     */
    private fun gallerySelection(s: ActivityScenario<DdnActivity>, sess: DdnSession, r: LinkedHashMap<String, Boolean>) {
        // A photo from another device (the web upload, taken 2024-05-17): under its day taken, once its manifest is read.
        r["galleryDayTakenSynced"] = waitUntil(30_000) {
            var days = emptyList<Pair<String, List<String>>>()
            s.onActivity { a -> days = a.daysForTest() }
            days.any { (label, names) -> label.contains("2024") && "Wakacje \u017B.jpg" in names }
        }
        val media = sess.media(10, null).map { it.id }.toSet()
        var heads = emptyList<Int>()
        var first = -1
        s.onActivity { a -> heads = a.headPositionsForTest(); first = a.positionOfItemForTest(0) }
        r["selDayHeaders"] = heads.isNotEmpty() && heads[0] == 0 && first == 1
        s.onActivity { a -> a.longPressForTest(first) }
        var ok = false
        s.onActivity { a -> ok = a.selectingForTest() && a.selectedForTest().size == 1 && a.selectionBarForTest() && a.selectionTitleForTest() == a.getString(R.string.selection_count, 1) }
        r["selLongPressSelects"] = ok
        shot("3d-gallery-selection")
        // A tap on the first day while selecting: the whole day in; every day held: everything in.
        // (A long press on a day starts the selection with that day; a tap on it then takes it out again.)
        var day = emptySet<String>()
        var out = false
        s.onActivity { a -> a.backForTest(); a.selectDayForTest(a.headPositionsForTest()[0]); day = a.selectedForTest() }
        s.onActivity { a -> a.tapDayForTest(a.headPositionsForTest()[0]); out = a.selectedForTest().none { it in day } }
        // The first day as the grid groups it: by the date taken (else added), newest first.
        var firstDay = emptySet<String>()
        s.onActivity { a ->
            val zone = java.time.ZoneId.systemDefault()
            val d = { c: IndexReplica.Child -> java.time.Instant.ofEpochMilli(a.dateOfForTest(c)).atZone(zone).toLocalDate() }
            val m = sess.media(10, null).sortedByDescending { a.dateOfForTest(it) }
            firstDay = m.filter { d(it) == d(m[0]) }.map { it.id }.toSet()
        }
        r["selDayTap"] = day == firstDay && out
        s.onActivity { a -> a.headPositionsForTest().forEach { h -> a.selectDayForTest(h) } }
        var sel = emptySet<String>()
        s.onActivity { a -> sel = a.selectedForTest() }
        r["selDaySelectsAll"] = sel == media
        shot("3e-gallery-day-selected")
        var hideLabel = ""
        s.onActivity { a -> hideLabel = a.getString(R.string.ddn_thumbs_hide); ok = a.selectionMenuForTest(sess.media(10, null)).contains(hideLabel) }
        r["selMenuHideThumbs"] = ok
        s.onActivity { a -> ok = a.runSelectionActionForTest(hideLabel) }
        r["selHideThumbsAll"] = ok && waitUntil { media.all { sess.node(it)?.thumbHidden == true } } && waitUntil { var e = true; s.onActivity { a -> e = !a.selectingForTest() }; e }
        // All hidden: the same menu offers "Show thumbnails"; it shows them on every one.
        // (The list is read again after the action: until then its rows still say "visible".)
        val shown = waitUntil { var done = false; s.onActivity { a -> a.selectAllForTest(); done = a.runSelectionActionForTest(a.getString(R.string.ddn_thumbs_show)) }; done }
        r["selShowThumbsAll"] = shown && waitUntil { media.all { sess.node(it)?.thumbHidden == false } }
        // Back ends the selection (and the bars come back), it does not leave the screen.
        s.onActivity { a -> a.longPressForTest(first) }
        s.onActivity { a -> a.backForTest() }
        s.onActivity { a -> ok = !a.selectingForTest() && !a.selectionBarForTest() && !a.isFinishing }
        r["selBackEnds"] = ok
    }

    /**
     * Selection in Files (as in Files by Google): long press + taps add and remove, a drag after the long press
     * selects the range (and shrinks it when going back), "Select all", Back ends the selection.
     */
    private fun filesSelection(r: LinkedHashMap<String, Boolean>) {
        ActivityScenario.launch<DdnActivity>(Intent(ctx, DdnActivity::class.java)).use { s ->
            waitUntil { items(s) >= 10 }
            var ok = false
            s.onActivity { a -> a.longPressForTest(0); a.tapForTest(1); a.tapForTest(2); a.tapForTest(1) }
            s.onActivity { a -> ok = a.selectedForTest().size == 2 && a.selectionTitleForTest() == a.getString(R.string.selection_count, 2) }
            r["selFilesTaps"] = ok
            s.onActivity { a -> a.backForTest() }
            // Long press on the 4th row, finger down to the 8th: 5 rows; back up to the 5th: 2 rows.
            s.onActivity { a -> a.dragForTest(3, 7); ok = a.selectedForTest().size == 5 }
            var back = false
            s.onActivity { a -> a.dragMoreForTest(4); back = a.selectedForTest().size == 2 }
            r["selFilesDragRange"] = ok && back
            shot("1b-files-selection")
            var all = 0
            var n = 0
            s.onActivity { a -> a.selectAllForTest(); all = a.selectedForTest().size; n = a.itemCountForTest() }
            r["selFilesAll"] = all == n && n >= 10
            // The count on the bar (files only: Share and Download shown too, the narrowest title): whole at the
            // bar's size and at a 1.3 font scale. The photo folder has files only.
            s.onActivity { a -> a.backForTest(); a.openFolderForTest("fold-0000000001", "Zdjęcia 1") }
            var fits = false
            var shown = ""
            waitUntil { var f = emptyList<Int>(); s.onActivity { a -> f = a.filePositionsForTest() }; f.size >= 2 }
            s.onActivity { a -> val f = a.filePositionsForTest(); a.longPressForTest(f[0]); a.tapForTest(f[1]) }
            r["selCountFits"] = waitUntil(5_000) { s.onActivity { a -> fits = a.selectionCountFitsForTest(); shown = a.selectionCountTextForTest() }; fits } && shown == "2"
            shot("1c-files-selection-count")
            s.onActivity { a -> a.backForTest(); ok = !a.selectingForTest() && !a.isFinishing }
            r["selFilesBackEnds"] = ok
        }
    }

    private fun albums(r: LinkedHashMap<String, Boolean>) {
        val s = DdnSession.get(ctx)!!
        val al = s.albums()
        val a = al.firstOrNull { it.id == "fold-0000000001" }
        r["albumListed"] = a != null && a.count == 2 && a.name == "Zdjęcia 1"
        // Nothing right in the Gallery's root yet: no camera album.
        r["noCameraAlbumWhenEmpty"] = s.cameraAlbum(ctx.getString(R.string.ddn_album_camera)) == null
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
     * The camera's photos (the automatic copy puts them right in the Gallery's root, without an album) are the
     * first card of the album list; it opens to exactly them, and has no long-press menu.
     */
    private fun cameraAlbum(r: LinkedHashMap<String, Boolean>) {
        val s = DdnSession.get(ctx)!!
        // The card has the phone's own name of the camera folder (the copy above took "Camera").
        val name = DdnBackup.cameraName(ctx, "?")
        r["cameraAlbumPhoneName"] = name == "Camera"
        val inRoot = s.albumMedia(s.galleryRoot)
        val cam = s.cameraAlbum(name)
        r["cameraAlbumListed"] = inRoot.isNotEmpty() && cam != null && cam.id == s.galleryRoot && cam.count == inRoot.size
        ActivityScenario.launch<DdnActivity>(Intent(ctx, DdnActivity::class.java)).use { sc ->
            sc.onActivity { x -> x.showAlbumsForTest() }
            r["cameraAlbumFirst"] = waitUntil { items(sc) == s.albums().size + 1 }
            shot("11b-albums-camera")
            sc.onActivity { x -> x.openAlbumForTest(s.galleryRoot, name) }
            r["cameraAlbumOpens"] = waitUntil { items(sc) == inRoot.size }
        }
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
        // Thumbnails off (Settings): every result has its name under the type icon (not a grid of equal icons).
        com.discordrive.gallery.Settings.setThumbsOn(ctx, false)
        try {
            ActivityScenario.launch<DdnSearchActivity>(Intent(ctx, DdnSearchActivity::class.java).putExtra(DdnSearchActivity.QUERY, "obraz testowy")).use { a ->
                waitUntil { var ok = false; a.onActivity { x -> ok = x.readyForTest() }; ok }
                r["searchThumbsOffNames"] = waitUntil(10_000) {
                    var names: List<String> = emptyList(); var shown: List<String> = emptyList()
                    a.onActivity { x -> names = x.labelsForTest(); shown = x.resultsForTest() }
                    shown.isNotEmpty() && names.isNotEmpty() && names.all { it in shown }
                }
                shot("15b-search-thumbs-off")
            }
        } finally { com.discordrive.gallery.Settings.setThumbsOn(ctx, true) }
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
        // The question before moving a folder in: how many files and bytes are sent again, and the files of the
        // account's trash inside it (they stay behind and go with the folder). Only asked here, nothing moves.
        val planDir = s.folderPath(listOf("plan-sejfu"))
        val kept = ByteArray(1_234) { 7 }
        s.uploader().upload({ kept.inputStream() }, kept.size.toLong(), "zostaje.txt", planDir)
        val gone = s.uploader().upload({ ByteArray(10).inputStream() }, 10, "w-koszu.txt", planDir)
        s.refresh()
        s.moveToTrash(listOf(gone.nodeId!!))
        val plan = DdnSafe.moveInPlan(ctx, listOf(s.node(planDir)!!))
        val planText = DdnSafeActivity.moveInText(ctx, plan)
        r["safeMovePlanFolder"] = plan == DdnSafe.MovePlan(kept.size.toLong(), 1, 1) &&
            planText.contains(": 1 (") && planText.contains("kosza") && !planText.contains("0 B")
        s.moveToTrash(listOf(planDir)); s.purge(listOf(planDir))
        s.refresh()
        val moved = DdnSafe.moveIn(ctx, listOf(doc))
        r["safeMovedIn"] = moved == 1 && DdnSafe.children(ctx, "root").map { it.name } == listOf("do-sejfu.pdf") && s.children("root").none { it.id == doc.id }
        // A folder whose file is on a channel removed on Discord: the move stops with the file's name in words (no
        // raw 404), the file stays in Files, no empty folder of the move is left in the Safe.
        val deadTop = s.folderPath(listOf("martwy-kanal"))
        val deadIn = s.folderPath(listOf("martwy-kanal", "w-srodku"))
        s.uploader().upload({ ByteArray(5_000) { 3 }.inputStream() }, 5_000, "na-usunietym.bin", deadIn)
        s.refresh()
        val fake = sc.rpc("hooksOff").jsonPrimitive.int >= 0 // real Discord: not here
        val fail = if (fake) try { DdnSafe.moveIn(ctx, listOf(s.node(deadTop)!!)); null } catch (e: Exception) { e } else null
        sc.rpc("hooksOn")
        io.github.magiszonekk.discordrive.core.FileWriter.dead.clear()
        if (fake) {
            val text = fail?.let { DdnSafeActivity.moveInFailText(ctx, it) }.orEmpty()
            Log.i("ddn-ui", "safe move gone: $text")
            s.refresh()
            r["safeMoveGoneInWords"] = fail is DdnSafe.MoveGone && text.contains("na-usunietym.bin") && !text.contains("404") && !text.contains("HTTP")
            r["safeMoveGoneNoEmptyFolder"] = DdnSafe.children(ctx, "root").map { it.name } == listOf("do-sejfu.pdf") &&
                s.children(deadIn).any { it.name == "na-usunietym.bin" }
        }
        s.moveToTrash(listOf(deadTop)); s.purge(listOf(deadTop))
        s.refresh()
        // Messages over Files are shown above the bottom tabs, not over their labels — also when the move started in
        // selection mode (the tabs hidden until it ends): the message's bottom edge at or above the tabs' top edge.
        ActivityScenario.launch<DdnActivity>(Intent(ctx, DdnActivity::class.java)).use { f ->
            waitUntil(10_000) { var n = 0; f.onActivity { a -> n = a.itemCountForTest() }; n > 0 }
            var selecting = false
            f.onActivity { a -> a.longPressForTest(a.positionOfItemForTest(0)); selecting = a.selectingForTest() }
            val gone = DdnSafe.MoveGone("na-usunietym.bin", 0, io.github.magiszonekk.discordrive.core.ServerException(404, "discord"))
            f.onActivity { a -> DdnSafeActivity.moveInDone(a, Result.failure(gone)) { a.endSelectionForTest() } }
            var edges = ""
            r["safeMessageAboveTabs"] = selecting && waitUntil(10_000) {
                var ok = false
                f.onActivity { a ->
                    val nav = a.window.decorView.findViewWithTag<android.view.View>(DdnSafeActivity.NAV_TAG)
                    val msg = a.window.decorView.findViewWithTag<android.widget.TextView>("safe-message")
                    if (nav != null && msg != null && nav.isShown && msg.isShown) {
                        val n = IntArray(2).also { nav.getLocationOnScreen(it) }
                        val m = IntArray(2).also { msg.getLocationOnScreen(it) }
                        edges = "msg bottom ${m[1] + msg.height}, tabs top ${n[1]}"
                        ok = m[1] + msg.height <= n[1]
                    }
                }
                ok
            }
            Log.i("ddn-ui", "safe message vs tabs: selecting $selecting, $edges")
            shot("7b-safe-message-tabs")
        }
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
        // N52: Back inside a folder of the Safe goes one folder up (the Safe stays on screen), from the top it leaves.
        val sub = DdnSafe.mkdir(ctx, "Teczka", "root").nodeId!!
        ActivityScenario.launch<DdnSafeActivity>(Intent(ctx, DdnSafeActivity::class.java)).use { a ->
            waitUntil { var st = ""; a.onActivity { x -> st = x.stateForTest }; st == "open" }
            a.onActivity { x -> x.openFolderForTest(sub, "Teczka") }
            var inSub = ""
            a.onActivity { x -> inSub = x.folderForTest() }
            InstrumentationRegistry.getInstrumentation().runOnMainSync { a.onActivity { x -> x.onBackPressedDispatcher.onBackPressed() } }
            var after = ""
            var finishing = true
            var usage = ""
            a.onActivity { x -> after = x.folderForTest(); finishing = x.isFinishing; usage = x.window.decorView.findViewWithTag<android.widget.TextView>("safe-usage")?.text?.toString().orEmpty() }
            r["safeBackGoesUp"] = inSub == sub && after == "root" && !finishing
            r["safeShowsUsage"] = Regex("\\d+%").containsMatchIn(usage)
            // A Safe older than one this phone has seen (a server rollback) is refused in words, not the raw exception.
            var rollback = ""
            a.onActivity { x -> rollback = x.why(io.github.magiszonekk.discordrive.core.Safe.RollbackException(2, 1)) }
            r["safeRollbackReadable"] = rollback == ctx.getString(R.string.safe_err_rollback) && !rollback.contains("revision")
            // Long messages of the Safe (a damaged Safe, a file gone) are shown whole, not cut after 2 lines.
            a.onActivity { x -> DdnSafeActivity.say(x, x.getString(R.string.safe_err_file_gone)) }
            r["safeMessageWhole"] = waitUntil(5_000) {
                var lines = 0
                a.onActivity { x -> lines = x.window.decorView.findViewWithTag<android.widget.TextView>("safe-message")?.maxLines ?: 0 }
                lines >= DdnSafeActivity.SAY_LINES
            }
        }
        DdnSafe.delete(ctx, listOf(sub))
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

    /**
     * A photo taken in 2019 and sent today (EXIF DateTimeOriginal): the Gallery shows it under its 2019 day, not
     * under today. Selecting in the Gallery and recreating the screen (the system font size changed) keeps the
     * Gallery and the selection.
     */
    private fun galleryExifDay(r: LinkedHashMap<String, Boolean>) {
        val s = DdnSession.get(ctx)!!
        val f = File(ctx.cacheDir, "stare 2019.jpg")
        f.outputStream().use { Bitmap.createBitmap(200, 150, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.RED) }.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        android.media.ExifInterface(f.path).apply { setAttribute(android.media.ExifInterface.TAG_DATETIME_ORIGINAL, "2019:08:15 10:00:00"); saveAttributes() }
        f.setLastModified(System.currentTimeMillis())
        DdnUploads.queue(ctx, listOf(Uri.fromFile(f)), null)
        Thread.sleep(1500)
        val wm = androidx.work.WorkManager.getInstance(ctx)
        waitUntil(120_000) { wm.getWorkInfosForUniqueWork(DdnBackup.WORK_NOW).get().all { it.state.isFinished } }
        s.refresh()
        val node = s.media(500, null).firstOrNull { it.name == "stare 2019.jpg" }
        r["exifUploadedToGallery"] = node != null
        ActivityScenario.launch<DdnActivity>(Intent(ctx, DdnActivity::class.java)).use { sc ->
            sc.onActivity { a -> a.showGalleryForTest() }
            var days = emptyList<Pair<String, List<String>>>()
            r["exifDayHeader2019"] = waitUntil(30_000) {
                sc.onActivity { a -> days = a.daysForTest() }
                days.any { (label, names) -> label.contains("2019") && "stare 2019.jpg" in names }
            }
            Log.i("ddn-ui", "gallery days: $days")
            shot("3f-gallery-exif-2019")
            // Selection survives the screen being recreated (as on a system font size change).
            var first = -1
            sc.onActivity { a -> first = a.positionOfItemForTest(0); a.longPressForTest(first) }
            var before = emptySet<String>()
            sc.onActivity { a -> before = a.selectedForTest() }
            sc.recreate()
            r["selectionKeptOnRecreate"] = before.size == 1 && waitUntil(10_000) {
                var ok = false
                sc.onActivity { a -> ok = a.isGalleryForTest() && a.selectingForTest() && a.selectedForTest() == before && a.selectionBarForTest() }
                ok
            }
            sc.onActivity { a -> a.backForTest() }
        }
        f.delete()
    }

    private fun newerRules(sc: InteropScenario, r: LinkedHashMap<String, Boolean>) {
        sc.rpc("rulesNewer")
        val s = DdnSession.get(ctx)!!
        r["newerRulesRefreshNoThrow"] = runCatching { s.refresh() }.isSuccess
        r["newerRulesSaysUpdate"] = io.github.magiszonekk.discordrive.core.ErrorText.needsUpdate(s.lastError)
        val want = ctx.getString(R.string.ddn_err_update)
        ActivityScenario.launch<DdnActivity>(Intent(ctx, DdnActivity::class.java)).use { a ->
            a.onActivity { x -> x.refreshForTest() }
            r["newerRulesScreen"] = waitUntil {
                var st = ""
                a.onActivity { x -> st = x.statusForTest() }
                st.contains(want) && !st.contains("V8") && !st.contains("QuickJS")
            }
            r["newerRulesStillListed"] = waitUntil { items(a) >= 1 }
            shot("7-newer-rules")
        }
    }

    /**
     * The Gallery shows the phone's own photos next to the account's, each with the state of its copy: a camera
     * photo with the automatic copy off is "only on the phone" (badge, the bar says how many and offers Włącz,
     * the filter "Only on the phone" lists it), "Copy now" on it sends it, then it is one tile with its copy and
     * no badge; the web's photos are "only in the account". The legend shows once.
     */
    private fun galleryBackupState(r: LinkedHashMap<String, Boolean>) {
        val cr = ctx.contentResolver
        val sess = DdnSession.get(ctx)!!
        DdnBackup.set(ctx, on = false)
        ctx.getSharedPreferences("ddn-gallery", android.content.Context.MODE_PRIVATE).edit().clear().apply()
        val name = "PXL_local_${System.currentTimeMillis()}.jpg"
        val values = android.content.ContentValues().apply {
            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "DCIM/Camera")
        }
        val uri = cr.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
        cr.openOutputStream(uri)!!.use { Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.rgb(200, 90, 30)) }.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        val localOnly = sess.media(5000, null).none { it.name == name }
        try {
            ActivityScenario.launch<DdnActivity>(Intent(ctx, DdnActivity::class.java)).use { sc ->
                sc.onActivity { a -> a.showGalleryForTest() }
                fun badges(): Map<String, io.github.magiszonekk.discordrive.core.GalleryBackup.Badge> { var m = emptyMap<String, io.github.magiszonekk.discordrive.core.GalleryBackup.Badge>(); sc.onActivity { a -> m = a.badgesForTest() }; return m }
                r["gbLocalOnlyBadge"] = localOnly && waitUntil { badges()[name] == io.github.magiszonekk.discordrive.core.GalleryBackup.Badge.LOCAL_ONLY }
                // Other devices' photos (the web uploads) and the copy of uploads() (its photo removed from the phone since):
                // only in the account.
                r["gbAccountOnlyBadge"] = badges().filterKeys { it != name }.let { m -> m.isNotEmpty() && m.values.all { it == io.github.magiszonekk.discordrive.core.GalleryBackup.Badge.ACCOUNT_ONLY } }
                var bar: String? = null
                sc.onActivity { a -> bar = a.backupBarForTest() }
                val n = badges().values.count { it == io.github.magiszonekk.discordrive.core.GalleryBackup.Badge.LOCAL_ONLY }
                val want = ctx.plq(R.plurals.ddn_gb_off, n, "$n")
                r["gbBarOff"] = bar == want
                Log.i("ddn-ui", "gallery bar: '$bar' (want '$want'), badges ${badges()}")
                var legend = false
                sc.onActivity { a -> legend = a.legendShownForTest() }
                r["gbLegendOnce"] = legend
                // The badge is drawn on the cell (TalkBack text) when the window is drawn.
                var drawn = emptyMap<String, String?>()
                if (waitUntil(5_000) { var ok = false; sc.onActivity { a -> ok = a.isDrawn() }; ok }) {
                    waitUntil(5_000) { sc.onActivity { a -> drawn = a.drawnBadgesForTest() }; drawn.containsKey(name) }
                    r["gbBadgeDrawn"] = drawn[name] == ctx.getString(R.string.ddn_gb_badge_local)
                }
                shot("3g-gallery-backup-local")
                // Its copy's state is shown where the phone's photo opens (the preview with "Send to discordrive").
                var localId = ""
                sc.onActivity { a -> localId = a.idOfNameForTest(name) ?: "" }
                val line = DdnGalleryState.infoLine(ctx, localId)
                r["gbLocalStateLine"] = line == ctx.getString(R.string.ddn_gb_info_no) && run {
                    val coll = android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    val id = io.github.magiszonekk.discordrive.core.GalleryBackup.mediaIdOf(localId) ?: -1
                    ActivityScenario.launch<DdnOpenActivity>(Intent(Intent.ACTION_VIEW).setClass(ctx, DdnOpenActivity::class.java)
                        .setDataAndType(android.content.ContentUris.withAppendedId(coll, id), "image/*").putExtra(DdnOpenActivity.STATE_LINE, line)).use { o ->
                        var t: String? = null; o.onActivity { a -> t = a.stateLineForTest() }; t == line
                    }
                }
                sc.onActivity { a -> a.setFilterForTest(io.github.magiszonekk.discordrive.core.GalleryBackup.Filter.PHONE_ONLY) }
                r["gbFilterPhoneOnly"] = waitUntil { val m = badges(); name in m && m.values.all { it in io.github.magiszonekk.discordrive.core.GalleryBackup.PHONE_ONLY } }
                shot("3h-gallery-filter-phone")
                // Copy now on the selected photo (it is the only one in the filter).
                var label = ""
                sc.onActivity { a -> label = a.getString(R.string.ddn_gb_copy_now); a.longPressForTest(a.positionOfNameForTest(name)) }
                var ran = false
                sc.onActivity { a -> ran = a.runSelectionActionForTest(label) }
                r["gbCopyNowOffered"] = ran
                val wm = androidx.work.WorkManager.getInstance(ctx)
                Thread.sleep(1500)
                waitUntil(120_000) { wm.getWorkInfosForUniqueWork(DdnBackup.WORK_NOW).get().all { it.state.isFinished } }
                sess.refresh()
                val copy = sess.media(5000, null).firstOrNull { it.name == name }
                r["gbCopyNowUploaded"] = copy != null && copy.parentId == sess.galleryRoot
                sc.onActivity { a -> a.setFilterForTest(io.github.magiszonekk.discordrive.core.GalleryBackup.Filter.ALL) }
                r["gbBothAfterCopy"] = copy != null && waitUntil(30_000) { sc.onActivity { a -> a.showForTest() }; Thread.sleep(500); badges()[name] == io.github.magiszonekk.discordrive.core.GalleryBackup.Badge.BOTH } &&
                    badges().keys.count { it == name } == 1
                shot("3i-gallery-backup-copied")
                if (copy != null) sess.moveToTrash(listOf(copy.id))
            }
        } finally {
            cr.delete(uri, null, null)
            ctx.getSharedPreferences("ddn-gallery", android.content.Context.MODE_PRIVATE).edit().clear().apply()
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
            // Settings -> Thumbnails off (this phone): the same grid shows type icons only; on again: the picture.
            com.discordrive.gallery.Settings.setThumbsOn(ctx, false)
            s.onActivity { a -> a.showForTest() }
            if (drawn) r["thumbsOffNoPicture"] = waitUntil { items(s) == 2 } && run {
                Thread.sleep(1500)
                var pic = true; s.onActivity { a -> pic = a.firstCellHasPicture() }; !pic
            }
            shot("3b-gallery-thumbs-off")
            com.discordrive.gallery.Settings.setThumbsOn(ctx, true)
            s.onActivity { a -> a.showForTest() }
            if (drawn) r["thumbsOnAgain"] = waitUntil { var ok = false; s.onActivity { a -> ok = a.firstCellHasPicture() }; ok }
            // One photo's thumbnail hidden for the account (rules 5, menu "Hide thumbnail"): its cell shows the type
            // icon (the video has no thumbnail, so no cell has a picture); shown again: the picture is back.
            r["thumbHideApplied"] = sess.attrsKnown && sess.setThumbHidden(listOf(photoRow.id), true) == "applied" && sess.node(photoRow.id)?.thumbHidden == true
            s.onActivity { a -> a.showForTest() }
            if (drawn) r["thumbHiddenNoPicture"] = waitUntil { items(s) == 2 } && run {
                Thread.sleep(1500)
                var pic = true; s.onActivity { a -> pic = a.firstCellHasPicture() }; !pic
            }
            shot("3c-gallery-thumb-hidden")
            r["thumbShowApplied"] = sess.setThumbHidden(listOf(photoRow.id), false) == "applied"
            s.onActivity { a -> a.showForTest() }
            if (drawn) r["thumbShownAgain"] = waitUntil { var ok = false; s.onActivity { a -> ok = a.firstCellHasPicture() }; ok }
            Log.i("ddn-ui", "window drawn: $drawn")
            shot("3-gallery")
            gallerySelection(s, sess, r)
        }
        filesSelection(r)
        viewer(r)
        albums(r)
        // Upload from the phone (PR 4): a file shared into the queue and a photo of the camera folder copied
        // automatically, both through the background job (WorkManager, as in the app); the TS device downloads
        // them and checks the bytes and the thumbnail made on the phone.
        uploads(sc, r)
        galleryBackupState(r)
        cameraAlbum(r)
        trashAndSettings(sc, r, args.getString("ddnUpdates"))
        // Last: the edited copy adds a file to the photo folder (the counts above stay as they were).
        editAndPicker(sc, r)
        failedUpload(sc, r)
        aiDescriptions(sc, r, args.getString("ddnAi"))
        if (args.getString("ddnAi") != null) search(sc, r)
        // Last: the Safe (it moves a file out of Files; nothing after it counts files).
        safe(sc, r)
        // After everything: the account gets an entry from a newer app. A refresh must not end the app; the screen
        // asks for an update instead of a raw engine error (the local copy stays as it was).
        galleryExifDay(r)
        newerRules(sc, r)
        Log.i("ddn-ui", "RESULT $r")
        sc.rpc("done", kotlinx.serialization.json.JsonObject(r.mapValues { JsonPrimitive(it.value) }))
        assertTrue("ui checks: $r", r.values.all { it })
    }
}
