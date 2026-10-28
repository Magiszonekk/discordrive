package com.discordrive.gallery

import android.content.ContentValues
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.text.format.Formatter
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.MimeTypeMap
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView
import io.github.magiszonekk.discordrive.core.IndexReplica
import kotlin.concurrent.thread

/**
 * One file of the account: a photo shows its stored preview (low resolution) at once, then the full
 * picture; a video plays with Media3 reading fragments on demand (seeking fetches only the fragment it
 * needs); any file can be saved to the phone's Downloads, shared, trashed, its details shown. ‹ / › go
 * between the files of the list it was opened from.
 */
class DdnViewerActivity : AppCompatActivity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var box: FrameLayout
    private lateinit var info: TextView
    private lateinit var count: TextView
    private lateinit var progress: com.google.android.material.progressindicator.LinearProgressIndicator
    private var player: ExoPlayer? = null
    private var items: List<IndexReplica.Child> = emptyList()
    private var index = 0
    private var seq = 0
    private lateinit var actions: LinearLayout
    private lateinit var top: LinearLayout
    private lateinit var ui: CobaltUi

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        ui = CobaltUi(this)
        items = pending ?: emptyList()
        val id = intent.getStringExtra("id")
        index = items.indexOfFirst { it.id == id }.coerceAtLeast(0)
        // The photo fills the screen; the bars float over it on scrims (top: back, name, position, ‹ ›;
        // bottom: Share, Download, Edit, Info, Trash). A tap on the photo hides / shows them.
        val root = FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) }
        box = FrameLayout(this)
        root.addView(box, FrameLayout.LayoutParams(-1, -1))
        val onScrim = getColor(R.color.cobalt_on_scrim)
        fun icon(res: Int, label: Int, f: () -> Unit) = android.widget.ImageView(this).apply {
            setImageResource(res); setColorFilter(onScrim); contentDescription = getString(label)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            val tv = android.util.TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true); setBackgroundResource(tv.resourceId)
            setOnClickListener { f() }
        }
        info = TextView(this).apply {
            androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); setTextColor(onScrim)
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        }
        count = TextView(this).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Meta); setTextColor(onScrim); alpha = 0.8f }
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; addView(info); addView(count) }
        top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundResource(R.drawable.bg_cobalt_scrim_top)
            setPadding(dp(4), dp(4), dp(4), dp(20))
            addView(icon(R.drawable.ic_cobalt_back, R.string.cobalt_back) { finish() }, LinearLayout.LayoutParams(dp(48), dp(48)))
            addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(4) })
            if (items.size > 1) {
                addView(icon(R.drawable.ic_cobalt_chevron, R.string.ddn_prev_label) { go(-1) }.apply { scaleX = -1f }, LinearLayout.LayoutParams(dp(48), dp(48)))
                addView(icon(R.drawable.ic_cobalt_chevron, R.string.ddn_next_label) { go(1) }, LinearLayout.LayoutParams(dp(48), dp(48)))
            }
        }
        progress = com.google.android.material.progressindicator.LinearProgressIndicator(this).apply { visibility = View.GONE; max = 1000 }
        actions = ui.viewerActions(
            Triple(R.string.ddn_share, R.drawable.ic_cobalt_share2) { share() },
            Triple(R.string.ddn_download, R.drawable.ic_cobalt_download) { download() },
            Triple(R.string.ddn_edit, R.drawable.ic_cobalt_edit) { items.getOrNull(index)?.let { startActivity(android.content.Intent(this, DdnEditActivity::class.java).putExtra(DdnEditActivity.EXTRA_ID, it.id)) } },
            Triple(R.string.ddn_info, R.drawable.ic_cobalt_info) { showInfo() },
            Triple(R.string.ddn_trash, R.drawable.ic_cobalt_trash) { askTrash() },
        )
        val bottom = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; addView(progress); addView(actions) }
        root.addView(top, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        root.addView(bottom, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        setContentView(root)
        // Under the system bars on every Android version (before 15 the status bar kept the light theme's
        // colour), light status / navigation icons on the dark photo in both themes.
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        androidx.core.view.WindowCompat.getInsetsController(window, root).apply { isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false }
        bottomBar = bottom
        // A video's controls sit above the bottom bar (they were under it): the player is padded by its height.
        bottom.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fitPlayer() }
        Insets.apply(top, top = true, bottom = false)
        Insets.apply(bottom, top = false, bottom = true)
        chrome = listOf(top, bottom)
        show()
    }

    private var chrome: List<View> = emptyList()
    private lateinit var bottomBar: View
    private fun toggleChrome() = setChrome(chrome.firstOrNull()?.visibility != View.VISIBLE)
    private fun setChrome(on: Boolean) {
        chrome.forEach { it.visibility = if (on) View.VISIBLE else View.GONE }
        fitPlayer()
    }

    /** The player's controls end where the bottom bar starts (none when the bars are hidden). */
    private fun fitPlayer() {
        val pv = box.getChildAt(0) as? PlayerView ?: return
        val pad = if (bottomBar.visibility == View.VISIBLE) bottomBar.height else 0
        if (pv.paddingBottom != pad) pv.setPadding(0, 0, 0, pad)
    }

    private fun go(d: Int) {
        if (items.isEmpty()) return
        index = (index + d).mod(items.size)
        show()
    }

    private fun show() {
        val s = DdnSession.get(this).takeIf { items.isNotEmpty() } ?: return finish()
        val c = items[index]
        val my = ++seq
        releasePlayer()
        box.removeAllViews()
        info.text = c.name
        count.text = if (items.size > 1) "${Formatter.formatShortFileSize(this, c.size ?: 0)} · ${index + 1}/${items.size}" else Formatter.formatShortFileSize(this, c.size ?: 0)
        // Photos only (a video or another file has nothing to crop).
        actions.getChildAt(2).visibility = if (DdnSession.isImage(c.name)) View.VISIBLE else View.GONE
        val ref = c.manifestRef ?: return
        when {
            DdnSession.isVideo(c.name) -> playVideo(s, c, ref)
            DdnSession.isImage(c.name) -> {
                val img = ZoomableImageView(this)
                img.onSingleTap = { toggleChrome() }
                box.addView(img, FrameLayout.LayoutParams(-1, -1))
                // Low resolution first (stored preview, else the thumbnail), then the whole file if it is not too big.
                DdnThumbs.into(s, ref, img, 1280, 'p') { DdnThumbs.into(s, ref, img, 640, 't') }
                val size = c.size ?: 0
                if (size > 0) thread {
                    // A large photo stays on its preview; its first byte still says whether the file is there.
                    val r = runCatching { if (size <= FULL_IMAGE_MAX) s.files.range(ref, size, 0, size - 1) else s.files.range(ref, size, 0, 0) }
                    val b = r.getOrNull()?.takeIf { size <= FULL_IMAGE_MAX }?.let { DdnThumbs.decode(it, 4096) }
                    main.post {
                        if (my != seq) return@post
                        if (b != null) img.setImageBitmap(b)
                        else if (r.exceptionOrNull()?.let(::gone) == true) unavailable()
                    }
                }
            }
            else -> box.addView(centerNote(getString(R.string.ddn_no_preview), ui.typeIcon(c.name, false)), FrameLayout.LayoutParams(-1, -1))
        }
    }

    /** A file without a preview (or gone): its type icon and a line, centred on the dark page. */
    private fun centerNote(text: CharSequence, icon: Int?): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(dp(32), 0, dp(32), 0)
        if (icon != null) addView(android.widget.ImageView(this@DdnViewerActivity).apply { setImageResource(icon); setColorFilter(0xFF9C9CA6.toInt()) }, LinearLayout.LayoutParams(dp(56), dp(56)))
        addView(TextView(this@DdnViewerActivity).apply {
            this.text = text; tag = "ddn-viewer-note"
            androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Body); setTextColor(0xFFC4C7CF.toInt()); gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
        setOnClickListener { toggleChrome() }
    }

    private fun playVideo(s: DdnSession, c: IndexReplica.Child, ref: String) {
        val view = PlayerView(this)
        box.addView(view, FrameLayout.LayoutParams(-1, -1))
        // A tap on the video shows / hides its controls; the bars follow them.
        view.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v -> setChrome(v == View.VISIBLE) })
        fitPlayer()
        val size = c.size ?: 0
        val p = ExoPlayer.Builder(this).build()
        val source = ProgressiveMediaSource.Factory { DdnDataSource(s, ref, size) }.createMediaSource(MediaItem.fromUri(Uri.parse("ddn://file/${c.id}")))
        p.setMediaSource(source)
        val my = seq
        p.addListener(object : androidx.media3.common.Player.Listener {
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                if (my == seq && gone(error)) unavailable()
            }
        })
        p.prepare()
        p.playWhenReady = true
        view.player = p
        player = p
    }

    private fun download() {
        val s = DdnSession.get(this) ?: return
        val c = items.getOrNull(index) ?: return
        val ref = c.manifestRef ?: return
        progress.visibility = View.VISIBLE
        progress.setProgressCompat(0, false)
        thread {
            val r = runCatching {
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(c.name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, c.name)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("cannot create the file in Downloads")
                try {
                    contentResolver.openOutputStream(uri)!!.use { out ->
                        s.files.download(ref, c.size ?: 0, c.sha256, out) { done, total -> main.post { progress.setProgressCompat(if (total > 0) (done * 1000 / total).toInt() else 0, true) } }
                    }
                    contentResolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                } catch (e: Exception) {
                    contentResolver.delete(uri, null, null)
                    throw e
                }
            }
            main.post {
                progress.visibility = View.GONE
                Toast.makeText(this, r.fold({ getString(R.string.ddn_saved, c.name) }, { getString(R.string.ddn_error, it.message) }), Toast.LENGTH_LONG).show()
            }
        }
    }

    /** Share: the file is fetched into the app's cache (one at a time), then handed to the system's share sheet. */
    private fun share() {
        val s = DdnSession.get(this) ?: return
        val c = items.getOrNull(index) ?: return
        val ref = c.manifestRef ?: return
        progress.visibility = View.VISIBLE
        progress.setProgressCompat(0, false)
        thread {
            val r = runCatching {
                val dir = java.io.File(cacheDir, "share").apply { deleteRecursively(); mkdirs() }
                val f = java.io.File(dir, c.name.replace('/', '_'))
                f.outputStream().use { out -> s.files.download(ref, c.size ?: 0, c.sha256, out) { done, total -> main.post { progress.setProgressCompat(if (total > 0) (done * 1000 / total).toInt() else 0, true) } } }
                f
            }
            main.post {
                progress.visibility = View.GONE
                r.onSuccess { f ->
                    val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
                    val type = DdnDocumentsProvider.mimeOf(c.name)
                    val send = android.content.Intent(android.content.Intent.ACTION_SEND).setType(type).putExtra(android.content.Intent.EXTRA_STREAM, uri)
                        .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    startActivity(android.content.Intent.createChooser(send, getString(R.string.ddn_share)))
                }.onFailure { Toast.makeText(this, getString(R.string.ddn_error, it.message), Toast.LENGTH_LONG).show() }
            }
        }
    }

    /** Info: name, type, size, when it was taken / added, where it is, the AI description (if any). */
    private fun showInfo() {
        val s = DdnSession.get(this) ?: return
        val c = items.getOrNull(index) ?: return
        thread {
            val lines = runCatching { infoLines(s, c) }.getOrElse { listOf(getString(R.string.ddn_error, it.message)) }
            main.post {
                com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setTitle(c.name).setMessage(lines.joinToString("\n"))
                    .setPositiveButton(R.string.cobalt_ok, null).show()
            }
        }
    }

    internal fun infoLines(s: DdnSession, c: IndexReplica.Child): List<String> {
        val acct = s.acct.accountId
        val db = DdnAi.Db(this)
        val fmt = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT, java.util.Locale("pl"))
        val out = ArrayList<String>()
        out += getString(R.string.ddn_info_type, DdnDocumentsProvider.mimeOf(c.name))
        out += getString(R.string.ddn_info_size, Formatter.formatFileSize(this, c.size ?: 0))
        c.manifestRef?.let { db.taken(acct)[it] }?.let { out += getString(R.string.ddn_info_taken, fmt.format(java.util.Date(it))) }
        if (c.createdAt > 0) out += getString(R.string.ddn_info_added, fmt.format(java.util.Date(c.createdAt)))
        // Where: the folder chain up to the Drive's root or the Gallery.
        val names = ArrayList<String>()
        var p = c.parentId
        var guard = 0
        while (p != null && p != "root" && p != s.galleryRoot && guard++ < 64) { val n = s.node(p) ?: break; names += n.name; p = n.parentId }
        val base = getString(if (p == s.galleryRoot) R.string.ddn_gallery else R.string.ddn_files)
        out += getString(R.string.ddn_info_where, (listOf(base) + names.reversed()).joinToString(" / "))
        c.manifestRef?.let { db.record(acct, it) }?.let { rec ->
            out += ""
            out += getString(R.string.ddn_info_ai, rec.description)
            if (rec.tags.isNotEmpty()) out += getString(R.string.ddn_info_tags, rec.tags.joinToString(", "))
        }
        return out
    }

    /** Trash, asked first; the viewer moves on to the next file (or closes when it was the last). */
    private fun askTrash() {
        val s = DdnSession.get(this) ?: return
        val c = items.getOrNull(index) ?: return
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(R.string.ddn_to_trash)
            .setMessage(getString(R.string.ddn_to_trash_ask, c.name))
            .setPositiveButton(R.string.ddn_to_trash) { _, _ ->
                thread {
                    val r = runCatching { s.moveToTrash(listOf(c.id)) }
                    main.post {
                        r.onSuccess {
                            Toast.makeText(this, if (it == "applied") getString(R.string.ddn_moved_to_trash) else getString(R.string.ddn_trash_not_done, it), Toast.LENGTH_SHORT).show()
                            if (it == "applied") {
                                items = items.filter { x -> x.id != c.id }
                                pending = items
                                trashedForTest = c.id
                                if (items.isEmpty()) finish() else { index = index.coerceAtMost(items.size - 1); show() }
                            }
                        }.onFailure { Toast.makeText(this, getString(R.string.ddn_error, it.message), Toast.LENGTH_LONG).show() }
                    }
                }
            }
            .setNegativeButton(R.string.cobalt_cancel, null)
            .show()
    }

    /** The file's pieces are on a channel removed on Discord (its webhook answers 401 / 404). */
    private fun gone(e: Throwable): Boolean {
        var x: Throwable? = e
        while (x != null) {
            if (x is io.github.magiszonekk.discordrive.core.ServerException && (x.status == 404 || x.status == 401)) return true
            x = x.cause
        }
        return false
    }

    private fun unavailable() {
        releasePlayer()
        box.removeAllViews()
        box.addView(centerNote(getString(R.string.ddn_file_unavailable), null), FrameLayout.LayoutParams(-1, -1))
    }

    private fun releasePlayer() {
        player?.release()
        player = null
    }

    override fun onStop() {
        super.onStop()
        player?.pause()
    }

    override fun onDestroy() {
        releasePlayer()
        super.onDestroy()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    internal fun textForTest(): String = (box.getChildAt(0)?.findViewWithTag<TextView>("ddn-viewer-note"))?.text?.toString() ?: ""
    internal fun actionsForTest(): List<String> = (0 until actions.childCount).map { actions.getChildAt(it) }.filter { it.visibility == View.VISIBLE }.map { it.contentDescription.toString() }
    internal fun shareForTest() = share()
    internal fun showControlsForTest(): Boolean = (box.getChildAt(0) as? PlayerView)?.let { setChrome(true); it.showController(); true } ?: false
    /** A video's seek bar and time are on screen and not under the bottom bar (null: no video or no controls yet). */
    internal fun controlsClearForTest(): Boolean? = VideoFit.clear(box.getChildAt(0) as? PlayerView, bottomBar)
    @Volatile internal var trashedForTest: String? = null
    internal fun hasPictureForTest(): Boolean = (box.getChildAt(0) as? android.widget.ImageView)?.drawable is android.graphics.drawable.BitmapDrawable

    companion object {
        /** The list the viewer was opened from (set by the caller just before starting it). */
        @Volatile var pending: List<IndexReplica.Child>? = null
        /** Whole photos up to this size are shown in full; larger ones stay on the preview. */
        const val FULL_IMAGE_MAX = 40L * 1024 * 1024
    }
}

