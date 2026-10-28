package com.discordrive.gallery

import android.content.ContentValues
import android.content.Intent
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
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.github.magiszonekk.discordrive.core.IndexReplica
import kotlin.concurrent.thread

/**
 * The files of the list it was opened from (a folder of the Drive, the Gallery, an album, search results),
 * one per page: swipe left / right for the next / previous one. A photo shows its stored preview at once
 * (the neighbours' too), then the full picture when its page is the current one; a video plays on its page
 * with Media3 reading fragments on demand (a page swiped away stops it). The top bar (back, name, Download,
 * Share, ⋮) hides by itself after a few seconds together with the system bars; a tap brings it back. Under ⋮:
 * Edit (photos), Info, Set as wallpaper (photos), Move to an album / to the Drive / to the Gallery, Move to the
 * Safe, Show in folder, Delete (to the trash, asked first).
 */
class DdnViewerActivity : AppCompatActivity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var pager: ViewPager2
    private lateinit var pages: Pages
    private lateinit var top: LinearLayout
    private lateinit var info: TextView
    private lateinit var count: TextView
    private lateinit var more: View
    private lateinit var icons: List<View>
    private lateinit var progress: com.google.android.material.progressindicator.LinearProgressIndicator
    private lateinit var ui: CobaltUi
    private var items: List<IndexReplica.Child> = emptyList()
    private var player: ExoPlayer? = null
    /** The page whose file is shown in full / playing, and its file (null: none yet). */
    private var active: Pages.H? = null
    private var activeId: String? = null
    /** A page that got its full picture: it goes back to the preview when another page is the current one. */
    private var fullAt = -1
    private var navInset = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        ui = CobaltUi(this)
        items = pending ?: emptyList()
        val id = intent.getStringExtra("id")
        val start = items.indexOfFirst { it.id == id }.coerceAtLeast(0)
        val root = FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) }
        pager = ViewPager2(this).apply { offscreenPageLimit = 1 }
        pages = Pages()
        pager.adapter = pages
        root.addView(pager, FrameLayout.LayoutParams(-1, -1))

        val onScrim = getColor(R.color.cobalt_on_scrim)
        fun icon(res: Int, label: Int, f: (View) -> Unit) = ImageView(this).apply {
            setImageResource(res); setColorFilter(onScrim); contentDescription = getString(label)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            val tv = android.util.TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true); setBackgroundResource(tv.resourceId)
            setOnClickListener { v -> keepChrome(); f(v) }
        }
        info = TextView(this).apply {
            androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); setTextColor(onScrim)
            maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        }
        count = TextView(this).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Meta); setTextColor(onScrim); alpha = 0.8f; maxLines = 1 }
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; addView(info); addView(count) }
        // Top right, as in the phone's gallery: Download, Share, then ⋮ for the rest.
        val download = icon(R.drawable.ic_cobalt_download, R.string.ddn_download) { download() }
        val share = icon(R.drawable.ic_cobalt_share2, R.string.ddn_share) { share() }
        more = icon(R.drawable.ic_cobalt_more, R.string.ddn_more) { v -> showMenu(v) }
        icons = listOf(download, share, more)
        top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundResource(R.drawable.bg_cobalt_scrim_top)
            addView(icon(R.drawable.ic_cobalt_back, R.string.cobalt_back) { finish() }, LinearLayout.LayoutParams(dp(48), dp(48)))
            addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(4) })
            icons.forEach { addView(it, LinearLayout.LayoutParams(dp(48), dp(48))) }
        }
        progress = com.google.android.material.progressindicator.LinearProgressIndicator(this).apply { visibility = View.GONE; max = 1000 }
        root.addView(top, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        root.addView(progress, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        setContentView(root)
        // Under the system bars on every Android version (before 15 the status bar kept the light theme's
        // colour), light icons on the dark photo in both themes. The bars hide with the top bar (a swipe from
        // the edge shows them for a moment); the paddings use the insets whether the bars are shown or not, so
        // nothing moves when they hide.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        // Also into the camera cutout: else the window shrinks below it when the status bar hides (the photo jumps).
        window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
        bars().apply {
            isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, ins ->
            val b = ins.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars())
            top.setPadding(dp(4) + b.left, dp(4) + b.top, dp(4) + b.right, dp(20))
            progress.setPadding(b.left, 0, b.right, b.bottom)
            navInset = b.bottom
            (active?.box?.getChildAt(1) as? PlayerView)?.setPadding(0, 0, 0, navInset)
            ins
        }
        pager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) = activate(position)
        })
        if (items.isEmpty()) return finish()
        pager.setCurrentItem(start, false)
        title(start)
        setChrome(true)
    }

    // ── the top bar: shown, hidden after a few seconds (photos; a video's controls time it themselves) ──

    private var chromeOn = false
    private var menuOpen = false
    private val hide = Runnable { if (!menuOpen && progress.visibility != View.VISIBLE) setChrome(false) }

    private fun bars() = WindowCompat.getInsetsController(window, window.decorView)

    private fun toggleChrome() = setChrome(!chromeOn)

    private fun setChrome(on: Boolean) {
        main.removeCallbacks(hide)
        val pv = playerView()
        if (on != chromeOn) {
            chromeOn = on
            top.animate().cancel()
            if (on) { top.visibility = View.VISIBLE; top.alpha = 0f; top.animate().alpha(1f).setDuration(150).start() }
            else top.animate().alpha(0f).setDuration(150).withEndAction { if (!chromeOn) top.visibility = View.GONE }.start()
            if (on) bars().show(WindowInsetsCompat.Type.systemBars()) else bars().hide(WindowInsetsCompat.Type.systemBars())
            // A video's controls come and go with the bar (and the bar with them: the listener below).
            if (pv != null) { if (on && !pv.isControllerFullyVisible) pv.showController() else if (!on && pv.isControllerFullyVisible) pv.hideController() }
        }
        if (on && pv == null) main.postDelayed(hide, HIDE_MS)
    }

    /** The user touched the bar: it stays the full time again. */
    private fun keepChrome() { if (chromeOn && playerView() == null) { main.removeCallbacks(hide); main.postDelayed(hide, HIDE_MS) } }

    private fun playerView(): PlayerView? = active?.box?.getChildAt(1) as? PlayerView

    // ── pages ──

    private inner class Pages : RecyclerView.Adapter<Pages.H>() {
        inner class H(val box: FrameLayout) : RecyclerView.ViewHolder(box) { var id: String? = null }
        override fun getItemCount() = items.size
        override fun onCreateViewHolder(p: ViewGroup, t: Int) = H(FrameLayout(p.context).apply { layoutParams = ViewGroup.LayoutParams(-1, -1) })
        override fun onBindViewHolder(h: H, position: Int) {
            if (h === active) deactivate()
            bindPage(h, items[position])
            if (position == pager.currentItem) main.post { if (pager.currentItem == position) activate(position) }
        }
        override fun onViewRecycled(h: H) { if (h === active) deactivate() }
    }

    /** A page as a neighbour: the preview of a photo or a video (with a play mark), or a note for other files. */
    private fun bindPage(h: Pages.H, c: IndexReplica.Child) {
        h.id = c.id
        h.box.removeAllViews()
        val s = DdnSession.get(this) ?: return
        val ref = c.manifestRef
        when {
            DdnSession.isImage(c.name) && ref != null -> {
                val img = ZoomableImageView(this)
                img.onSingleTap = { toggleChrome() }
                h.box.addView(img, FrameLayout.LayoutParams(-1, -1))
                DdnThumbs.into(s, ref, img, 1280, 'p') { DdnThumbs.into(s, ref, img, 640, 't') }
            }
            DdnSession.isVideo(c.name) && ref != null -> {
                val img = ImageView(this).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
                h.box.addView(img, FrameLayout.LayoutParams(-1, -1))
                DdnThumbs.into(s, ref, img, 1280, 'p') { DdnThumbs.into(s, ref, img, 640, 't') }
                h.box.addView(ImageView(this).apply { setImageResource(R.drawable.ic_play); alpha = 0.85f; tag = "play" }, FrameLayout.LayoutParams(dp(64), dp(64), Gravity.CENTER))
                h.box.setOnClickListener { toggleChrome() }
            }
            else -> h.box.addView(centerNote(getString(R.string.ddn_no_preview), ui.typeIcon(c.name, false)), FrameLayout.LayoutParams(-1, -1))
        }
    }

    private fun holderAt(position: Int): Pages.H? = (pager.getChildAt(0) as? RecyclerView)?.findViewHolderForAdapterPosition(position) as? Pages.H

    private fun title(position: Int) {
        val c = items.getOrNull(position) ?: return
        info.text = c.name
        val size = Formatter.formatShortFileSize(this, c.size ?: 0)
        count.text = if (items.size > 1) "$size · ${position + 1}/${items.size}" else size
    }

    /** The current page: the full photo, or the video playing (the one before goes back to its preview / stops). */
    private fun activate(position: Int) {
        // ViewPager2 also reports the first page before it scrolls to the one opened: only the current page plays.
        if (position != pager.currentItem) return
        val c = items.getOrNull(position) ?: return
        title(position)
        val h = holderAt(position) ?: return
        if (h === active && activeId == c.id) return
        deactivate()
        if (fullAt >= 0 && fullAt != position && fullAt < items.size) pages.notifyItemChanged(fullAt)
        fullAt = -1
        active = h
        activeId = c.id
        val s = DdnSession.get(this) ?: return
        val ref = c.manifestRef ?: return
        when {
            DdnSession.isVideo(c.name) -> playVideo(s, h, c, ref)
            DdnSession.isImage(c.name) -> {
                val img = h.box.getChildAt(0) as? ZoomableImageView ?: return
                val size = c.size ?: 0
                if (size > 0) thread {
                    // A large photo stays on its preview; its first byte still says whether the file is there.
                    val r = runCatching { if (size <= FULL_IMAGE_MAX) s.files.range(ref, size, 0, size - 1) else s.files.range(ref, size, 0, 0) }
                    val b = r.getOrNull()?.takeIf { size <= FULL_IMAGE_MAX }?.let { DdnThumbs.decode(it, 4096) }
                    main.post {
                        if (active !== h || activeId != c.id) return@post
                        if (b != null) { img.setImageBitmap(b); fullAt = position }
                        else if (r.exceptionOrNull()?.let(::gone) == true) unavailable(h)
                    }
                }
            }
        }
        if (chromeOn) setChrome(true)
    }

    private fun deactivate() {
        val h = active
        player?.release()
        player = null
        if (h != null) {
            (h.box.getChildAt(1) as? PlayerView)?.let { h.box.removeView(it) }
            h.box.findViewWithTag<View>("play")?.visibility = View.VISIBLE
        }
        active = null
        activeId = null
        // The bar no longer follows a video's controls: it times itself again.
        if (chromeOn) { main.removeCallbacks(hide); main.postDelayed(hide, HIDE_MS) }
    }

    /** A file without a preview (or gone): its type icon and a line, centred on the dark page. */
    private fun centerNote(text: CharSequence, icon: Int?): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(dp(32), 0, dp(32), 0)
        if (icon != null) addView(ImageView(this@DdnViewerActivity).apply { setImageResource(icon); setColorFilter(0xFF9C9CA6.toInt()) }, LinearLayout.LayoutParams(dp(56), dp(56)))
        addView(TextView(this@DdnViewerActivity).apply {
            this.text = text; tag = "ddn-viewer-note"
            androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Body); setTextColor(0xFFC4C7CF.toInt()); gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
        setOnClickListener { toggleChrome() }
    }

    private fun playVideo(s: DdnSession, h: Pages.H, c: IndexReplica.Child, ref: String) {
        val view = PlayerView(this).apply {
            // The preview stays visible until the first frame; the controls end above the navigation bar.
            setShutterBackgroundColor(android.graphics.Color.TRANSPARENT)
            controllerShowTimeoutMs = HIDE_MS.toInt()
            setPadding(0, 0, 0, navInset)
        }
        h.box.findViewWithTag<View>("play")?.visibility = View.GONE
        h.box.addView(view, 1, FrameLayout.LayoutParams(-1, -1))
        // A tap on the video shows / hides its controls; the bar follows them.
        view.setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v -> if (active === h) setChrome(v == View.VISIBLE) })
        val p = ExoPlayer.Builder(this).build()
        val source = ProgressiveMediaSource.Factory { DdnDataSource(s, ref, c.size ?: 0) }.createMediaSource(MediaItem.fromUri(Uri.parse("ddn://file/${c.id}")))
        p.setMediaSource(source)
        p.addListener(object : androidx.media3.common.Player.Listener {
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                if (active === h && activeId == c.id && gone(error)) unavailable(h)
            }
        })
        p.prepare()
        p.playWhenReady = true
        view.player = p
        player = p
        if (chromeOn) view.showController() else view.hideController()
    }

    // ── actions ──

    private fun current(): IndexReplica.Child? = items.getOrNull(pager.currentItem)

    private fun download() {
        val s = DdnSession.get(this) ?: return
        val c = current() ?: return
        val ref = c.manifestRef ?: return
        busy(true)
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
                busy(false)
                Toast.makeText(this, r.fold({ getString(R.string.ddn_saved, c.name) }, { getString(R.string.ddn_error, it.message) }), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun busy(on: Boolean) {
        progress.visibility = if (on) View.VISIBLE else View.GONE
        if (on) progress.setProgressCompat(0, false) else keepChrome()
    }

    /** Share: the file is fetched into the app's cache (one at a time), then handed to the system's share sheet. */
    private fun share() {
        val s = DdnSession.get(this) ?: return
        val c = current() ?: return
        val ref = c.manifestRef ?: return
        busy(true)
        thread {
            val r = runCatching {
                val dir = java.io.File(cacheDir, "share").apply { deleteRecursively(); mkdirs() }
                val f = java.io.File(dir, c.name.replace('/', '_'))
                f.outputStream().use { out -> s.files.download(ref, c.size ?: 0, c.sha256, out) { done, total -> main.post { progress.setProgressCompat(if (total > 0) (done * 1000 / total).toInt() else 0, true) } } }
                f
            }
            main.post {
                busy(false)
                r.onSuccess { f ->
                    val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
                    val type = DdnDocumentsProvider.mimeOf(c.name)
                    // The ClipData gives the share sheet its preview (the photo's thumbnail at the top).
                    val send = Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        .also { it.clipData = android.content.ClipData.newRawUri(c.name, uri) }
                    startActivity(Intent.createChooser(send, getString(R.string.ddn_share)))
                }.onFailure { Toast.makeText(this, getString(R.string.ddn_error, it.message), Toast.LENGTH_LONG).show() }
            }
        }
    }

    /** Where a file is: the Gallery or the Drive, and the folders from there down to it (ID, name). */
    private data class Place(val inGallery: Boolean, val folders: List<Pair<String, String>>)

    private fun placeOf(s: DdnSession, c: IndexReplica.Child): Place {
        val chain = ArrayList<Pair<String, String>>()
        var p = c.parentId
        var guard = 0
        while (p != null && p != "root" && p != s.galleryRoot && guard++ < 64) { val n = s.node(p) ?: break; chain += n.id to n.name; p = n.parentId }
        return Place(p == s.galleryRoot, chain.reversed())
    }

    /** The ⋮ entries for a file (off the main thread: where the file is comes from the index). */
    internal fun menuItems(s: DdnSession, c: IndexReplica.Child): List<Pair<String, () -> Unit>> {
        val photo = DdnSession.isImage(c.name)
        val media = photo || DdnSession.isVideo(c.name)
        val place = placeOf(s, c)
        val out = ArrayList<Pair<String, () -> Unit>>()
        if (photo) out += getString(R.string.ddn_edit) to { startActivity(Intent(this, DdnEditActivity::class.java).putExtra(DdnEditActivity.EXTRA_ID, c.id)) }
        out += getString(R.string.ddn_info) to { showInfo(c) }
        if (photo) out += getString(R.string.viewer_set_wallpaper) to { startActivity(Intent(this, DdnWallpaperActivity::class.java).putExtra(DdnWallpaperActivity.EXTRA_ID, c.id)) }
        if (media) out += getString(R.string.action_move_to_album) to { pickAlbum(c) }
        if (s.gallerySpaceKnown) {
            if (place.inGallery) out += getString(R.string.ddn_to_drive) to { DdnPick.driveFolder(this, s) { to -> move(c, to, getString(R.string.ddn_moved_to_drive)) } }
            else if (media) out += getString(R.string.ddn_to_gallery) to { move(c, s.galleryRoot, getString(R.string.ddn_moved_to_gallery)) }
        }
        out += getString(R.string.safe_to_safe) to { DdnSafeActivity.moveIn(this, listOf(c)) { thread { val left = runCatching { s.node(c.id) == null }.getOrDefault(false); main.post { if (left) dropped(c) } } } }
        out += getString(R.string.ddn_show_in_folder) to { showInFolder(c, place) }
        out += getString(R.string.ddn_delete) to { askTrash(c) }
        return out
    }

    private fun showMenu(anchor: View) {
        val s = DdnSession.get(this) ?: return
        val c = current() ?: return
        menuOpen = true
        thread {
            val entries = runCatching { menuItems(s, c) }.getOrElse { listOf(getString(R.string.ddn_error, it.message) to {}) }
            main.post {
                if (isFinishing || current()?.id != c.id) { menuOpen = false; return@post }
                val pm = androidx.appcompat.widget.PopupMenu(this, anchor, Gravity.END)
                entries.forEachIndexed { i, (label, _) -> pm.menu.add(0, i, i, label) }
                pm.setOnMenuItemClickListener { entries[it.itemId].second(); true }
                pm.setOnDismissListener { menuOpen = false; keepChrome() }
                pm.show()
            }
        }
    }

    private fun move(c: IndexReplica.Child, to: String, done: String) {
        val s = DdnSession.get(this) ?: return
        thread {
            val r = runCatching { s.move(listOf(c.id), to) }
            // The file as it is now (its new folder): ⋮, Info and Show in folder follow it.
            val now = runCatching { s.node(c.id) }.getOrNull()
            main.post {
                if (now != null) moved(now)
                r.onSuccess { Toast.makeText(this, moveOutcome(this, it, done), Toast.LENGTH_SHORT).show() }
                    .onFailure { Toast.makeText(this, getString(R.string.ddn_error, it.message), Toast.LENGTH_LONG).show() }
            }
        }
    }

    /** A file of the list changed its place: the list keeps the new node (the page shows the same file). */
    private fun moved(now: IndexReplica.Child) {
        val at = items.indexOfFirst { it.id == now.id }
        if (at < 0) return
        items = items.toMutableList().also { it[at] = now }
        pending = items
    }

    /** Move to an album: the account's albums, or a new one (in the Gallery). */
    private fun pickAlbum(c: IndexReplica.Child) {
        val s = DdnSession.get(this) ?: return
        thread {
            val albums = runCatching { s.albums() }.getOrDefault(emptyList()).filter { it.id != c.parentId }
            main.post {
                val labels = albums.map { it.name } + (if (s.gallerySpaceKnown) listOf(getString(R.string.ddn_new_album)) else emptyList())
                MaterialAlertDialogBuilder(this).setTitle(R.string.action_move_to_album)
                    .setItems(labels.toTypedArray()) { _, i ->
                        if (i < albums.size) move(c, albums[i].id, getString(R.string.ddn_moved_to_album, albums[i].name))
                        else newAlbum(c)
                    }
                    .setNegativeButton(R.string.cobalt_cancel, null).show()
            }
        }
    }

    private fun newAlbum(c: IndexReplica.Child) {
        val s = DdnSession.get(this) ?: return
        val (box, edit) = ui.field(R.string.new_album_hint)
        box.setPadding(ui.dp(20), ui.dp(8), ui.dp(20), 0)
        MaterialAlertDialogBuilder(this).setTitle(R.string.ddn_new_album).setView(box)
            .setPositiveButton(R.string.cobalt_ok) { _, _ ->
                val name = edit.text?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: return@setPositiveButton
                thread {
                    val r = runCatching { s.galleryAlbum(name) }
                    main.post {
                        r.onSuccess { move(c, it, getString(R.string.ddn_moved_to_album, name)) }
                            .onFailure { Toast.makeText(this, getString(R.string.ddn_error, it.message), Toast.LENGTH_LONG).show() }
                    }
                }
            }
            .setNegativeButton(R.string.cobalt_cancel, null).show()
    }

    /** Show in folder: Files at the file's folder, the Gallery, or the album it is in. */
    private fun showInFolder(c: IndexReplica.Child, place: Place) {
        startActivity(folderExtras(Intent(this, DdnActivity::class.java), place))
    }

    private fun folderExtras(i: Intent, place: Place): Intent {
        when {
            place.inGallery && place.folders.isEmpty() -> i.putExtra(DdnActivity.START, "gallery")
            place.inGallery -> i.putExtra(DdnActivity.START, "album").putExtra(DdnActivity.ALBUM_ID, place.folders.last().first).putExtra(DdnActivity.ALBUM_NAME, place.folders.last().second)
            else -> i.putExtra(DdnActivity.START, "files")
                .putStringArrayListExtra(DdnActivity.PATH_IDS, ArrayList(place.folders.map { it.first }))
                .putStringArrayListExtra(DdnActivity.PATH_NAMES, ArrayList(place.folders.map { it.second }))
        }
        return i
    }

    /** Show in folder's screen for a file (tests; off the main thread). */
    internal fun folderIntentForTest(s: DdnSession, c: IndexReplica.Child): Intent = folderExtras(Intent(this, DdnActivity::class.java), placeOf(s, c))

    /** Info: name, type, size, dimensions, when it was taken / added, camera, location (map), where it is, the AI description. */
    private fun showInfo(c: IndexReplica.Child) {
        val s = DdnSession.get(this) ?: return
        thread {
            val meta = runCatching { ViewerInfo.read(s, c) }.getOrNull()
            val lines = runCatching { infoLines(s, c, meta) }.getOrElse { listOf(getString(R.string.ddn_error, it.message)) }
            main.post {
                val d = MaterialAlertDialogBuilder(this).setTitle(c.name).setMessage(lines.joinToString("\n")).setPositiveButton(R.string.cobalt_ok, null)
                val lat = meta?.lat
                val lon = meta?.lon
                if (lat != null && lon != null) d.setNeutralButton(R.string.ddn_info_map) { _, _ -> openMap(lat, lon) }
                d.show()
            }
        }
    }

    private fun openMap(lat: Double, lon: Double) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, ViewerInfo.geoUri(lat, lon))) }
            .onFailure { runCatching { startActivity(Intent(Intent.ACTION_VIEW, ViewerInfo.webMapUri(lat, lon))) } }
    }

    /** The lines of Info; `meta` read from the file itself (null: not read). Off the main thread. */
    internal fun infoLines(s: DdnSession, c: IndexReplica.Child, meta: ViewerInfo.Meta? = null): List<String> {
        val acct = s.acct.accountId
        val db = DdnAi.Db(this)
        val fmt = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT, java.util.Locale("pl"))
        val out = ArrayList<String>()
        out += getString(R.string.viewer_info_name, c.name)
        out += getString(R.string.ddn_info_type, DdnDocumentsProvider.mimeOf(c.name))
        out += getString(R.string.ddn_info_size, Formatter.formatFileSize(this, c.size ?: 0))
        meta?.let { out += ViewerInfo.lines(this, it) }
        // When it was taken: the manifest (set by the uploader), the phone's table, else the picture's EXIF.
        val taken = c.manifestRef?.let { db.taken(acct)[it] } ?: meta?.taken
        taken?.let { out += getString(R.string.ddn_info_taken, fmt.format(java.util.Date(it))) }
        if (c.createdAt > 0) out += getString(R.string.ddn_info_added, fmt.format(java.util.Date(c.createdAt)))
        // Where: the folder chain up to the Drive's root or the Gallery.
        val place = placeOf(s, c)
        val base = getString(if (place.inGallery) R.string.ddn_gallery else R.string.ddn_files)
        out += getString(R.string.ddn_info_where, (listOf(base) + place.folders.map { it.second }).joinToString(" / "))
        c.manifestRef?.let { db.record(acct, it) }?.let { rec ->
            out += ""
            out += getString(R.string.ddn_info_ai, rec.description)
            if (rec.tags.isNotEmpty()) out += getString(R.string.ddn_info_tags, rec.tags.joinToString(", "))
        }
        return out
    }

    /** Delete = to the trash, asked first; the viewer moves on to the next file (or closes when it was the last). */
    private fun askTrash(c: IndexReplica.Child) {
        val s = DdnSession.get(this) ?: return
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.ddn_to_trash)
            .setMessage(getString(R.string.ddn_to_trash_ask, c.name))
            .setPositiveButton(R.string.ddn_to_trash) { _, _ ->
                thread {
                    val r = runCatching { s.moveToTrash(listOf(c.id)) }
                    main.post {
                        r.onSuccess {
                            Toast.makeText(this, if (it == "applied") getString(R.string.ddn_moved_to_trash) else getString(R.string.ddn_trash_not_done, it), Toast.LENGTH_SHORT).show()
                            if (it == "applied") { trashedForTest = c.id; dropped(c) }
                        }.onFailure { Toast.makeText(this, getString(R.string.ddn_error, it.message), Toast.LENGTH_LONG).show() }
                    }
                }
            }
            .setNegativeButton(R.string.cobalt_cancel, null)
            .show()
    }

    /** A file left this list (trash, the Safe): the next one takes its page. */
    private fun dropped(c: IndexReplica.Child) {
        val at = items.indexOfFirst { it.id == c.id }
        if (at < 0) return
        items = items.filter { it.id != c.id }
        pending = items
        if (items.isEmpty()) return finish()
        deactivate()
        fullAt = -1
        pages.notifyItemRemoved(at)
        main.post { activate(pager.currentItem) }
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

    private fun unavailable(h: Pages.H) {
        if (active === h) { player?.release(); player = null }
        h.box.removeAllViews()
        h.box.addView(centerNote(getString(R.string.ddn_file_unavailable), null), FrameLayout.LayoutParams(-1, -1))
    }

    override fun onStop() {
        super.onStop()
        player?.pause()
    }

    override fun onDestroy() {
        main.removeCallbacks(hide)
        player?.release()
        player = null
        super.onDestroy()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    internal fun movedForTest(now: IndexReplica.Child) = moved(now)
    internal fun currentForTest(): IndexReplica.Child? = current()
    internal fun textForTest(): String = active?.box?.findViewWithTag<TextView>("ddn-viewer-note")?.text?.toString()
        ?: holderAt(pager.currentItem)?.box?.findViewWithTag<TextView>("ddn-viewer-note")?.text?.toString() ?: ""
    /** The icons of the top bar (labels), left to right after the name. */
    internal fun actionsForTest(): List<String> = icons.filter { it.visibility == View.VISIBLE }.map { it.contentDescription.toString() }
    internal fun showControlsForTest(): Boolean = playerView()?.let { setChrome(true); it.showController(); true } ?: false
    /** A video's seek bar and time are on screen, below the top bar and above the navigation bar (null: no video / controls yet). */
    internal fun controlsClearForTest(): Boolean? = VideoFit.clear(playerView(), top)
    internal fun hasPictureForTest(): Boolean = (holderAt(pager.currentItem)?.box?.getChildAt(0) as? ImageView)?.drawable is android.graphics.drawable.BitmapDrawable
    internal fun chromeShownForTest(): Boolean = chromeOn && top.visibility == View.VISIBLE
    internal fun tapForTest() = toggleChrome()
    internal fun pagerTopForTest(): Int = IntArray(2).also { pager.getLocationOnScreen(it) }[1]
    internal fun pageForTest(): Int = pager.currentItem
    internal fun pagesForTest(): Int = pages.itemCount
    internal fun titleForTest(): String = info.text.toString()
    internal fun playingForTest(): String? = activeId?.takeIf { player != null }
    /** A finger drag across the pager (the swipe path of a real gesture). `dx` < 0: to the next file. */
    internal fun dragForTest(dx: Float) { pager.beginFakeDrag(); var left = dx; val step = dx / 10; repeat(10) { pager.fakeDragBy(step); left -= step }; pager.endFakeDrag() }
    @Volatile internal var trashedForTest: String? = null

    companion object {
        /** What a move did, in words: "noop" = it was already there (no other device is to blame). */
        fun moveOutcome(c: android.content.Context, outcome: String, done: String): String = when (outcome) {
            "applied" -> done
            "noop" -> c.getString(R.string.ddn_move_noop)
            else -> c.getString(R.string.ddn_trash_not_done, outcome)
        }

        /** The list the viewer was opened from (set by the caller just before starting it). */
        @Volatile var pending: List<IndexReplica.Child>? = null
        /** Whole photos up to this size are shown in full; larger ones stay on the preview. */
        const val FULL_IMAGE_MAX = 40L * 1024 * 1024
        /** The bar hides after this long without a touch (a video's controls use the same). */
        const val HIDE_MS = 3000L
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

/** Test helper: the player's seek bar and position text are laid out, visible, below `top` (when shown) and inside the player's padding. */
internal object VideoFit {
    fun clear(pv: PlayerView?, top: View): Boolean? {
        pv ?: return null
        val seek = pv.findViewById<View>(androidx.media3.ui.R.id.exo_progress) ?: return null
        val pos = pv.findViewById<View>(androidx.media3.ui.R.id.exo_position) ?: return null
        if (!seek.isShown || seek.height == 0) return null
        fun rect(v: View) = IntArray(2).also { v.getLocationOnScreen(it) }.let { android.graphics.Rect(it[0], it[1], it[0] + v.width, it[1] + v.height) }
        val p = rect(pv)
        val floor = p.bottom - pv.paddingBottom
        val ceiling = if (top.isShown) rect(top).bottom else p.top
        return listOf(seek, pos).all { v -> rect(v).let { r -> r.bottom <= floor && r.top >= ceiling } }
    }
}
