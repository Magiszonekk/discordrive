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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DdnSessionDirs.cacheDir = cacheDir
        gallery = intent.getStringExtra(START) == "gallery" || intent.component?.className?.endsWith(".DdnGallery") == true
        path += "root" to getString(R.string.ddn_files)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(getColor(R.color.bg)) }
        val pad = dp(16)
        title = TextView(this).apply { textSize = 20f; setTypeface(typeface, Typeface.BOLD); setTextColor(getColor(R.color.text)); setPadding(pad, pad, pad, dp(4)) }
        status = TextView(this).apply { textSize = 12f; setTextColor(getColor(R.color.text_dim)); setPadding(pad, 0, pad, dp(8)) }
        list = RecyclerView(this)
        swipe = SwipeRefreshLayout(this).apply { addView(list); setOnRefreshListener { refresh() } }
        nav = BottomNavigationView(this).apply {
            menu.add(0, 1, 0, R.string.ddn_files).setIcon(R.drawable.ic_cloud_done)
            menu.add(0, 2, 1, R.string.ddn_gallery).setIcon(R.drawable.ic_photo)
            menu.add(0, 3, 2, R.string.ddn_albums).setIcon(R.drawable.ic_albums)
            selectedItemId = if (gallery) 2 else 1
            setOnItemSelectedListener { gallery = it.itemId == 2; albumsTab = it.itemId == 3; album = null; show(); true }
        }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        bar.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_search); setColorFilter(getColor(R.color.text)); contentDescription = getString(R.string.ddn_search)
            setPadding(dp(12), dp(12), dp(12), dp(12)); setOnClickListener { startActivity(Intent(this@DdnActivity, DdnSearchActivity::class.java)) }
        })
        // Upload a file into the open folder (Files) / the automatic copy settings.
        bar.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_cloud_pending); setColorFilter(getColor(R.color.text)); contentDescription = getString(R.string.ddn_upload)
            setPadding(dp(12), dp(12), dp(12), dp(12)); setOnClickListener { pick.launch(arrayOf("*/*")) }
        })
        bar.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_settings); setColorFilter(getColor(R.color.text)); contentDescription = getString(R.string.ddn_settings)
            setPadding(dp(12), dp(12), dp(12), dp(12)); setOnClickListener { startActivity(Intent(this@DdnActivity, DdnSettingsActivity::class.java)) }
        })
        root.addView(bar)
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
            val s = runCatching { DdnSession.get(this) }.getOrElse { e -> main.post { status.text = getString(R.string.ddn_error, e.message) }; return@thread }
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
            albumsTab && album != null && session?.gallerySpace == true -> album!!.first
            gallery || albumsTab -> null
            else -> path.last().first
        }
        thread {
            val r = runCatching { DdnUploads.queue(this, uris, folder) }
            main.post {
                r.onSuccess { android.widget.Toast.makeText(this, plq(R.plurals.ddn_up_queued, it, it), android.widget.Toast.LENGTH_LONG).show(); watchUploads() }
                    .onFailure { status.text = getString(R.string.ddn_error, it.message) }
            }
        }
    }

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
            s.refresh()
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
            else -> path.last().second
        }
        status.text = buildString {
            append(getString(R.string.ddn_status, s.acct.deviceName, s.headSeq, s.engineName))
            s.lastError?.let { append(" · ").append(getString(R.string.ddn_offline, it)) }
        }
        thread {
            if (albumsTab) {
                val open = album
                if (open != null) {
                    val items = s.albumMedia(open.first)
                    main.post { if (albumsTab && album == open) showGrid(s, items) }
                } else {
                    val albums = s.albums()
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
            override fun onCreateViewHolder(p: ViewGroup, t: Int) = object : RecyclerView.ViewHolder(row()) {}
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
                val c = items[i]
                val v = h.itemView as LinearLayout
                val icon = v.getChildAt(0) as ImageView
                val text = v.getChildAt(1) as LinearLayout
                (text.getChildAt(0) as TextView).text = c.name
                (text.getChildAt(1) as TextView).text = if (c.isFolder) getString(R.string.ddn_folder) else Formatter.formatShortFileSize(this@DdnActivity, c.size ?: 0)
                icon.tag = null
                icon.setImageResource(if (c.isFolder) R.drawable.ic_cloud_done else if (DdnSession.isVideo(c.name)) R.drawable.ic_play else R.drawable.ic_photo)
                icon.scaleType = ImageView.ScaleType.CENTER_INSIDE
                if (!c.isFolder) DdnThumbs.into(s, c.manifestRef, icon, dp(48)) { }.also { icon.scaleType = ImageView.ScaleType.CENTER_CROP }
                v.setOnClickListener {
                    if (c.isFolder) { path += c.id to c.name; show() } else open(c, items.filter { !it.isFolder })
                }
                v.setOnLongClickListener { askTrash(c); true }
            }
        }
        if (items.isEmpty()) status.append(" · " + getString(R.string.ddn_empty))
    }

    private fun showGrid(s: DdnSession, items: List<IndexReplica.Child>) {
        val cols = maxOf(3, resources.displayMetrics.widthPixels / dp(120))
        val cell = resources.displayMetrics.widthPixels / cols
        list.layoutManager = GridLayoutManager(this, cols)
        list.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount() = items.size
            override fun onCreateViewHolder(p: ViewGroup, t: Int): RecyclerView.ViewHolder {
                val f = FrameLayout(this@DdnActivity).apply { layoutParams = ViewGroup.LayoutParams(cell, cell); setPadding(1, 1, 1, 1) }
                f.addView(ImageView(this@DdnActivity).apply { scaleType = ImageView.ScaleType.CENTER_CROP; setBackgroundColor(getColor(R.color.surface)) }, FrameLayout.LayoutParams(-1, -1))
                f.addView(ImageView(this@DdnActivity).apply { setImageResource(R.drawable.ic_play); setColorFilter(Color.WHITE) }, FrameLayout.LayoutParams(dp(28), dp(28), Gravity.CENTER))
                return object : RecyclerView.ViewHolder(f) {}
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
                val c = items[i]
                val f = h.itemView as FrameLayout
                val img = f.getChildAt(0) as ImageView
                f.getChildAt(1).visibility = if (DdnSession.isVideo(c.name)) View.VISIBLE else View.GONE
                img.setImageDrawable(null)
                img.contentDescription = c.name
                DdnThumbs.into(s, c.manifestRef, img, cell) { img.setImageResource(R.drawable.ic_photo); img.scaleType = ImageView.ScaleType.CENTER_INSIDE }
                img.scaleType = ImageView.ScaleType.CENTER_CROP
                f.setOnClickListener { open(c, items) }
                f.setOnLongClickListener { askTrash(c); true }
            }
        }
        if (items.isEmpty()) status.append(" · " + getString(if (gallery && DdnPrivate.all(this).isNotEmpty()) R.string.ddn_gallery_empty_private else R.string.ddn_gallery_empty))
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
                box.addView(ImageView(this@DdnActivity).apply { scaleType = ImageView.ScaleType.CENTER_CROP; setBackgroundColor(getColor(R.color.surface)) }, FrameLayout.LayoutParams(-1, -1))
                box.addView(ImageView(this@DdnActivity).apply { setImageResource(R.drawable.ic_lock); setColorFilter(getColor(R.color.text_dim)) }, FrameLayout.LayoutParams(dp(36), dp(36), Gravity.CENTER))
                v.addView(box, LinearLayout.LayoutParams(-1, cell - dp(8)))
                v.addView(TextView(this@DdnActivity).apply { textSize = 14f; setTextColor(getColor(R.color.text)); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(dp(2), dp(4), 0, 0) })
                v.addView(TextView(this@DdnActivity).apply { textSize = 12f; setTextColor(getColor(R.color.text_dim)); setPadding(dp(2), 0, 0, 0) })
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
                if (!priv) DdnThumbs.into(s, a.cover.manifestRef, img, cell) { img.setImageResource(R.drawable.ic_photo); img.scaleType = ImageView.ScaleType.CENTER_INSIDE }
                img.scaleType = ImageView.ScaleType.CENTER_CROP
                (v.getChildAt(1) as TextView).text = a.name
                (v.getChildAt(2) as TextView).text = if (priv) getString(R.string.ddn_album_private) else plq(R.plurals.ddn_album_count, a.count, a.count)
                v.setOnClickListener { if (priv) PrivateUnlock.unlock(this@DdnActivity) { openAlbum(a) } else openAlbum(a) }
                v.setOnLongClickListener { togglePrivate(a, priv); true }
            }
        }
        if (list.isEmpty()) status.append(" · " + getString(R.string.ddn_albums_empty))
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

    /** Long press: to the trash (30 days to restore, the trash is in Settings). */
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
                            .onFailure { status.text = getString(R.string.ddn_error, it.message) }
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

    private fun row(): LinearLayout {
        val v = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(8), dp(16), dp(8))
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            isClickable = true
            setBackgroundResource(android.R.drawable.list_selector_background)
        }
        v.addView(ImageView(this).apply { setColorFilter(null) }, LinearLayout.LayoutParams(dp(48), dp(48)))
        val t = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), 0, 0, 0) }
        t.addView(TextView(this).apply { textSize = 15f; setTextColor(getColor(R.color.text)); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE })
        t.addView(TextView(this).apply { textSize = 12f; setTextColor(getColor(R.color.text_dim)) })
        v.addView(t, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        return v
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // ── for the instrumentation test (BrowseUiTest) ──
    internal fun findRecycler(): RecyclerView? = if (::list.isInitialized) list else null
    internal fun openFolderForTest(id: String, name: String) { gallery = false; nav.selectedItemId = 1; path += id to name; show() }
    internal fun showGalleryForTest() { nav.selectedItemId = 2 }
    internal fun showAlbumsForTest() { nav.selectedItemId = 3 }
    internal fun openAlbumForTest(id: String, name: String) { album = id to name; show() }
    internal fun isDrawn(): Boolean = list.isLaidOut && list.childCount > 0

    /** A cell of the grid shows a decoded picture (a thumbnail, not the type icon). */
    internal fun firstCellHasPicture(): Boolean = (0 until list.childCount).any { i ->
        val img = (list.getChildAt(i) as? FrameLayout)?.getChildAt(0) as? ImageView
        img?.drawable is android.graphics.drawable.BitmapDrawable
    }

    companion object {
        const val START = "start"
    }
}

/** The "Galeria" launcher icon: the same screen starting in the Gallery, in its own task (its own card in Recents). */
class DdnGallery : DdnActivity()
