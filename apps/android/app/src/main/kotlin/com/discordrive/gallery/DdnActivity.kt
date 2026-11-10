package com.discordrive.gallery

import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.Formatter
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.android.material.bottomnavigation.BottomNavigationView
import io.github.magiszonekk.discordrive.core.IndexReplica
import kotlin.concurrent.thread

/**
 * discordrive on the phone: one activity, two launcher icons (activity-alias): "discordrive" opens Files
 * (folders, as in the web app), "Galeria" opens the Gallery (every photo and video of the account, newest
 * first). Each icon has its own task (taskAffinity), so they are two cards in Recents; the bottom bar
 * switches inside. Data: the account's index in the phone's JS engine (DdnSession), thumbnails stored
 * with the files (DdnThumbs).
 */
open class DdnActivity : AppCompatActivity() {
    private val main = Handler(Looper.getMainLooper())
    private var session: DdnSession? = null
    private lateinit var list: RecyclerView
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var title: TextView
    private lateinit var status: TextView
    private lateinit var nav: BottomNavigationView
    private var gallery = false
    /** The Albums tab; `album` = the open album (folder ID, name) or null for the album list. */
    private var albumsTab = false
    private var album: Pair<String, String>? = null
    /** Folder path in Files (root first). */
    private val path = ArrayList<Pair<String, String>>()

    private lateinit var ui: CobaltUi
    /** Files: the path above the list (breadcrumbs, tap = go there). */
    private lateinit var crumbs: TextView
    /** The normal bar (wordmark / screen name + icons) and the selection bar that replaces it. */
    private lateinit var bar: LinearLayout
    private lateinit var selBar: LinearLayout
    private lateinit var selCount: TextView
    private lateinit var selShare: View
    private lateinit var selDownload: View

    /** What the open list shows: day headers (Gallery, albums) and items, in order. */
    private sealed interface Row {
        data class Head(val key: Long, val label: String) : Row
        data class Item(val c: IndexReplica.Child) : Row
    }
    private var rows: List<Row> = emptyList()

    /**
     * Selection, as in Google Photos / Files by Google: a long press selects and starts it, taps add/remove,
     * a finger moved on after the long press selects the range, the bar shows the count and the actions for all.
     */
    private var selecting = false
    private val selected = LinkedHashSet<String>()
    private lateinit var back: OnBackPressedCallback

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        ui = CobaltUi(this)
        DdnSessionDirs.cacheDir = cacheDir
        gallery = intent.getStringExtra(START) == "gallery" || intent.component?.className?.endsWith(".DdnGallery") == true
        path += "root" to getString(R.string.ddn_files)
        // "Show in folder" from the viewer: Files at a folder (its path from the root) or an album.
        when (intent.getStringExtra(START)) {
            "files" -> {
                val ids = intent.getStringArrayListExtra(PATH_IDS).orEmpty()
                val names = intent.getStringArrayListExtra(PATH_NAMES).orEmpty()
                if (ids.size == names.size) path += ids.zip(names)
            }
            "album" -> intent.getStringExtra(ALBUM_ID)?.let { albumsTab = true; album = it to (intent.getStringExtra(ALBUM_NAME) ?: "") }
        }