/**
 * Media3 reads a discordrive file: each read takes bytes from the current fragment (fetched and decrypted
 * when needed), so playback and seeking fetch only the fragments they touch. One fragment is kept.
 */
class DdnDataSource(private val s: DdnSession, private val ref: String, private val size: Long) : BaseDataSource(true) {
    private var uri: Uri? = null
    private var pos = 0L
    private var left = 0L
    private var frag: ByteArray? = null
    private var fragIndex = -1
    private var chunkSize = 0L

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        transferInitializing(dataSpec)
        chunkSize = s.files.manifest(ref).second.chunkSize
        pos = dataSpec.position
        left = if (dataSpec.length != C.LENGTH_UNSET.toLong()) dataSpec.length else size - pos
        transferStarted(dataSpec)
        return left
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (left <= 0) return C.RESULT_END_OF_INPUT
        val i = (pos / chunkSize).toInt()
        if (i != fragIndex) {
            frag = s.files.fragmentPlain(ref, i)
            fragIndex = i
        }
        val f = frag!!
        val inFrag = (pos - i * chunkSize).toInt()
        val n = minOf(length.toLong(), left, (f.size - inFrag).toLong()).toInt()
        if (n <= 0) return C.RESULT_END_OF_INPUT
        System.arraycopy(f, inFrag, buffer, offset, n)
        pos += n
        left -= n
        bytesTransferred(n)
        return n
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        if (uri != null) {
            uri = null
            transferEnded()
        }
    }
}

/** Test helper: the player's seek bar and position text are laid out, visible and above `bar`. */
internal object VideoFit {
    fun clear(pv: PlayerView?, bar: View): Boolean? {
        pv ?: return null
        val seek = pv.findViewById<View>(androidx.media3.ui.R.id.exo_progress) ?: return null
        val pos = pv.findViewById<View>(androidx.media3.ui.R.id.exo_position) ?: return null
        if (!seek.isShown || seek.height == 0) return null
        fun rect(v: View) = IntArray(2).also { v.getLocationOnScreen(it) }.let { android.graphics.Rect(it[0], it[1], it[0] + v.width, it[1] + v.height) }
        val b = rect(bar)
        return listOf(seek, pos).all { v -> rect(v).let { r -> r.bottom <= b.top && r.top >= 0 } }
    }
}
