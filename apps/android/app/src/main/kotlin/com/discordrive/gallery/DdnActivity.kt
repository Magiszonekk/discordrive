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
import io.github.magiszonekk.discordrive.core.GalleryBackup
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
    private lateinit var selTrash: View
    /** The Gallery: ⋮ (filter, legend), the copy's state over the grid, the one-time legend. */
    private lateinit var galleryMore: View
    private lateinit var backupBar: LinearLayout
    private lateinit var backupText: TextView
    private lateinit var backupOn: TextView
    private lateinit var legendCard: View
    /** The Gallery's tiles with their copy state (ID → entry); empty in albums and Files. */
    private var entries: Map<String, GalleryBackup.Entry> = emptyMap()
    private var filter = GalleryBackup.Filter.ALL
    /** What the Gallery's grid shows now (after the filter). */
    private var galleryShown: List<IndexReplica.Child> = emptyList()
    /** The file the upload job is sending now and how far (the badge's ring). */
    private var sendingName: String? = null
    private var sendingPct = 0

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

        // Recreated (the system font size or the theme changed): the same tab, folder and selection as before.
        gallery = savedInstanceState?.getBoolean("gallery") == true
        albumsTab = savedInstanceState?.getBoolean("albumsTab") == true
        album = savedInstanceState?.getString("albumId")?.let { it to (savedInstanceState.getString("albumName") ?: "") }
        if (savedInstanceState != null) {
            val ids = savedInstanceState.getStringArrayList("selectedIds")
            if (ids != null) selected.addAll(ids)
            val pathIds = savedInstanceState.getStringArrayList("pathIds")
            val pathNames = savedInstanceState.getStringArrayList("pathNames")
            if (pathIds != null && pathNames != null && pathIds.size == pathNames.size) {
                path += pathIds.zip(pathNames)
            }
        }
        selecting = savedInstanceState?.getBoolean("selecting") == true && selected.isNotEmpty()
        filter = savedInstanceState?.getString("filter")?.let { f -> GalleryBackup.Filter.values().firstOrNull { it.name == f } } ?: GalleryBackup.Filter.ALL
        if (path.isEmpty()) path += "root" to getString(R.string.ddn_files)

        // A fresh start: the icon or the intent decides where it opens.
        if (savedInstanceState == null) {
            gallery = intent.getStringExtra(START) == "gallery" || intent.component?.className?.endsWith(".DdnGallery") == true
            // "Show in folder" from the viewer: Files at a folder (its path from the root) or an album.
            when (intent.getStringExtra(START)) {
                "files" -> {
                    val ids = intent.getStringArrayListExtra(PATH_IDS).orEmpty()
                    val names = intent.getStringArrayListExtra(PATH_NAMES).orEmpty()
                    if (ids.size == names.size) path += ids.zip(names)
                }
                "album" -> intent.getStringExtra(ALBUM_ID)?.let { albumsTab = true; album = it to (intent.getStringExtra(ALBUM_NAME) ?: "") }
            }
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
            tag = DdnSafeActivity.NAV_TAG
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
        galleryMore = barIcon(bar, R.drawable.ic_cobalt_more, R.string.ddn_more) { v -> galleryMenu(v) }
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
        selTrash = barIcon(selBar, R.drawable.ic_cobalt_trash, R.string.ddn_to_trash) { askTrash(chosen()) }
        barIcon(selBar, R.drawable.ic_cobalt_more, R.string.ddn_more) { v -> selectionMenu(v) }
        root.addView(selBar)
        root.addView(crumbs)
        root.addView(status)
        // The Gallery: how far the copy is ("Skopiowano 1 100 z 1 109 · 9 czeka na Wi-Fi"); tap = the automatic copy.
        // The numbers in tabular figures: "Skopiowano 1 099 z 1 109" does not shift while it counts.
        backupText = TextView(this).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowSub); setTextColor(getColor(R.color.cobalt_ink_2)); fontFeatureSettings = "tnum"; maxLines = 2 }
        // "Włącz": a small tonal action in the account's accent; it lights up with the line (the line takes the tap).
        backupOn = TextView(this).apply {
            androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); textSize = 14f; setTextColor(themeAccent())
            text = getString(R.string.ddn_gb_turn_on); setPadding(dp(12), dp(6), dp(12), dp(6)); minHeight = dp(32); gravity = Gravity.CENTER
            setBackgroundResource(R.drawable.bg_cobalt_chip_accent); isDuplicateParentStateEnabled = true; visibility = View.GONE
        }
        backupBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPaddingRelative(pad, dp(4), dp(12), dp(8)); minimumHeight = dp(44); visibility = View.GONE
            addView(ImageView(this@DdnActivity).apply { setImageResource(R.drawable.ic_cobalt_cloud); setColorFilter(getColor(R.color.cobalt_muted)) }, LinearLayout.LayoutParams(dp(18), dp(18)).apply { marginEnd = dp(10) })
            addView(backupText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(backupOn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) })
            val tv = android.util.TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true); setBackgroundResource(tv.resourceId)
            setOnClickListener { startActivity(Intent(this@DdnActivity, DdnBackupActivity::class.java)) }
        }
        root.addView(backupBar)
        legendCard = legend(once = true).apply { visibility = View.GONE }
        root.addView(legendCard, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { setMargins(pad, 0, pad, dp(8)) })
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
                watchProgress()
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

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean("gallery", gallery)
        outState.putBoolean("albumsTab", albumsTab)
        album?.let { outState.putString("albumId", it.first); outState.putString("albumName", it.second) }
        outState.putBoolean("selecting", selecting)
        outState.putString("filter", filter.name)
        if (selected.isNotEmpty()) outState.putStringArrayList("selectedIds", ArrayList(selected))
        outState.putStringArrayList("pathIds", ArrayList(path.map { it.first }))
        outState.putStringArrayList("pathNames", ArrayList(path.map { it.second }))
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
        if (!gallery) galleryMore.visibility = View.GONE
        if (!gallery) { backupBar.visibility = View.GONE; legendCard.visibility = View.GONE; entries = emptyMap() }
        thread {
            if (albumsTab) {
                val open = album
                if (open != null) {
                    val items = s.albumMedia(open.first)
                    val dates = DdnTaken.takenAll(this, s.acct.accountId)
                    main.post { if (albumsTab && album == open) { showGrid(s, items, dates); fillTaken(s, items, dates) } }
                } else {
                    val albums = listOfNotNull(s.cameraAlbum(DdnBackup.cameraName(this, getString(R.string.ddn_album_camera)))) + s.albums()
                    main.post { if (albumsTab && album == null) showAlbums(s, albums) }
                }
            } else if (gallery) {
                val account = s.media(5000, null, DdnPrivate.all(this))
                val dates = DdnTaken.takenAll(this, s.acct.accountId)
                // The phone's own photos next to the account's, each with the state of its copy.
                val view = runCatching { DdnGalleryState.build(this, s, account, sendingName) }.onFailure { android.util.Log.w("ddn-ui", "gallery state: ${it.message}") }.getOrNull() ?: DdnGalleryState.plain(account)
                val all = view.entries
                main.post {
                    if (!gallery) return@post
                    val shown = GalleryBackup.filter(all, if (view.bar == null) GalleryBackup.Filter.ALL else filter)
                    entries = all.associateBy { it.item.id }
                    galleryShown = shown.map { it.item }
                    paintBackupBar(view.bar)
                    // The filter needs the phone's photos (no access: nothing to filter by).
                    galleryMore.visibility = if (view.bar != null) View.VISIBLE else View.GONE
                    if (view.bar == null && filter != GalleryBackup.Filter.ALL) { filter = GalleryBackup.Filter.ALL; galleryShown = all.map { it.item } }
                    showGrid(s, galleryShown, dates)
                    fillTaken(s, account, dates)
                    if (shown.isEmpty() && all.isNotEmpty()) note(getString(R.string.ddn_gb_filter_empty))
                }
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

    /** When each version's content was made (manifestRef -> ms, 0 = not stored), as the open grid knows it. */
    private var taken: Map<String, Long> = emptyMap()

    /** The date a photo is shown under: when it was taken (EXIF / the uploader's takenAt), else when it was added. */
    private fun dateOf(c: IndexReplica.Child): Long = c.manifestRef?.let { taken[it] }?.takeIf { it > 0 } ?: c.createdAt

    /**
     * Photos synced from another device: their date taken is in the manifest only. Read the ones not looked at
     * yet in the background; the grid is redrawn once with what was learned.
     */
    private fun fillTaken(s: DdnSession, items: List<IndexReplica.Child>, known: Map<String, Long>) {
        if (items.none { it.manifestRef != null && it.manifestRef !in known }) return
        val wasGallery = gallery
        val wasAlbum = album
        thread {
            if (DdnTaken.fillMissing(this, s, items) == 0) return@thread
            val dates = DdnTaken.takenAll(this, s.acct.accountId)
            main.post {
                // The Gallery redraws what it shows (the phone's photos too), an album its items.
                if (gallery == wasGallery && album == wasAlbum && (gallery || albumsTab)) showGrid(s, if (gallery) galleryShown else items, dates)
            }
        }
    }

    private fun showList(s: DdnSession, items: List<IndexReplica.Child>) {
        gridKey = null
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
    private fun withDays(all: List<IndexReplica.Child>): List<Row> {
        val items = all.sortedByDescending { dateOf(it) }
        val zone = java.time.ZoneId.systemDefault()
        val today = java.time.LocalDate.now(zone)
        val out = ArrayList<Row>(items.size + 16)
        var last: Long? = null
        for (c in items) {
            val at = dateOf(c)
            val day = if (at > 0) java.time.Instant.ofEpochMilli(at).atZone(zone).toLocalDate() else null
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

    /** Which grid is open (the Gallery, an album): redrawn in place, it keeps its scroll position. */
    private var gridKey: String? = null

    private fun showGrid(s: DdnSession, items: List<IndexReplica.Child>, dates: Map<String, Long>) {
        taken = dates
        rows = withDays(items)
        keepSelection()
        val key = if (gallery) "gallery" else "album:${album?.first}"
        val keep = if (key == gridKey) list.layoutManager?.onSaveInstanceState() else null
        gridKey = key
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
                // The copy's state (Gallery): a small circle at the bottom end, a ring while it is being sent.
                f.addView(badgeView(), FrameLayout.LayoutParams(dp(24), dp(24), Gravity.BOTTOM or Gravity.END).apply { setMargins(0, 0, dp(6), dp(6)) })
                return object : RecyclerView.ViewHolder(f) {}
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int, payloads: MutableList<Any>) {
                // Only the selection (or the sending's progress) changed: the cell keeps its picture.
                val row = rows[i]
                if (payloads.isNotEmpty() && row is Row.Item) { cellSelection(h.itemView as FrameLayout, row.c); paintBadge(h.itemView as FrameLayout, row.c) } else onBindViewHolder(h, i)
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
                paintBadge(f, c)
                val local = entries[c.id]?.local
                // A photo only on the phone: the system's thumbnail (Settings → Thumbnails off: the type icon, as for the rest).
                if (GalleryBackup.isLocal(c.id) && local != null) { if (thumbsOn) localThumb(local.mediaId, local.video, img, cell) { typeIcon() } else { img.tag = null; typeIcon() } }
                else if (thumbsOn && !c.thumbHidden) DdnThumbs.into(s, c.manifestRef, img, cell) { typeIcon() } else { img.tag = null; typeIcon() }
                f.setOnClickListener { if (selecting) toggle(h.bindingAdapterPosition) else open(c, itemsNow()) }
                f.setOnLongClickListener { startSelection(h.bindingAdapterPosition); true }
            }
        }
        keep?.let { list.layoutManager?.onRestoreInstanceState(it) }
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

    /** The selected items of the account, in list order (photos only on the phone have no account actions). */
    private fun chosen(): List<IndexReplica.Child> = itemsNow().filter { it.id in selected && !GalleryBackup.isLocal(it.id) }
    /** Every selected item, the phone's own too. */
    private fun chosenAll(): List<IndexReplica.Child> = itemsNow().filter { it.id in selected }

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
        // Download / Share are for files (a folder is not sent as one file), of the account.
        val acc = chosen()
        val files = acc.isNotEmpty() && acc.none { it.isFolder }
        selShare.visibility = if (files) View.VISIBLE else View.GONE
        selDownload.visibility = if (files) View.VISIBLE else View.GONE
        selTrash.visibility = if (acc.isNotEmpty() || !selecting) View.VISIBLE else View.GONE
        if (gallery) { backupBar.visibility = if (selecting || backupText.text.isNullOrEmpty()) View.GONE else View.VISIBLE; if (selecting) legendCard.visibility = View.GONE }
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
        val items = selectionItems(s, chosenAll(), gallery || albumsTab)
        val pm = androidx.appcompat.widget.PopupMenu(this, anchor, Gravity.END)
        items.forEachIndexed { i, (label, _) -> pm.menu.add(0, i, i, label) }
        pm.setOnMenuItemClickListener { items[it.itemId].second(); true }
        pm.show()
    }

    /** The actions for the selected items. The main thread: what refresh() learned about the instance (no network here). */
    private fun selectionItems(s: DdnSession, all: List<IndexReplica.Child>, inGallery: Boolean): List<Pair<String, () -> Unit>> {
        val items = ArrayList<Pair<String, () -> Unit>>()
        if (all.isEmpty()) return items
        // Photos only on the phone (the Gallery): "Copy now"; the other actions are for the account's files.
        val notCopied = all.filter { entries[it.id]?.badge.let { b -> b == GalleryBackup.Badge.LOCAL_ONLY || b == GalleryBackup.Badge.FAILED } }
        if (notCopied.isNotEmpty()) items += getString(R.string.ddn_gb_copy_now) to { copyNow(notCopied) }
        val cs = all.filter { !GalleryBackup.isLocal(it.id) }
        if (cs.isEmpty()) {
            if (itemsNow().any { it.id !in selected }) items.add(0, getString(R.string.ddn_select_all) to { selectAll() })
            return items
        }
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
        gridKey = null
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
        val e = entries[c.id]
        // A failed copy: why, and Retry.
        if (e?.badge == GalleryBackup.Badge.FAILED) { failedDialog(e); return }
        // Only on the phone: the phone's own file, with "Send to discordrive".
        if (GalleryBackup.isLocal(c.id)) {
            val l = e?.local ?: return
            val coll = if (l.video) android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI else android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            startActivity(Intent(Intent.ACTION_VIEW).setClass(this, DdnOpenActivity::class.java).setDataAndType(android.content.ContentUris.withAppendedId(coll, l.mediaId), if (l.video) "video/*" else "image/*"))
            return
        }
        // The viewer pages through the account's files (the phone's own have no copy to show there).
        DdnViewerActivity.pending = siblings.filter { !GalleryBackup.isLocal(it.id) }
        startActivity(Intent(this, DdnViewerActivity::class.java).putExtra("id", c.id))
    }

    // ── the Gallery: the state of each photo's copy ──

    // The badge sits on the photo, so it keeps one look in both modes: a blue-black circle with a light rim (light
    // and dark photos), a full red one for a failed copy; while sending, the progress ring is the circle's edge.
    private fun badgeView(): FrameLayout = FrameLayout(this).apply {
        setBackgroundResource(R.drawable.bg_cobalt_badge)
        elevation = dp(2).toFloat()
        visibility = View.GONE
        addView(ImageView(this@DdnActivity).apply { setColorFilter(Color.WHITE) }, FrameLayout.LayoutParams(dp(14), dp(14), Gravity.CENTER))
        // No inset (Material's default 4 dp shrank the ring to ~18 dp, onto the icon), no gap at the ends.
        addView(com.google.android.material.progressindicator.CircularProgressIndicator(this@DdnActivity).apply {
            indicatorInset = 0; indicatorSize = dp(24); trackThickness = dp(2); trackCornerRadius = dp(1); indicatorTrackGapSize = 0
            setIndicatorColor(Color.WHITE); trackColor = 0x4DFFFFFF; visibility = View.GONE
        }, FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER))
    }

    private fun badgeBackground(b: GalleryBackup.Badge): Int = when (b) {
        GalleryBackup.Badge.FAILED -> R.drawable.bg_cobalt_badge_error
        GalleryBackup.Badge.SENDING -> R.drawable.bg_cobalt_badge_sending
        else -> R.drawable.bg_cobalt_badge
    }

    /** The account's accent (the accent preset overlays colorPrimary), as CobaltUi uses it. */
    private fun themeAccent(): Int {
        val tv = android.util.TypedValue()
        theme.resolveAttribute(androidx.appcompat.R.attr.colorPrimary, tv, true)
        return tv.data
    }

    /** The cell's badge for its copy's state (none: on the phone and in the account, or outside the Gallery). */
    private fun paintBadge(f: FrameLayout, c: IndexReplica.Child) {
        val badge = f.getChildAt(3) as FrameLayout
        val e = entries[c.id]
        val icon = e?.let { DdnGalleryState.icon(it.badge) }
        if (e == null || icon == null || selecting) { badge.visibility = View.GONE; badge.contentDescription = null; return }
        badge.visibility = View.VISIBLE
        badge.contentDescription = DdnGalleryState.words(this, e.badge)
        badge.setBackgroundResource(badgeBackground(e.badge))
        (badge.getChildAt(0) as ImageView).setImageResource(icon)
        val ring = badge.getChildAt(1) as com.google.android.material.progressindicator.CircularProgressIndicator
        if (e.badge == GalleryBackup.Badge.SENDING) { ring.visibility = View.VISIBLE; ring.setProgressCompat(sendingPct.coerceIn(0, 100), false) } else ring.visibility = View.GONE
    }

    /** A photo only on the phone: the system's thumbnail of it. */
    private val localThumbs = object : android.util.LruCache<Long, android.graphics.Bitmap>(16 * 1024) {
        override fun sizeOf(key: Long, value: android.graphics.Bitmap) = value.byteCount / 1024
    }
    private fun localThumb(mediaId: Long, video: Boolean, img: ImageView, px: Int, onNone: () -> Unit) {
        val tag = "local:$mediaId"
        img.tag = tag
        localThumbs.get(mediaId)?.let { img.setImageBitmap(it); return }
        val coll = if (video) android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI else android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        DdnThumbs.pool.execute {
            val b = runCatching { contentResolver.loadThumbnail(android.content.ContentUris.withAppendedId(coll, mediaId), android.util.Size(px, px), null) }.getOrNull()
            if (b != null) localThumbs.put(mediaId, b)
            main.post { if (img.tag == tag) { if (b != null) img.setImageBitmap(b) else onNone() } }
        }
    }

    /** The line over the grid; "Włącz" when the automatic copy is off. */
    private fun paintBackupBar(b: GalleryBackup.Bar?) {
        if (b == null || !gallery) { backupBar.visibility = View.GONE; return }
        backupText.text = DdnGalleryState.barText(this, b)
        backupOn.visibility = if (b is GalleryBackup.Bar.Off) View.VISIBLE else View.GONE
        // The line's icon speaks the badges' language: off, being copied / waiting, failures, all copied.
        val failed = when (b) { is GalleryBackup.Bar.AllCopied -> b.failed; is GalleryBackup.Bar.Progress -> b.failed; is GalleryBackup.Bar.Waiting -> b.failed; else -> 0 }
        val (barIcon, barTint) = when {
            b is GalleryBackup.Bar.Off -> R.drawable.ic_cobalt_cloud_off to getColor(R.color.cobalt_muted)
            failed > 0 -> R.drawable.ic_cobalt_cloud_alert to getColor(R.color.cobalt_error)
            b is GalleryBackup.Bar.AllCopied -> R.drawable.ic_cobalt_cloud_check to getColor(R.color.cobalt_success)
            b is GalleryBackup.Bar.Progress -> R.drawable.ic_cobalt_cloud_upload to themeAccent()
            else -> R.drawable.ic_cobalt_cloud_upload to getColor(R.color.cobalt_muted)
        }
        (backupBar.getChildAt(0) as ImageView).apply { setImageResource(barIcon); setColorFilter(barTint) }
        backupBar.visibility = if (selecting) View.GONE else View.VISIBLE
        backupBar.contentDescription = backupText.text
        // The legend once, at the first visit of the Gallery with the phone's photos in it.
        legendCard.visibility = if (!selecting && !DdnGalleryState.legendSeen(this) && entries.values.any { it.onPhone }) View.VISIBLE else View.GONE
    }

    /** "What the badges mean": a card under the bar (once) or a dialog (⋮). */
    private fun legend(once: Boolean): LinearLayout {
        // The card: filled a step off the page (a hairline alone disappears on the dark Cobalt). The dialog: its own
        // 24 dp insets, in line with its title.
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; if (once) setPadding(dp(16), dp(14), dp(16), dp(6)) else setPadding(dp(24), dp(8), dp(24), 0) }
        if (once) box.setBackgroundResource(R.drawable.bg_cobalt_legend)
        if (once) box.addView(TextView(this).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); text = getString(R.string.ddn_gb_legend) }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
        // "Tylko na telefonie — nie ma kopii…": the state's name in ink, what it means in muted.
        fun named(full: String, name: Int): CharSequence = android.text.SpannableString(full).apply {
            if (name > 0) {
                setSpan(android.text.style.ForegroundColorSpan(getColor(R.color.cobalt_ink)), 0, name, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                androidx.core.content.res.ResourcesCompat.getFont(this@DdnActivity, R.font.inter_medium)?.let { setSpan(android.text.style.TypefaceSpan(it), 0, name, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
            }
        }
        for ((badge, words) in listOf(
            GalleryBackup.Badge.LOCAL_ONLY to R.string.ddn_gb_legend_local,
            GalleryBackup.Badge.QUEUED to R.string.ddn_gb_legend_queued,
            GalleryBackup.Badge.FAILED to R.string.ddn_gb_legend_failed,
            GalleryBackup.Badge.ACCOUNT_ONLY to R.string.ddn_gb_legend_account,
        )) {
            // The badge at the first line (a description of 2–3 lines does not pull it to the middle).
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.TOP; setPadding(0, dp(5), 0, dp(5)) }
            val b = badgeView().apply { visibility = View.VISIBLE; (getChildAt(0) as ImageView).setImageResource(DdnGalleryState.icon(badge)!!); setBackgroundResource(badgeBackground(badge)) }
            row.addView(b, LinearLayout.LayoutParams(dp(24), dp(24)).apply { marginEnd = dp(12) })
            val name = DdnGalleryState.words(this@DdnActivity, badge)
            row.addView(TextView(this).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowSub); setPadding(0, dp(3), 0, 0); text = named(getString(R.string.ddn_gb_badge_x, name, getString(words)), name.length) }, LinearLayout.LayoutParams(0, -2, 1f))
            box.addView(row)
        }
        // No badge: an empty dashed circle in the badge's place, the same column as the rows above.
        box.addView(TextView(this).apply {
            androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowSub)
            val t = getString(R.string.ddn_gb_legend_both)
            text = named(t, t.indexOf(':').coerceAtLeast(0))
            val none = androidx.core.content.ContextCompat.getDrawable(this@DdnActivity, R.drawable.bg_cobalt_badge_none)!!.apply { setBounds(0, 0, dp(24), dp(24)) }
            setCompoundDrawablesRelative(none, null, null, null); compoundDrawablePadding = dp(12); gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(5), 0, dp(4))
        })
        if (once) box.addView(TextView(this).apply {
            androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); textSize = 14f; setTextColor(themeAccent())
            text = getString(R.string.ddn_gb_legend_ok); setPadding(dp(12), dp(8), dp(12), dp(8)); minHeight = dp(40); gravity = Gravity.CENTER
            val tv = android.util.TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true); setBackgroundResource(tv.resourceId)
            setOnClickListener { DdnGalleryState.setLegendSeen(this@DdnActivity); legendCard.visibility = View.GONE }
        }, LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.END; marginEnd = -dp(8) })
        return box
    }

    /** The Gallery's ⋮: what to show (all / only on the phone / only in the account), the legend. */
    private fun galleryMenu(anchor: View) {
        val pm = androidx.appcompat.widget.PopupMenu(this, anchor, Gravity.END)
        val sub = pm.menu.addSubMenu(0, 0, 0, R.string.ddn_gb_filter)
        val fs = listOf(GalleryBackup.Filter.ALL to R.string.ddn_gb_filter_all, GalleryBackup.Filter.PHONE_ONLY to R.string.ddn_gb_filter_phone, GalleryBackup.Filter.ACCOUNT_ONLY to R.string.ddn_gb_filter_account)
        fs.forEachIndexed { i, (f, label) -> sub.add(1, 10 + i, i, label).apply { isCheckable = true; isChecked = f == filter } }
        sub.setGroupCheckable(1, true, true)
        pm.menu.add(0, 1, 1, R.string.ddn_gb_legend)
        pm.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> showLegend()
                in 10..12 -> setFilter(fs[item.itemId - 10].first)
            }
            true
        }
        pm.show()
    }

    private fun showLegend() {
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setTitle(R.string.ddn_gb_legend).setView(legend(once = false))
            .setPositiveButton(R.string.ddn_gb_legend_ok) { _, _ -> DdnGalleryState.setLegendSeen(this); legendCard.visibility = View.GONE }.show()
    }

    private fun setFilter(f: GalleryBackup.Filter) {
        if (f == filter) return
        endSelection()
        filter = f
        show()
    }

    /** A failed copy: its cause in words and Retry (the queue's item again, or the automatic copy's next run now). */
    private fun failedDialog(e: GalleryBackup.Entry) {
        val why = e.error?.let { DdnBackup.reason(this, it) } ?: getString(R.string.ddn_fail_other)
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setTitle(R.string.ddn_gb_failed_title).setMessage("${e.item.name}\n$why")
            .setPositiveButton(R.string.ddn_gb_retry) { _, _ ->
                thread {
                    val db = DdnBackup.db(this)
                    val acct = session?.acct?.accountId
                    if (e.queueId != null) db.retry(e.queueId!!) else if (acct != null) e.local?.let { db.mediaOk(it.mediaId, acct) }
                    main.post { DdnBackup.runNow(this, autoCopy = e.queueId == null, manual = e.queueId == null); toast(getString(R.string.ddn_backup_started)); show() }
                }
            }
            .setNegativeButton(R.string.cobalt_cancel, null).show()
    }

    /** "Copy now" on the selected photos that are only on the phone. */
    private fun copyNow(cs: List<IndexReplica.Child>) {
        val s = session ?: return
        val pick = cs.mapNotNull { c -> entries[c.id]?.takeIf { it.badge == GalleryBackup.Badge.LOCAL_ONLY || it.badge == GalleryBackup.Badge.FAILED }?.local }
        val run = {
            thread {
                val media = runCatching { DdnBackup.scan(this, pick.mapTo(HashSet()) { it.bucket }) }.getOrDefault(emptyList()).filter { m -> pick.any { it.mediaId == m.id } }
                val r = runCatching { DdnBackup.copyNow(this, s, media) }
                main.post {
                    r.onSuccess { n -> toast(if (n > 0) plq(R.plurals.ddn_gb_copy_queued, n, n) else getString(R.string.ddn_gb_copy_none)) }.onFailure { note(DdnErrors.text(this, it)) }
                    endSelection()
                    show()
                }
            }
            Unit
        }
        // The photos' GPS position is kept: the permission is asked for before they are read.
        if (!DdnBackup.mayCopyMedia(this)) gate.ask { run() } else run()
    }

    /** The upload job's progress: the file being sent gets the ring; a job that ends refreshes the Gallery. */
    private fun watchProgress() {
        androidx.work.WorkManager.getInstance(this).getWorkInfosLiveData(androidx.work.WorkQuery.fromUniqueWorkNames(DdnBackup.WORKS)).observe(this) { infos ->
            val run = infos.firstOrNull { it.state == androidx.work.WorkInfo.State.RUNNING }
            val name = run?.progress?.getString("name")
            val pct = run?.progress?.getInt("pct", 0) ?: 0
            val wasRunning = sendingName != null
            if (name != sendingName) {
                sendingName = name; sendingPct = pct
                // The job went on to the next file: the ring moves there (no reload, the grid keeps its place);
                // the job ended: the Gallery is read again (copies made, the bar's count).
                if (!gallery) return@observe
                if (name == null) { if (wasRunning) refresh(); return@observe }
                entries = entries.mapValues { (_, e) ->
                    when {
                        e.badge == GalleryBackup.Badge.SENDING -> e.copy(badge = GalleryBackup.Badge.QUEUED)
                        e.badge == GalleryBackup.Badge.QUEUED && e.item.name == name -> e.copy(badge = GalleryBackup.Badge.SENDING)
                        else -> e
                    }
                }
                list.adapter?.notifyItemRangeChanged(0, rows.size, SELECTION)
            } else if (pct != sendingPct) {
                sendingPct = pct
                if (gallery) rows.forEachIndexed { i, r -> if ((r as? Row.Item)?.c?.let { entries[it.id]?.badge } == GalleryBackup.Badge.SENDING) list.adapter?.notifyItemChanged(i, SELECTION) }
            }
        }
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
    /** The Gallery's tiles with their copy state (name → badge), as shown. */
    internal fun badgesForTest(): Map<String, GalleryBackup.Badge> = itemsNow().mapNotNull { c -> entries[c.id]?.let { c.name to it.badge } }.toMap()
    /** What the badge views of the drawn cells say (TalkBack text), by the cell's name. */
    internal fun drawnBadgesForTest(): Map<String, String?> = (0 until list.childCount).mapNotNull { i ->
        val f = list.getChildAt(i) as? FrameLayout ?: return@mapNotNull null
        val name = (f.getChildAt(0) as? ImageView)?.contentDescription?.toString() ?: return@mapNotNull null
        name to (f.getChildAt(3) as? View)?.takeIf { it.visibility == View.VISIBLE }?.contentDescription?.toString()
    }.toMap()
    internal fun backupBarForTest(): String? = if (backupBar.visibility == View.VISIBLE) backupText.text.toString() else null
    internal fun legendShownForTest(): Boolean = legendCard.visibility == View.VISIBLE
    internal fun setFilterForTest(f: GalleryBackup.Filter) = setFilter(f)
    /** Items shown (day headers left out). */
    internal fun itemCountForTest(): Int = (list.adapter?.itemCount ?: -1).let { n -> if (n < 0) n else n - rows.count { it is Row.Head } }
    /** Adapter position of the n-th item (headers skipped). */
    internal fun positionOfItemForTest(n: Int): Int = rows.withIndex().filter { it.value is Row.Item }.getOrNull(n)?.index ?: -1
    internal fun positionOfNameForTest(name: String): Int = rows.indexOfFirst { (it as? Row.Item)?.c?.name == name }
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
    internal fun endSelectionForTest() = endSelection()
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
    internal fun runSelectionActionForTest(label: String): Boolean = session?.let { s -> selectionItems(s, chosenAll(), gallery || albumsTab).firstOrNull { it.first == label }?.second?.invoke()?.let { true } } ?: false

    internal fun showForTest() = show()

    /** A cell of the grid shows a decoded picture (a thumbnail, not the type icon). */
    internal fun firstCellHasPicture(): Boolean = (0 until list.childCount).any { i ->
        val img = (list.getChildAt(i) as? FrameLayout)?.getChildAt(0) as? ImageView
        img?.drawable is android.graphics.drawable.BitmapDrawable
    }

    internal fun isGalleryForTest(): Boolean = gallery
    /** The date the item is shown under (taken, else added). */
    internal fun dateOfForTest(c: IndexReplica.Child): Long = dateOf(c)
    /** Day headers with the names of the items under each, in list order. */
    internal fun daysForTest(): List<Pair<String, List<String>>> {
        val out = ArrayList<Pair<String, MutableList<String>>>()
        for (r in rows) when (r) { is Row.Head -> out += r.label to ArrayList(); is Row.Item -> out.lastOrNull()?.second?.add(r.c.name) }
        return out
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
