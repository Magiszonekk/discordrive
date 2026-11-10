package com.discordrive.gallery

import android.content.ContentValues
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.github.magiszonekk.discordrive.core.IndexReplica
import kotlin.concurrent.thread

/** Actions for several selected files at once (the selection bar of Files, the Gallery and albums). */
object DdnBatch {
    private val main = Handler(Looper.getMainLooper())

    /** Download: each file into Downloads, one after another; a toast when it starts and when it ends. */
    fun download(a: AppCompatActivity, s: DdnSession, items: List<IndexReplica.Child>, onError: (String) -> Unit) {
        val files = items.filter { !it.isFolder && it.manifestRef != null }
        if (files.isEmpty()) return
        Toast.makeText(a, a.plq(R.plurals.ddn_downloading_n, files.size, files.size), Toast.LENGTH_SHORT).show()
        val app = a.applicationContext
        thread {
            var ok = 0
            var err: Throwable? = null
            for (c in files) {
                val r = runCatching { saveToDownloads(app, s, c) }
                r.onSuccess { ok++ }.onFailure { err = it }
            }
            main.post {
                if (ok > 0) Toast.makeText(app, if (files.size == 1) app.getString(R.string.ddn_saved, files[0].name) else app.plq(R.plurals.ddn_saved_n, ok, ok), Toast.LENGTH_LONG).show()
                err?.let { onError(DdnErrors.text(app, it)) }
            }
        }
    }

    private fun saveToDownloads(app: android.content.Context, s: DdnSession, c: IndexReplica.Child) {
        val cr = app.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, c.name)
            put(MediaStore.Downloads.MIME_TYPE, DdnDocumentsProvider.mimeOf(c.name))
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("cannot create the file in Downloads")
        try {
            cr.openOutputStream(uri)!!.use { out -> s.files.download(c.manifestRef!!, c.size ?: 0, c.sha256, out) }
            cr.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            cr.delete(uri, null, null)
            throw e
        }
    }

    /** Share: the files are fetched into the app's cache, then handed to the system's share sheet together. */
    fun share(a: AppCompatActivity, s: DdnSession, items: List<IndexReplica.Child>) {
        val files = items.filter { !it.isFolder && it.manifestRef != null }
        if (files.isEmpty()) return
        Toast.makeText(a, a.plq(R.plurals.ddn_preparing_n, files.size, files.size), Toast.LENGTH_SHORT).show()
        thread {
            val r = runCatching {
                val dir = java.io.File(a.cacheDir, "share").apply { deleteRecursively(); mkdirs() }
                val used = HashSet<String>()
                files.map { c ->
                    // Two files of the same name (different folders) must not overwrite each other in the cache.
                    val clean = c.name.replace('/', '_')
                    val dot = clean.lastIndexOf('.').takeIf { it > 0 } ?: clean.length
                    var name = clean
                    var n = 1
                    while (!used.add(name)) name = clean.substring(0, dot) + " (${n++})" + clean.substring(dot)
                    val f = java.io.File(dir, name)
                    f.outputStream().use { out -> s.files.download(c.manifestRef!!, c.size ?: 0, c.sha256, out) }
                    c to f
                }
            }
            main.post {
                if (a.isFinishing) return@post
                r.onSuccess { got ->
                    val uris = ArrayList(got.map { (_, f) -> androidx.core.content.FileProvider.getUriForFile(a, "${a.packageName}.fileprovider", f) })
                    val types = got.map { (c, _) -> DdnDocumentsProvider.mimeOf(c.name) }.distinct()
                    val type = if (types.size == 1) types[0] else types.map { it.substringBefore('/') }.distinct().singleOrNull()?.let { "$it/*" } ?: "*/*"
                    val send = if (uris.size == 1) Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0]) else Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                    send.setType(type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    // The ClipData gives the share sheet its preview and the read grant for every file.
                    send.clipData = android.content.ClipData.newRawUri(got[0].first.name, uris[0]).also { cd -> uris.drop(1).forEach { cd.addItem(android.content.ClipData.Item(it)) } }
                    a.startActivity(Intent.createChooser(send, a.getString(R.string.ddn_share)))
                }.onFailure { Toast.makeText(a, DdnErrors.text(a, it), Toast.LENGTH_LONG).show() }
            }
        }
    }

    /** Move to an album: the account's albums (minus the ones the items are in already) or a new one. */
    fun pickAlbum(a: AppCompatActivity, s: DdnSession, skip: Set<String>, onPick: (String, String) -> Unit) {
        thread {
            val albums = runCatching { s.albums() }.getOrDefault(emptyList()).filter { skip.size != 1 || it.id !in skip }
            main.post {
                if (a.isFinishing) return@post
                val labels = albums.map { it.name } + (if (s.gallerySpaceKnown) listOf(a.getString(R.string.ddn_new_album)) else emptyList())
                MaterialAlertDialogBuilder(a).setTitle(R.string.action_move_to_album)
                    .setItems(labels.toTypedArray()) { _, i -> if (i < albums.size) onPick(albums[i].id, albums[i].name) else newAlbum(a, s, onPick) }
                    .setNegativeButton(R.string.cobalt_cancel, null).show()
            }
        }
    }

    private fun newAlbum(a: AppCompatActivity, s: DdnSession, onPick: (String, String) -> Unit) {
        val ui = CobaltUi(a)
        val (box, edit) = ui.field(R.string.new_album_hint)
        box.setPadding(ui.dp(20), ui.dp(8), ui.dp(20), 0)
        MaterialAlertDialogBuilder(a).setTitle(R.string.ddn_new_album).setView(box)
            .setPositiveButton(R.string.cobalt_ok) { _, _ ->
                val name = edit.text?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: return@setPositiveButton
                thread {
                    val r = runCatching { s.galleryAlbum(name) }
                    main.post { r.onSuccess { onPick(it, name) }.onFailure { Toast.makeText(a, DdnErrors.text(a, it), Toast.LENGTH_LONG).show() } }
                }
            }
            .setNegativeButton(R.string.cobalt_cancel, null).show()
    }
}
