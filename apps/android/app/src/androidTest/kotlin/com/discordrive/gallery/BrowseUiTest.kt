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
                Log.i("ddn-ui", "auto-copy picture: short side ${v["thumbW"]}; made here: ${runCatching { DdnPictures.make(ctx.contentResolver, uri).map { "${it.kind} ${it.width}x${it.height} ${it.data.size}" } }.getOrElse { it.toString() }}")
            }
            // A second run copies nothing again.
            DdnBackup.runNow(ctx)
            Thread.sleep(2000)
            waitUntil(60_000) { wm.getWorkInfosForUniqueWork(DdnBackup.WORK_NOW).get().all { it.state.isFinished } }
            sess.refresh()
            r["copiedOnce"] = DdnBackup.status(ctx)?.copied == 0 && cam != null && sess.children(cam.id).count { it.name == name } == 1 &&
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
     * PR 5: the trash (a file to the trash from the list's long press path, the trash screen lists it, restore,
     * delete for good; the TS device sees the same state), Settings (version, a newer build found in the fake
     * releases API, downloaded with its SHA-256 checked, handed to the system installer), Open with (VIEW) of
     * a photo of another app.
     */
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
        albums(r)
        // Upload from the phone (PR 4): a file shared into the queue and a photo of the camera folder copied
        // automatically, both through the background job (WorkManager, as in the app); the TS device downloads
        // them and checks the bytes and the thumbnail made on the phone.
        uploads(sc, r)
        trashAndSettings(sc, r, args.getString("ddnUpdates"))
        // Last: the edited copy adds a file to the photo folder (the counts above stay as they were).
        editAndPicker(sc, r)
        failedUpload(sc, r)
        Log.i("ddn-ui", "RESULT $r")
        sc.rpc("done", kotlinx.serialization.json.JsonObject(r.mapValues { JsonPrimitive(it.value) }))
        assertTrue("ui checks: $r", r.values.all { it })
    }
}
