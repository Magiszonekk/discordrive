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
            selectedItemId = if (gallery) 2 else 1
            setOnItemSelectedListener { gallery = it.itemId == 2; show(); true }
        }
        root.addView(title)
        root.addView(status)
        root.addView(swipe, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(nav)
        setContentView(root)
        Insets.apply(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Back from a folder goes up; from the root of this icon's view it closes only this task.
                if (!gallery && path.size > 1) { path.removeAt(path.size - 1); show() } else finish()
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
            }
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
        title.text = if (gallery) getString(R.string.ddn_gallery) else path.last().second
        status.text = buildString {
            append(getString(R.string.ddn_status, s.acct.deviceName, s.headSeq, s.engineName))
            s.lastError?.let { append(" · ").append(getString(R.string.ddn_offline, it)) }
        }
        thread {
            if (gallery) {
                val items = s.media(5000, null)
                main.post { if (gallery) showGrid(s, items) }
            } else {
                val folder = path.last().first
                val items = s.children(folder)
                main.post { if (!gallery && path.last().first == folder) showList(s, items) }
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
            }
        }
        if (items.isEmpty()) status.append(" · " + getString(R.string.ddn_gallery_empty))
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
