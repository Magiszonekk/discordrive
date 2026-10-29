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
            setOnItemSelectedListener { gallery = it.itemId == 2; albumsTab = it.itemId == 3; album = null; show(); true }
        }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        bar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        fun barIcon(icon: Int, label: Int, onClick: () -> Unit) = bar.addView(ImageView(this).apply {
            setImageResource(icon); setColorFilter(getColor(R.color.cobalt_ink)); contentDescription = getString(label)
            setPadding(dp(12), dp(12), dp(12), dp(12))
            val tv = android.util.TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true); setBackgroundResource(tv.resourceId)
            setOnClickListener { onClick() }
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        barIcon(R.drawable.ic_cobalt_search, R.string.ddn_search) { startActivity(Intent(this@DdnActivity, DdnSearchActivity::class.java)) }
        // Upload into the open place: the folder (Files), the album, the Gallery.
        barIcon(R.drawable.ic_cobalt_upload, R.string.ddn_upload) { pick.launch(arrayOf("*/*")) }
        barIcon(R.drawable.ic_lock, R.string.safe_title) { DdnSafeActivity.open(this@DdnActivity) }
        barIcon(R.drawable.ic_cobalt_settings, R.string.ddn_settings) { startActivity(Intent(this@DdnActivity, DdnSettingsActivity::class.java)) }
        bar.setPaddingRelative(0, 0, dp(4), 0)
        root.addView(bar)
        root.addView(crumbs)
        root.addView(status)
        root.addView(swipe, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(nav)
        setContentView(root)
        Insets.apply(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Back from a folder goes up; from the root of this icon's view it closes only this task.
                if (albumsTab && album != null) { album = null; show() }
                else if (!gallery && !albumsTab && path.size > 1) { path.removeAt(path.size - 1); show() } else finish()
            }
        })

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

    private fun show() {
        val s = session ?: return
        title.text = when {
            albumsTab -> album?.second ?: getString(R.string.ddn_albums)
            gallery -> getString(R.string.ddn_gallery)
            path.size == 1 -> ui.brand()
            else -> path.last().second
        }
        // Files below the root: the path, each part a step back (tap = up to it).
        crumbs.visibility = if (!gallery && !albumsTab && path.size > 1) View.VISIBLE else View.GONE
        crumbs.text = path.dropLast(1).joinToString(" › ") { it.second }
        crumbs.setOnClickListener { if (path.size > 1) { path.removeAt(path.size - 1); show() } }
        status.text = s.lastError?.let { if (io.github.magiszonekk.discordrive.core.ErrorText.needsUpdate(it)) getString(R.string.ddn_err_update) else getString(R.string.ddn_offline, DdnErrors.bare(this, it)) } ?: ""
        status.visibility = if (status.text.isEmpty()) View.GONE else View.VISIBLE
        thread {
            if (albumsTab) {
                val open = album
                if (open != null) {
                    val items = s.albumMedia(open.first)
                    main.post { if (albumsTab && album == open) showGrid(s, items) }
                } else {
                    val albums = listOfNotNull(s.cameraAlbum(getString(R.string.ddn_album_camera))) + s.albums()
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

    private fun showList(s: DdnSession, items: List<IndexReplica.Child>) {
        list.layoutManager = LinearLayoutManager(this)
        list.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount() = items.size
            override fun onCreateViewHolder(p: ViewGroup, t: Int): RecyclerView.ViewHolder {
                val r = ui.listRow()
                r.view.setPaddingRelative(dp(12), dp(8), dp(8), dp(8))
                // Folders: a chevron at the end (files open the viewer).
                r.view.addView(ImageView(this@DdnActivity).apply { setImageResource(R.drawable.ic_cobalt_chevron); setColorFilter(getColor(R.color.cobalt_muted)) }, LinearLayout.LayoutParams(dp(18), dp(18)))
                r.view.tag = r
                return object : RecyclerView.ViewHolder(r.view) {}
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
                val c = items[i]
                val r = h.itemView.tag as CobaltUi.ListRow
                r.title.text = c.name
                r.sub.text = if (c.isFolder) getString(R.string.ddn_folder) else listOfNotNull(Formatter.formatShortFileSize(this@DdnActivity, c.size ?: 0), c.createdAt.takeIf { it > 0 }?.let { Ago.of(this@DdnActivity, it) }).joinToString(" · ")
                r.view.getChildAt(r.view.childCount - 1).visibility = if (c.isFolder) View.VISIBLE else View.GONE
                val type = ui.typeIcon(c.name, c.isFolder)
                ui.thumb(r, null, type)
                ui.folderTile(r, c.isFolder)
                r.icon.tag = null
                if (!c.isFolder && (DdnSession.isImage(c.name) || DdnSession.isVideo(c.name)) && c.manifestRef != null) {
                    r.icon.tag = c.manifestRef
                    val ref = c.manifestRef
                    DdnThumbs.pool.execute {
                        val b = runCatching { DdnThumbs.load(s, ref!!, 't', dp(88)) }.getOrNull()
                        main.post { if (r.icon.tag == ref && b != null) ui.thumb(r, b, type) }
                    }
                }
                r.view.setOnClickListener {
                    if (c.isFolder) { path += c.id to c.name; show() } else open(c, items.filter { !it.isFolder })
                }
                r.view.setOnLongClickListener { rowMenu(c); true }
            }
        }
        if (items.isEmpty()) note(getString(R.string.ddn_empty))
    }

    private fun showGrid(s: DdnSession, items: List<IndexReplica.Child>) {
        val cols = maxOf(3, resources.displayMetrics.widthPixels / dp(120))
        val cell = resources.displayMetrics.widthPixels / cols
        list.layoutManager = GridLayoutManager(this, cols)
        list.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount() = items.size
            override fun onCreateViewHolder(p: ViewGroup, t: Int): RecyclerView.ViewHolder {
                val f = FrameLayout(this@DdnActivity).apply { layoutParams = ViewGroup.LayoutParams(cell, cell); setPadding(1, 1, 1, 1) }
                f.addView(ImageView(this@DdnActivity).apply { scaleType = ImageView.ScaleType.CENTER_CROP; setBackgroundColor(getColor(R.color.cobalt_tile)) }, FrameLayout.LayoutParams(-1, -1))
                f.addView(ImageView(this@DdnActivity).apply { setImageResource(R.drawable.ic_cobalt_film); setColorFilter(Color.WHITE); elevation = dp(2).toFloat() }, FrameLayout.LayoutParams(dp(22), dp(22), Gravity.TOP or Gravity.END).apply { setMargins(0, dp(6), dp(6), 0) })
                return object : RecyclerView.ViewHolder(f) {}
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
                val c = items[i]
                val f = h.itemView as FrameLayout
                val img = f.getChildAt(0) as ImageView
                f.getChildAt(1).visibility = if (DdnSession.isVideo(c.name)) View.VISIBLE else View.GONE
                img.setImageDrawable(null)
                img.contentDescription = c.name
                DdnThumbs.into(s, c.manifestRef, img, cell) { img.setImageResource(R.drawable.ic_cobalt_image); img.setColorFilter(getColor(R.color.cobalt_muted)); img.scaleType = ImageView.ScaleType.CENTER_INSIDE }
                img.clearColorFilter()
                img.scaleType = ImageView.ScaleType.CENTER_CROP
                f.setOnClickListener { open(c, items) }
                f.setOnLongClickListener { rowMenu(c); true }
            }
        }
        if (items.isEmpty()) note(getString(if (gallery && DdnPrivate.all(this).isNotEmpty()) R.string.ddn_gallery_empty_private else R.string.ddn_gallery_empty))
    }

    /**
     * The albums: a cover (the newest photo) with the name and count; a private one shows a lock and no
     * cover and asks for the PIN to open. Long press: make private / not private.
     */
    private fun showAlbums(s: DdnSession, albums: List<IndexReplica.Album>) {
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
                if (!priv) DdnThumbs.into(s, a.cover.manifestRef, img, cell) { img.setImageResource(R.drawable.ic_cobalt_image); img.setColorFilter(getColor(R.color.cobalt_muted)); img.scaleType = ImageView.ScaleType.CENTER_INSIDE }
                img.scaleType = ImageView.ScaleType.CENTER_CROP
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

    /** The long-press entries of a row. The main thread: what refresh() learned about the instance (no network here). */
    private fun rowMenuItems(s: DdnSession, c: IndexReplica.Child, inGallery: Boolean): List<Pair<String, () -> Unit>> {
        val items = ArrayList<Pair<String, () -> Unit>>()
        if (s.gallerySpaceKnown) {
            if (inGallery) items += getString(R.string.ddn_to_drive) to { DdnPick.driveFolder(this, s) { to -> move(c, to, getString(R.string.ddn_moved_to_drive)) } }
            else if (c.isFolder || DdnSession.isImage(c.name) || DdnSession.isVideo(c.name)) items += getString(R.string.ddn_to_gallery) to { move(c, s.galleryRoot, getString(R.string.ddn_moved_to_gallery)) }
        }
        items += getString(R.string.safe_to_safe) to { DdnSafeActivity.moveIn(this, listOf(c)) { show() } }
        items += getString(R.string.ddn_to_trash) to { askTrash(c) }
        return items
    }

    /** A line under the bar (empty folder / Gallery): shown with the status line. */
    private fun note(t: String) {
        status.text = if (status.text.isNullOrEmpty()) t else "${status.text} · $t"
        status.visibility = View.VISIBLE
    }

    /**
     * Long press on a file or folder: Move to the Gallery (from the Drive) / Move to the Drive (from the Gallery)
     * when the account has the Gallery, and Move to trash.
     */
    private fun rowMenu(c: IndexReplica.Child) {
        val s = session ?: return
        val inGallery = gallery || albumsTab
        val items = rowMenuItems(s, c, inGallery)
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setTitle(c.name)
            .setItems(items.map { it.first }.toTypedArray()) { _, i -> items[i].second() }.show()
    }

    private fun albumMenu(a: IndexReplica.Album, priv: Boolean) {
        val s = session ?: return
        val items = ArrayList<Pair<String, () -> Unit>>()
        items += getString(if (priv) R.string.album_private_unmark_action else R.string.album_private_mark_action) to { togglePrivate(a, priv) }
        if (s.gallerySpaceKnown) items += getString(R.string.ddn_to_drive) to { DdnPick.driveFolder(this, s) { to -> move(IndexReplica.Child(a.id, a.name, "folder", null), to, getString(R.string.ddn_moved_to_drive)) } }
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setTitle(a.name)
            .setItems(items.map { it.first }.toTypedArray()) { _, i -> items[i].second() }.show()
    }

    private fun move(c: IndexReplica.Child, to: String, done: String) {
        val s = session ?: return
        thread {
            val r = runCatching { s.move(listOf(c.id), to) }
            main.post {
                r.onSuccess { toast(DdnViewerActivity.moveOutcome(this, it, done)) }.onFailure { note(DdnErrors.text(this, it)) }
                show()
            }
        }
    }

    /** Move to trash, asked first (30 days to restore, the trash is in Settings). */
    private fun askTrash(c: IndexReplica.Child) {
        val s = session ?: return
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(R.string.ddn_to_trash)
            .setMessage(getString(R.string.ddn_to_trash_ask, c.name))
            .setPositiveButton(R.string.ddn_to_trash) { _, _ ->
                thread {
                    val r = runCatching { s.moveToTrash(listOf(c.id)) }
                    main.post {
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
    /** The long-press menu of a row, as it would be shown (labels), built on the main thread like the real one. */
    internal fun rowMenuForTest(c: IndexReplica.Child): List<String> = session?.let { s -> rowMenuItems(s, c, gallery || albumsTab).map { it.first } } ?: emptyList()

    /** A cell of the grid shows a decoded picture (a thumbnail, not the type icon). */
    internal fun firstCellHasPicture(): Boolean = (0 until list.childCount).any { i ->
        val img = (list.getChildAt(i) as? FrameLayout)?.getChildAt(0) as? ImageView
        img?.drawable is android.graphics.drawable.BitmapDrawable
    }

    companion object {
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