        // Cobalt: paper page, a bar with the wordmark (Files) or the screen's name, breadcrumbs in Files, a quiet
        // status line only for what the user must know (offline, empty); the sync state is in Settings → Diagnostics.
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(getColor(R.color.cobalt_paper)) }
        val pad = dp(16)
        title = TextView(this).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_BarTitle); setPadding(pad, dp(14), pad, dp(10)); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        crumbs = TextView(this).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowSub); setPadding(pad, 0, pad, dp(6)); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.START }
        status = TextView(this).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Meta); setPadding(pad, 0, pad, dp(8)) }
        list = RecyclerView(this)
        swipe = SwipeRefreshLayout(this).apply { addView(list); setOnRefreshListener { refresh() } }
        nav = BottomNavigationView(this).apply {
            menu.add(0, 1, 0, R.string.ddn_files).setIcon(R.drawable.ic_cobalt_drive)
            menu.add(0, 2, 1, R.string.ddn_gallery).setIcon(R.drawable.ic_cobalt_gallery)
            menu.add(0, 3, 2, R.string.ddn_albums).setIcon(R.drawable.ic_cobalt_album)
            setBackgroundColor(getColor(R.color.cobalt_paper))
            selectedItemId = if (albumsTab) 3 else if (gallery) 2 else 1
            setOnItemSelectedListener { endSelection(); gallery = it.itemId == 2; albumsTab = it.itemId == 3; album = null; show(); true }
        }
        bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        bar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        fun barIcon(into: LinearLayout, icon: Int, label: Int, onClick: (View) -> Unit): View = ImageView(this).apply {
            setImageResource(icon); setColorFilter(getColor(R.color.cobalt_ink)); contentDescription = getString(label)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            val tv = android.util.TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true); setBackgroundResource(tv.resourceId)
            setOnClickListener { onClick(it) }
        }.also { into.addView(it, LinearLayout.LayoutParams(dp(48), dp(48))) }
        barIcon(bar, R.drawable.ic_cobalt_search, R.string.ddn_search) { startActivity(Intent(this@DdnActivity, DdnSearchActivity::class.java)) }
        // Upload into the open place: the folder (Files), the album, the Gallery.
        barIcon(bar, R.drawable.ic_cobalt_upload, R.string.ddn_upload) { pick.launch(arrayOf("*/*")) }
        barIcon(bar, R.drawable.ic_lock, R.string.safe_title) { DdnSafeActivity.open(this@DdnActivity) }
        barIcon(bar, R.drawable.ic_cobalt_settings, R.string.ddn_settings) { startActivity(Intent(this@DdnActivity, DdnSettingsActivity::class.java)) }
        bar.setPaddingRelative(0, 0, dp(4), 0)
        root.addView(bar)
        // The selection bar (in place of the bar while selecting): close, the count, Share, Download, Trash, ⋮.
        selBar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; visibility = View.GONE; setPaddingRelative(dp(4), 0, dp(4), 0) }
        barIcon(selBar, R.drawable.ic_cobalt_close, R.string.selection_exit) { endSelection() }
        selCount = TextView(this).apply {
            androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_BarTitle); setPadding(dp(8), dp(14), dp(8), dp(10)); maxLines = 1
            // A narrow phone with a large font: the number gets smaller instead of being cut off.
            val max = (textSize / resources.displayMetrics.scaledDensity).toInt().coerceAtLeast(13)
            androidx.core.widget.TextViewCompat.setAutoSizeTextTypeUniformWithConfiguration(this, 12, max, 1, android.util.TypedValue.COMPLEX_UNIT_SP)
        }
        selBar.addView(selCount, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        selShare = barIcon(selBar, R.drawable.ic_cobalt_share2, R.string.ddn_share) { session?.let { s -> DdnBatch.share(this, s, chosen()) } }
        selDownload = barIcon(selBar, R.drawable.ic_cobalt_download, R.string.ddn_download) { session?.let { s -> DdnBatch.download(this, s, chosen()) { note(it) } } }
        barIcon(selBar, R.drawable.ic_cobalt_trash, R.string.ddn_to_trash) { askTrash(chosen()) }
        barIcon(selBar, R.drawable.ic_cobalt_more, R.string.ddn_more) { v -> selectionMenu(v) }
        root.addView(selBar)
        root.addView(crumbs)
        root.addView(status)
        root.addView(swipe, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(nav)
        setContentView(root)
        Insets.apply(root)

        list.addOnItemTouchListener(dragSelect)
        back = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Back while selecting ends the selection; from a folder goes up; from the root of this icon's view
                // it closes only this task.
                if (selecting) endSelection()
                else if (albumsTab && album != null) { album = null; show() }
                else if (!gallery && !albumsTab && path.size > 1) { path.removeAt(path.size - 1); show() } else finish()
            }
        }
        onBackPressedDispatcher.addCallback(this, back)

        status.text = getString(R.string.ddn_opening)
        thread {
            val s = runCatching { DdnSession.get(this) }.getOrElse { e -> main.post { status.text = DdnErrors.text(this, e) }; return@thread }
            main.post {
                if (s == null) {
                    startActivity(Intent(this, JoinActivity::class.java))
                    finish()
                    return@post
                }
                session = s
                show()
                refresh()
                DdnBackup.schedule(this)
                // The automatic copy is on and photos may be read, their position not (access given by an older
                // version or in the system settings): ask once; the group's access grants it without a dialog.
                if (savedInstanceState == null && DdnBackup.enabled(this) && MediaLocation.hasMediaAccess(this) && !DdnBackup.mayCopyMedia(this))
                    gate.ask { if (MediaLocation.granted(this)) { DdnBackup.cancelNeedLocation(this); DdnBackup.runNow(this) } }
                DdnAi.schedule(this)
                DdnApp.schedule(this)
            }
        }
    }

    /** Back from another screen (the trash restored something, a file was sent): the list from the index again. */
    private var started = false
    override fun onStart() {
        super.onStart()
        if (started) show() else started = true
    }

    /** Files picked with "Upload": into the open folder (Files), the open album, or the Gallery (photos; else "Z telefonu"). */
    private val pick = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@registerForActivityResult
        val folder = when {
            albumsTab && album != null && session?.gallerySpaceKnown == true -> album!!.first
            gallery || albumsTab -> null
            else -> path.last().first
        }
        gate.then(uris) { thread {
            val r = runCatching { DdnUploads.queue(this, uris, folder) }
            main.post {
                r.onSuccess { android.widget.Toast.makeText(this, plq(R.plurals.ddn_up_queued, it, it), android.widget.Toast.LENGTH_LONG).show(); watchUploads() }
                    .onFailure { status.text = DdnErrors.text(this, it) }
            }
        } }
    }

    /** Photos picked from the phone keep their GPS position: the permission is asked for before they are read. */
    private val gate = LocationGate(this)

    /** When the upload job ends, the list shows the new files. */
    private fun watchUploads() {
        androidx.work.WorkManager.getInstance(this).getWorkInfosForUniqueWorkLiveData(DdnBackup.WORK_NOW).observe(this) { l ->
            if (l.any { it.state.isFinished }) refresh()
        }
    }

    private var refreshing = false
    private fun refresh() {
        val s = session ?: return
        if (refreshing) return
        refreshing = true
        swipe.isRefreshing = true
        thread {
            // A failure is in s.lastError (shown by show()); never let it end the app.
            runCatching { s.refresh() }.onFailure { if (s.lastError == null) s.lastError = it.message }
            main.post {
                refreshing = false
                swipe.isRefreshing = false
                show()
            }
        }
    }

    /** Settings -> Thumbnails (read again on every show: back from Settings the lists follow it). */
    private var thumbsOn = true

    private fun show() {
        val s = session ?: return
        thumbsOn = com.discordrive.gallery.Settings.thumbsOn(this)
        title.text = when {
            albumsTab -> album?.second ?: getString(R.string.ddn_albums)
            gallery -> getString(R.string.ddn_gallery)
            path.size == 1 -> ui.brand()
            else -> path.last().second
        }
        // Files below the root: the path, each part a step back (tap = up to it).
        crumbs.visibility = if (!gallery && !albumsTab && path.size > 1) View.VISIBLE else View.GONE
        crumbs.text = path.dropLast(1).joinToString(" › ") { it.second }
        crumbs.setOnClickListener { if (path.size > 1) { endSelection(); path.removeAt(path.size - 1); show() } }
        status.text = s.lastError?.let { if (io.github.magiszonekk.discordrive.core.ErrorText.needsUpdate(it)) getString(R.string.ddn_err_update) else getString(R.string.ddn_offline, DdnErrors.bare(this, it)) } ?: ""
        status.visibility = if (status.text.isEmpty()) View.GONE else View.VISIBLE
        thread {
            if (albumsTab) {
                val open = album
                if (open != null) {
                    val items = s.albumMedia(open.first)
                    main.post { if (albumsTab && album == open) showGrid(s, items) }
                } else {
                    val albums = listOfNotNull(s.cameraAlbum(DdnBackup.cameraName(this, getString(R.string.ddn_album_camera)))) + s.albums()
                    main.post { if (albumsTab && album == null) showAlbums(s, albums) }
                }
            } else if (gallery) {
                val items = s.media(5000, null, DdnPrivate.all(this))
                main.post { if (gallery) showGrid(s, items) }
            } else {
                val folder = path.last().first
                val items = s.children(folder)
                main.post { if (!gallery && !albumsTab && path.last().first == folder) showList(s, items) }
            }
        }
    }

    /** Items of the open list (headers left out). */
    private fun itemsNow(): List<IndexReplica.Child> = rows.mapNotNull { (it as? Row.Item)?.c }

    /** The list changed under a selection (refresh, an action): what is gone is no longer selected. */
    private fun keepSelection() {
        if (!selecting) return
        val ids = itemsNow().mapTo(HashSet()) { it.id }
        selected.retainAll(ids)
        if (selected.isEmpty()) endSelection() else selectionUi()
    }

    private fun showList(s: DdnSession, items: List<IndexReplica.Child>) {
        rows = items.map { Row.Item(it) }
        keepSelection()
        list.layoutManager = LinearLayoutManager(this)
        list.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount() = rows.size
            override fun onCreateViewHolder(p: ViewGroup, t: Int): RecyclerView.ViewHolder {
                val r = ui.listRow()
                r.view.setPaddingRelative(dp(12), dp(8), dp(8), dp(8))
                // Folders: a chevron at the end (files open the viewer).
                r.view.addView(ImageView(this@DdnActivity).apply { setImageResource(R.drawable.ic_cobalt_chevron); setColorFilter(getColor(R.color.cobalt_muted)) }, LinearLayout.LayoutParams(dp(18), dp(18)))
                r.view.tag = r
                return object : RecyclerView.ViewHolder(r.view) {}
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int, payloads: MutableList<Any>) {
                // Only the selection changed: a row whose state is the same keeps its thumbnail (no reload, no flicker).
                val c = (rows[i] as Row.Item).c
                val r = h.itemView.tag as CobaltUi.ListRow
                if (payloads.isNotEmpty() && r.view.isSelected == (selecting && c.id in selected)) {
                    r.view.getChildAt(r.view.childCount - 1).visibility = if (c.isFolder && !selecting) View.VISIBLE else View.GONE
                    return
                }
                onBindViewHolder(h, i)
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
                val c = (rows[i] as Row.Item).c
                val r = h.itemView.tag as CobaltUi.ListRow
                val on = selecting && c.id in selected
                r.title.text = c.name
                r.sub.text = if (c.isFolder) getString(R.string.ddn_folder) else listOfNotNull(Formatter.formatShortFileSize(this@DdnActivity, c.size ?: 0), c.createdAt.takeIf { it > 0 }?.let { Ago.of(this@DdnActivity, it) }).joinToString(" · ")
                r.view.getChildAt(r.view.childCount - 1).visibility = if (c.isFolder && !selecting) View.VISIBLE else View.GONE
                // Selected (Files by Google): the row in the accent's soft tone, a check in place of the icon.
                if (on) r.view.setBackgroundColor(getColor(R.color.cobalt_accent_soft)) else {
                    val tv = android.util.TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true); r.view.setBackgroundResource(tv.resourceId)
                }
                r.view.isSelected = on
                val type = ui.typeIcon(c.name, c.isFolder)
                r.icon.tag = null
                r.icon.backgroundTintList = null
                if (on) {
                    ui.thumb(r, null, R.drawable.ic_cobalt_check)
                    r.icon.backgroundTintList = android.content.res.ColorStateList.valueOf(getColor(R.color.cobalt_accent))
                    r.icon.setColorFilter(Color.WHITE)
                } else {
                    ui.thumb(r, null, type)
                    ui.folderTile(r, c.isFolder)
                    if (thumbsOn && !c.thumbHidden && !c.isFolder && (DdnSession.isImage(c.name) || DdnSession.isVideo(c.name)) && c.manifestRef != null) {
                        r.icon.tag = c.manifestRef
                        val ref = c.manifestRef
                        DdnThumbs.pool.execute {
                            val b = runCatching { DdnThumbs.load(s, ref!!, 't', dp(88)) }.getOrNull()
                            main.post { if (r.icon.tag == ref && b != null) ui.thumb(r, b, type) }
                        }
                    }
                }
                r.view.setOnClickListener {
                    val at = h.bindingAdapterPosition
                    if (selecting) toggle(at)
                    else if (c.isFolder) { path += c.id to c.name; show() } else open(c, itemsNow().filter { !it.isFolder })
                }
                r.view.setOnLongClickListener { startSelection(h.bindingAdapterPosition); true }
            }
        }
        if (items.isEmpty()) note(getString(R.string.ddn_empty))
    }

    /** Day headers over a newest-first list of media (Gallery, an album), as in the phone's gallery. */
    private fun withDays(items: List<IndexReplica.Child>): List<Row> {
        val zone = java.time.ZoneId.systemDefault()
        val today = java.time.LocalDate.now(zone)
        val out = ArrayList<Row>(items.size + 16)
        var last: Long? = null
        for (c in items) {
            val day = if (c.createdAt > 0) java.time.Instant.ofEpochMilli(c.createdAt).atZone(zone).toLocalDate() else null
            val key = day?.toEpochDay() ?: Long.MIN_VALUE
            if (key != last) {
                val label = when (day) {
                    null -> getString(R.string.ddn_no_date)
                    today -> getString(R.string.date_today)
                    today.minusDays(1) -> getString(R.string.date_yesterday)
                    else -> java.time.format.DateTimeFormatter.ofPattern(if (day.year == today.year) "EEEE, d MMMM" else "d MMMM yyyy", java.util.Locale.getDefault()).format(day).replaceFirstChar { it.uppercase() }
                }
                out += Row.Head(key, label)
                last = key
            }
            out += Row.Item(c)
        }
        return out
    }

    /** The items under a day header (up to the next one). */
    private fun dayItems(headAt: Int): List<Int> {
        val out = ArrayList<Int>()
        var i = headAt + 1
        while (i < rows.size && rows[i] is Row.Item) out += i++
        return out
    }

    private fun showGrid(s: DdnSession, items: List<IndexReplica.Child>) {
        rows = withDays(items)
        keepSelection()
        val cols = maxOf(3, resources.displayMetrics.widthPixels / dp(120))
        val cell = resources.displayMetrics.widthPixels / cols
        list.layoutManager = GridLayoutManager(this, cols).apply {
            spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() { override fun getSpanSize(position: Int) = if (rows.getOrNull(position) is Row.Head) cols else 1 }
        }
        list.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount() = rows.size
            override fun getItemViewType(position: Int) = if (rows[position] is Row.Head) 1 else 0
            override fun onCreateViewHolder(p: ViewGroup, t: Int): RecyclerView.ViewHolder {
                if (t == 1) {
                    // A day: its date and, while selecting, a circle that selects the whole day.
                    val v = LinearLayout(this@DdnActivity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPaddingRelative(dp(12), dp(18), dp(8), dp(8)); layoutParams = ViewGroup.LayoutParams(-1, -2) }
                    v.addView(ImageView(this@DdnActivity).apply { setImageResource(R.drawable.ic_circle_outline); setColorFilter(getColor(R.color.cobalt_muted)) }, LinearLayout.LayoutParams(dp(22), dp(22)).apply { marginEnd = dp(10) })
                    v.addView(TextView(this@DdnActivity).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }, LinearLayout.LayoutParams(0, -2, 1f))
                    return object : RecyclerView.ViewHolder(v) {}
                }
                val f = FrameLayout(this@DdnActivity).apply { layoutParams = ViewGroup.LayoutParams(cell, cell); setPadding(1, 1, 1, 1) }
                f.addView(ImageView(this@DdnActivity).apply { scaleType = ImageView.ScaleType.CENTER_CROP; setBackgroundColor(getColor(R.color.cobalt_tile)) }, FrameLayout.LayoutParams(-1, -1))
                f.addView(ImageView(this@DdnActivity).apply { setImageResource(R.drawable.ic_cobalt_film); setColorFilter(Color.WHITE); elevation = dp(2).toFloat() }, FrameLayout.LayoutParams(dp(22), dp(22), Gravity.TOP or Gravity.END).apply { setMargins(0, dp(6), dp(6), 0) })
                f.addView(ImageView(this@DdnActivity).apply { elevation = dp(2).toFloat() }, FrameLayout.LayoutParams(dp(22), dp(22), Gravity.TOP or Gravity.START).apply { setMargins(dp(6), dp(6), 0, 0) })
                return object : RecyclerView.ViewHolder(f) {}
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int, payloads: MutableList<Any>) {
                // Only the selection changed: the cell keeps its picture.
                val row = rows[i]
                if (payloads.isNotEmpty() && row is Row.Item) cellSelection(h.itemView as FrameLayout, row.c) else onBindViewHolder(h, i)
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
                val row = rows[i]
                if (row is Row.Head) {
                    val v = h.itemView as LinearLayout
                    val all = selecting && dayItems(i).all { (rows[it] as Row.Item).c.id in selected }
                    (v.getChildAt(0) as ImageView).apply {
                        visibility = if (selecting) View.VISIBLE else View.GONE
                        setImageResource(if (all) R.drawable.ic_check_circle else R.drawable.ic_circle_outline)
                        if (all) clearColorFilter() else setColorFilter(getColor(R.color.cobalt_muted))
                    }
                    (v.getChildAt(1) as TextView).text = row.label
                    v.contentDescription = row.label
                    v.setOnClickListener { if (selecting) toggleDay(h.bindingAdapterPosition) }
                    v.setOnLongClickListener { selectDay(h.bindingAdapterPosition); true }
                    return
                }
                val c = (row as Row.Item).c
                val f = h.itemView as FrameLayout
                val img = f.getChildAt(0) as ImageView
                f.getChildAt(1).visibility = if (DdnSession.isVideo(c.name)) View.VISIBLE else View.GONE
                cellSelection(f, c)
                img.setImageDrawable(null)
                img.contentDescription = c.name
                img.clearColorFilter()
                img.scaleType = ImageView.ScaleType.CENTER_CROP
                fun typeIcon() { img.setImageResource(R.drawable.ic_cobalt_image); img.setColorFilter(getColor(R.color.cobalt_muted)); img.scaleType = ImageView.ScaleType.CENTER_INSIDE }
                // Thumbnails off (Settings) or hidden for this file (account): the type icon, nothing fetched (tag
                // cleared: a late load of a recycled cell is dropped).
                if (thumbsOn && !c.thumbHidden) DdnThumbs.into(s, c.manifestRef, img, cell) { typeIcon() } else { img.tag = null; typeIcon() }
                f.setOnClickListener { if (selecting) toggle(h.bindingAdapterPosition) else open(c, itemsNow()) }
                f.setOnLongClickListener { startSelection(h.bindingAdapterPosition); true }
            }
        }
        if (items.isEmpty()) note(getString(if (gallery && DdnPrivate.all(this).isNotEmpty()) R.string.ddn_gallery_empty_private else R.string.ddn_gallery_empty))
    }

    // ── selection ──

    /** Selected (Google Photos): the picture shrinks over the accent's soft tone, a check at the top left. */
    private fun cellSelection(f: FrameLayout, c: IndexReplica.Child) {
        val on = selecting && c.id in selected
        val img = f.getChildAt(0) as ImageView
        (f.getChildAt(2) as ImageView).apply {
            visibility = if (selecting) View.VISIBLE else View.GONE
            setImageResource(if (on) R.drawable.ic_check_circle else R.drawable.ic_circle_outline)
        }
        f.setBackgroundColor(if (on) getColor(R.color.cobalt_accent_soft) else 0)
        img.scaleX = if (on) 0.84f else 1f
        img.scaleY = if (on) 0.84f else 1f
        f.isSelected = on
    }

    private fun idAt(position: Int): String? = (rows.getOrNull(position) as? Row.Item)?.c?.id

    /** Long press on an item: selection starts with it (or it is added), and a drag from here selects the range. */
    private fun startSelection(position: Int) {
        val id = idAt(position) ?: return
        if (!selecting) { selecting = true; selected.clear() }
        selected += id
        dragFrom = position
        dragBase = selected.toSet()
        dragging = true
        list.parent?.requestDisallowInterceptTouchEvent(true)
        list.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
        selectionUi()
    }

    private fun toggle(position: Int) {
        val id = idAt(position) ?: return
        if (!selected.add(id)) selected.remove(id)
        if (selected.isEmpty()) endSelection() else selectionUi()
    }

    /** Tap on a day while selecting: the whole day in (or out, when it was all in). */
    private fun toggleDay(headAt: Int) {
        val ids = dayItems(headAt).mapNotNull { idAt(it) }
        if (ids.isEmpty()) return
        if (ids.all { it in selected }) selected.removeAll(ids.toSet()) else selected.addAll(ids)
        if (selected.isEmpty()) endSelection() else selectionUi()
    }

    /** Long press on a day: selection starts with that whole day. */
    private fun selectDay(headAt: Int) {
        val ids = dayItems(headAt).mapNotNull { idAt(it) }
        if (ids.isEmpty()) return
        if (!selecting) { selecting = true; selected.clear() }
        selected.addAll(ids)
        selectionUi()
    }

    private fun selectAll() {
        selecting = true
        itemsNow().forEach { selected += it.id }
        selectionUi()
    }

    private fun endSelection() {
        if (!selecting && selected.isEmpty()) return
        selecting = false
        dragging = false
        selected.clear()
        selectionUi()
    }

    /** The selected items, in list order. */
    private fun chosen(): List<IndexReplica.Child> = itemsNow().filter { it.id in selected }

    /** Bars and cells follow the selection (no new adapter: the list keeps its scroll position). */
    private fun selectionUi() {
        bar.visibility = if (selecting) View.GONE else View.VISIBLE
        selBar.visibility = if (selecting) View.VISIBLE else View.GONE
        crumbs.visibility = if (!selecting && !gallery && !albumsTab && path.size > 1) View.VISIBLE else View.GONE
        nav.visibility = if (selecting) View.GONE else View.VISIBLE
        swipe.isEnabled = !selecting
        // The number alone, as in Google Photos ("Zaznaczono: 22" did not fit next to four icons); the full
        // phrase for TalkBack.
        selCount.text = selected.size.toString()
        selCount.contentDescription = getString(R.string.selection_count, selected.size)
        // Download / Share are for files (a folder is not sent as one file).
        val files = chosen().none { it.isFolder }
        selShare.visibility = if (files) View.VISIBLE else View.GONE
        selDownload.visibility = if (files) View.VISIBLE else View.GONE
        list.adapter?.notifyItemRangeChanged(0, rows.size, SELECTION)
    }

    // A finger moved on after the long press selects the range from the first item to the one under it (back
    // over the first: the range shrinks again); near the top or bottom edge the list scrolls along.
    private var dragging = false
    private var dragFrom = -1
    private var dragBase: Set<String> = emptySet()
    private var dragY = 0f
    private val autoScroll = object : Runnable {
        override fun run() {
            if (!dragging) return
            val edge = dp(72)
            val dy = when { dragY < edge -> -dp(14); dragY > list.height - edge -> dp(14); else -> 0 }
            if (dy != 0) { list.scrollBy(0, dy); dragAt(list.width / 2f, dragY) }
            main.postDelayed(this, 16)
        }
    }

    private fun dragAt(x: Float, y: Float) {
        val v = list.findChildViewUnder(x, y.coerceIn(0f, list.height - 1f)) ?: return
        val to = list.getChildAdapterPosition(v)
        if (to != RecyclerView.NO_POSITION) dragTo(to)
    }

    /** The drag reached `to`: the selection is what it was at the long press plus the items from there to here. */
    private fun dragTo(to: Int) {
        if (dragFrom < 0) return
        val range = (minOf(dragFrom, to)..maxOf(dragFrom, to)).mapNotNull { idAt(it) }
        val next = LinkedHashSet(dragBase).apply { addAll(range) }
        if (next == selected) return
        selected.clear(); selected.addAll(next)
        selectionUi()
    }

    private val dragSelect = object : RecyclerView.OnItemTouchListener {
        override fun onInterceptTouchEvent(rv: RecyclerView, e: android.view.MotionEvent): Boolean {
            if (!dragging) return false
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_MOVE -> { dragY = e.y; main.removeCallbacks(autoScroll); main.post(autoScroll); return true }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> { dragging = false; main.removeCallbacks(autoScroll) }
            }
            return false
        }
        override fun onTouchEvent(rv: RecyclerView, e: android.view.MotionEvent) {
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_MOVE -> { dragY = e.y; dragAt(e.x, e.y) }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> { dragging = false; main.removeCallbacks(autoScroll) }
            }
        }
        override fun onRequestDisallowInterceptTouchEvent(disallowIntercept: Boolean) {}
    }

    /** ⋮ of the selection bar: the actions for every selected item. */
    private fun selectionMenu(anchor: View) {
        val s = session ?: return
        val entries = selectionItems(s, chosen(), gallery || albumsTab)
        val pm = androidx.appcompat.widget.PopupMenu(this, anchor, Gravity.END)
        entries.forEachIndexed { i, (label, _) -> pm.menu.add(0, i, i, label) }
        pm.setOnMenuItemClickListener { entries[it.itemId].second(); true }
        pm.show()
    }

    /** The actions for the selected items. The main thread: what refresh() learned about the instance (no network here). */
    private fun selectionItems(s: DdnSession, cs: List<IndexReplica.Child>, inGallery: Boolean): List<Pair<String, () -> Unit>> {
        val items = ArrayList<Pair<String, () -> Unit>>()
        if (cs.isEmpty()) return items
        val media = cs.filter { !it.isFolder && (DdnSession.isImage(it.name) || DdnSession.isVideo(it.name)) }
        val allMedia = media.size == cs.size
        if (itemsNow().any { it.id !in selected }) items += getString(R.string.ddn_select_all) to { selectAll() }
        if (allMedia) items += getString(R.string.action_move_to_album) to { DdnBatch.pickAlbum(this, s, cs.mapNotNullTo(HashSet()) { it.parentId }) { id, name -> move(cs, id, getString(R.string.ddn_moved_to_album, name)) } }
        if (!inGallery) items += getString(R.string.ddn_move_to) to { DdnPick.driveFolder(this, s) { to -> move(cs, to, getString(R.string.ddn_moved)) } }
        if (s.gallerySpaceKnown) {
            if (inGallery) items += getString(R.string.ddn_to_drive) to { DdnPick.driveFolder(this, s) { to -> move(cs, to, getString(R.string.ddn_moved_to_drive)) } }
            else if (cs.all { it.isFolder || DdnSession.isImage(it.name) || DdnSession.isVideo(it.name) }) items += getString(R.string.ddn_to_gallery) to { move(cs, s.galleryRoot, getString(R.string.ddn_moved_to_gallery)) }
        }
        if (s.attrsKnown && media.isNotEmpty()) {
            // Mixed: hide the visible ones (as on the web); all hidden already: show them.
            val hide = media.any { !it.thumbHidden }
            val which = media.filter { it.thumbHidden != hide }
            val label = if (media.size == 1) getString(if (hide) R.string.ddn_thumb_hide else R.string.ddn_thumb_show) else getString(if (hide) R.string.ddn_thumbs_hide else R.string.ddn_thumbs_show)
            items += label to { setThumbHidden(which, hide) }
        }
        items += getString(R.string.safe_to_safe) to { DdnSafeActivity.moveIn(this, cs) { endSelection(); show() } }
        items += getString(R.string.ddn_to_trash) to { askTrash(cs) }
        return items
    }

    /**
     * The albums: a cover (the newest photo) with the name and count; a private one shows a lock and no
     * cover and asks for the PIN to open. Long press: make private / not private.
     */
    private fun showAlbums(s: DdnSession, albums: List<IndexReplica.Album>) {
        // The album list has no selection (long press = the album's menu).
        endSelection()
        rows = emptyList()
        val locked = DdnPrivate.all(this)
        // Private ones last (as in the phone gallery), the rest newest first.
        val list: List<IndexReplica.Album> = albums.filter { it.id !in locked } + albums.filter { it.id in locked }
        val cols = maxOf(2, resources.displayMetrics.widthPixels / dp(170))
        val cell = resources.displayMetrics.widthPixels / cols
        this.list.layoutManager = GridLayoutManager(this, cols)
        this.list.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount() = list.size
            override fun onCreateViewHolder(p: ViewGroup, t: Int): RecyclerView.ViewHolder {
                val v = LinearLayout(this@DdnActivity).apply { orientation = LinearLayout.VERTICAL; layoutParams = ViewGroup.LayoutParams(cell, ViewGroup.LayoutParams.WRAP_CONTENT); setPadding(dp(4), dp(4), dp(4), dp(8)) }
                val box = FrameLayout(this@DdnActivity)
                box.setBackgroundResource(R.drawable.bg_cobalt_icon)
                box.clipToOutline = true
                box.addView(ImageView(this@DdnActivity).apply { scaleType = ImageView.ScaleType.CENTER_CROP }, FrameLayout.LayoutParams(-1, -1))
                box.addView(ImageView(this@DdnActivity).apply { setImageResource(R.drawable.ic_cobalt_lock); setColorFilter(getColor(R.color.cobalt_muted)) }, FrameLayout.LayoutParams(dp(32), dp(32), Gravity.CENTER))
                v.addView(box, LinearLayout.LayoutParams(-1, cell - dp(8)))
                v.addView(TextView(this@DdnActivity).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(dp(2), dp(6), 0, 0) })
                v.addView(TextView(this@DdnActivity).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowSub); setPadding(dp(2), 0, 0, 0) })
                return object : RecyclerView.ViewHolder(v) {}
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
                val a = list[i]
                val priv = a.id in locked
                val v = h.itemView as LinearLayout
                val box = v.getChildAt(0) as FrameLayout
                val img = box.getChildAt(0) as ImageView
                box.getChildAt(1).visibility = if (priv) View.VISIBLE else View.GONE
                img.setImageDrawable(null)
                img.contentDescription = a.name
                img.clearColorFilter()
                img.scaleType = ImageView.ScaleType.CENTER_CROP
                fun typeIcon() { img.setImageResource(R.drawable.ic_cobalt_image); img.setColorFilter(getColor(R.color.cobalt_muted)); img.scaleType = ImageView.ScaleType.CENTER_INSIDE }
                img.tag = null
                if (!priv) { if (thumbsOn && !a.cover.thumbHidden) DdnThumbs.into(s, a.cover.manifestRef, img, cell) { typeIcon() } else typeIcon() }
                (v.getChildAt(1) as TextView).text = a.name
                (v.getChildAt(2) as TextView).text = if (priv) getString(R.string.ddn_album_private) else plq(R.plurals.ddn_album_count, a.count, a.count)
                v.setOnClickListener { if (priv) PrivateUnlock.unlock(this@DdnActivity) { openAlbum(a) } else openAlbum(a) }
                // The camera's photos (the Gallery's root): no menu, it can neither be private nor moved.
                v.setOnLongClickListener { if (a.id != s.galleryRoot) albumMenu(a, priv); true }
            }
        }
        if (list.isEmpty()) note(getString(R.string.ddn_albums_empty))
    }

    private fun openAlbum(a: IndexReplica.Album) { album = a.id to a.name; show() }

    private fun togglePrivate(a: IndexReplica.Album, priv: Boolean) {
        if (priv) {
            PrivateUnlock.unlock(this) { DdnPrivate.set(this, a.id, false); toast(getString(R.string.album_private_unmarked)); show() }
            return
        }
        if (!PrivateAlbums.hasPin(this)) {
            com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setMessage(R.string.private_need_pin_msg)
                .setPositiveButton(R.string.private_set_pin) { _, _ -> startActivity(Intent(this, DdnSettingsActivity::class.java)) }
                .setNegativeButton(R.string.cobalt_cancel, null).show()
            return
        }
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setMessage(getString(R.string.ddn_album_private_ask, a.name))
            .setPositiveButton(R.string.cobalt_ok) { _, _ -> DdnPrivate.set(this, a.id, true); toast(getString(R.string.album_private_marked)); show() }
            .setNegativeButton(R.string.cobalt_cancel, null).show()
    }

    private fun toast(m: String) = android.widget.Toast.makeText(this, m, android.widget.Toast.LENGTH_SHORT).show()

    /** A line under the bar (empty folder / Gallery): shown with the status line. */
    private fun note(t: String) {
        status.text = if (status.text.isNullOrEmpty()) t else "${status.text} · $t"
        status.visibility = View.VISIBLE
    }

    private fun albumMenu(a: IndexReplica.Album, priv: Boolean) {
        val s = session ?: return
        val items = ArrayList<Pair<String, () -> Unit>>()
        items += getString(if (priv) R.string.album_private_unmark_action else R.string.album_private_mark_action) to { togglePrivate(a, priv) }
        if (s.gallerySpaceKnown) items += getString(R.string.ddn_to_drive) to { DdnPick.driveFolder(this, s) { to -> move(listOf(IndexReplica.Child(a.id, a.name, "folder", null, parentId = s.galleryRoot)), to, getString(R.string.ddn_moved_to_drive)) } }
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setTitle(a.name)
            .setItems(items.map { it.first }.toTypedArray()) { _, i -> items[i].second() }.show()
    }

    private fun move(cs: List<IndexReplica.Child>, to: String, done: String) {
        val s = session ?: return
        // Items already there are left out (moving a folder into itself is refused by the rules anyway).
        val ids = cs.filter { it.parentId != to && it.id != to }.map { it.id }
        if (ids.isEmpty()) { endSelection(); return }
        thread {
            val r = runCatching { s.move(ids, to) }
            main.post {
                r.onSuccess { toast(DdnViewerActivity.moveOutcome(this, it, done)); endSelection() }.onFailure { note(DdnErrors.text(this, it)) }
                show()
            }
        }
    }

    /** Hide / show the thumbnails of photos and videos on every device of the account. */
    private fun setThumbHidden(cs: List<IndexReplica.Child>, hidden: Boolean) {
        val s = session ?: return
        if (cs.isEmpty()) return
        thread {
            val r = runCatching { s.setThumbHidden(cs.map { it.id }, hidden) }
            main.post {
                r.onSuccess {
                    toast(if (cs.size == 1) getString(if (hidden) R.string.ddn_thumb_hidden else R.string.ddn_thumb_shown) else plq(if (hidden) R.plurals.ddn_thumbs_hidden else R.plurals.ddn_thumbs_shown, cs.size, cs.size))
                    endSelection()
                }.onFailure { note(DdnErrors.text(this, it)) }
                show()
            }
        }
    }

    /** Move to trash, asked first (30 days to restore, the trash is in Settings). */
    private fun askTrash(cs: List<IndexReplica.Child>) {
        val s = session ?: return
        if (cs.isEmpty()) return
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(R.string.ddn_to_trash)
            .setMessage(if (cs.size == 1) getString(R.string.ddn_to_trash_ask, cs[0].name) else plq(R.plurals.ddn_to_trash_ask_n, cs.size, cs.size))
            .setPositiveButton(R.string.ddn_to_trash) { _, _ ->
                thread {
                    val r = runCatching { s.moveToTrash(cs.map { it.id }) }
                    main.post {
                        if (r.isSuccess) endSelection()
                        r.onSuccess { android.widget.Toast.makeText(this, if (it == "applied") getString(R.string.ddn_moved_to_trash) else getString(R.string.ddn_trash_not_done, it), android.widget.Toast.LENGTH_SHORT).show() }
                            .onFailure { status.text = DdnErrors.text(this, it) }
                        show()
                    }
                }
            }
            .setNegativeButton(R.string.cobalt_cancel, null)
            .show()
    }

    private fun open(c: IndexReplica.Child, siblings: List<IndexReplica.Child>) {
        DdnViewerActivity.pending = siblings
        startActivity(Intent(this, DdnViewerActivity::class.java).putExtra("id", c.id))
    }


    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // ── for the instrumentation test (BrowseUiTest) ──
    internal fun findRecycler(): RecyclerView? = if (::list.isInitialized) list else null
    internal fun openFolderForTest(id: String, name: String) { gallery = false; nav.selectedItemId = 1; path += id to name; show() }
    internal fun showGalleryForTest() { nav.selectedItemId = 2 }
    internal fun statusForTest(): String = status.text.toString()
    internal fun refreshForTest() = refresh()
    internal fun showAlbumsForTest() { nav.selectedItemId = 3 }
    internal fun openAlbumForTest(id: String, name: String) { album = id to name; show() }
    internal fun isDrawn(): Boolean = list.isLaidOut && list.childCount > 0
    /** The selection's ⋮ menu for these items, as it would be shown (labels), built on the main thread like the real one. */
    internal fun rowMenuForTest(c: IndexReplica.Child): List<String> = selectionMenuForTest(listOf(c))
    internal fun selectionMenuForTest(cs: List<IndexReplica.Child>): List<String> = session?.let { s -> selectionItems(s, cs, gallery || albumsTab).map { it.first } } ?: emptyList()
    /** Items shown (day headers left out). */
    internal fun itemCountForTest(): Int = (list.adapter?.itemCount ?: -1).let { n -> if (n < 0) n else n - rows.count { it is Row.Head } }
    /** Adapter position of the n-th item (headers skipped). */
    internal fun positionOfItemForTest(n: Int): Int = rows.withIndex().filter { it.value is Row.Item }.getOrNull(n)?.index ?: -1
    internal fun headPositionsForTest(): List<Int> = rows.withIndex().filter { it.value is Row.Head }.map { it.index }
    internal fun longPressForTest(position: Int) { startSelection(position); dragging = false }
    /** A tap on the item at `position` (selecting: adds / removes it). */
    internal fun tapForTest(position: Int) { if (selecting) toggle(position) }
    /** Long press at `from` and the finger moved to `to` (still down: dragMoreForTest moves it on). */
    internal fun dragForTest(from: Int, to: Int) { startSelection(from); dragTo(to); dragging = false }
    internal fun dragMoreForTest(to: Int) = dragTo(to)
    internal fun selectDayForTest(headAt: Int) = selectDay(headAt)
    internal fun tapDayForTest(headAt: Int) = toggleDay(headAt)
    internal fun selectAllForTest() = selectAll()
    internal fun selectedForTest(): Set<String> = if (selecting) selected.toSet() else emptySet()
    internal fun selectingForTest(): Boolean = selecting
    internal fun selectionBarForTest(): Boolean = selBar.visibility == View.VISIBLE && bar.visibility == View.GONE && nav.visibility == View.GONE
    internal fun selectionTitleForTest(): String = selCount.contentDescription?.toString() ?: ""
    /**
     * The count is shown whole: no ellipsis, and its text fits the view at the bar's size and 30 % larger
     * (Settings → font size); the numbers go to the log.
     */
    internal fun selectionCountFitsForTest(): Boolean {
        val room = selCount.width - selCount.paddingLeft - selCount.paddingRight
        val t = selCount.text.toString()
        val w = selCount.paint.measureText(t)
        val big = android.graphics.Paint(selCount.paint).apply { textSize = selCount.textSize * 1.3f }.measureText(t)
        android.util.Log.i("ddn-ui", "selection count '$t': room $room px, text $w px, at 1.3 $big px, screen ${resources.displayMetrics.widthPixels} px")
        return t.isNotEmpty() && room > 0 && (selCount.layout?.getEllipsisCount(0) ?: 0) == 0 && w <= room && big <= room
    }
    internal fun selectionCountTextForTest(): String = selCount.text.toString()
    /** Adapter positions of the files (not folders) of the open list. */
    internal fun filePositionsForTest(): List<Int> = rows.withIndex().filter { (it.value as? Row.Item)?.c?.isFolder == false }.map { it.index }
    internal fun backForTest() = onBackPressedDispatcher.onBackPressed()
    /** Runs the selection's menu entry with this label (as a tap on it). */
    internal fun runSelectionActionForTest(label: String): Boolean = session?.let { s -> selectionItems(s, chosen(), gallery || albumsTab).firstOrNull { it.first == label }?.second?.invoke()?.let { true } } ?: false

    internal fun showForTest() = show()

    /** A cell of the grid shows a decoded picture (a thumbnail, not the type icon). */
    internal fun firstCellHasPicture(): Boolean = (0 until list.childCount).any { i ->
        val img = (list.getChildAt(i) as? FrameLayout)?.getChildAt(0) as? ImageView
        img?.drawable is android.graphics.drawable.BitmapDrawable
    }

    companion object {
        /** Payload of a selection-only change of the list's rows. */
        private const val SELECTION = "selection"
        const val START = "start"
        /** With START "files": the folders from the root down to the one to open (IDs and names, same order). */
        const val PATH_IDS = "pathIds"
        const val PATH_NAMES = "pathNames"
        /** With START "album": the album to open. */
        const val ALBUM_ID = "albumId"
        const val ALBUM_NAME = "albumName"
    }
}

/** The "Galeria" launcher icon: the same screen starting in the Gallery, in its own task (its own card in Recents). */
class DdnGallery : DdnActivity()
