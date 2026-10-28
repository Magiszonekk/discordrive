package com.discordrive.gallery

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.text.format.Formatter
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import io.github.magiszonekk.discordrive.core.IndexReplica
import io.github.magiszonekk.discordrive.core.Search
import kotlin.concurrent.thread

/**
 * Search in the account (Gallery and Files): by name, date ("2024", "2024-05", "2024-05-17") and the AI
 * descriptions (what is on the photo, tags, the text on it). Works from the phone's own table: nothing is
 * downloaded per search. Files in private albums are not shown. Media results are a grid of thumbnails,
 * other files a tile with the name and size; a tap opens the file as in the Gallery.
 */
class DdnSearchActivity : AppCompatActivity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var box: EditText
    private lateinit var info: TextView
    private lateinit var grid: RecyclerView
    @Volatile private var items: List<Pair<IndexReplica.Child, Search.Item>>? = null
    private var shown: List<IndexReplica.Child> = emptyList()
    private var seq = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        val ui = CobaltUi(this)
        // A list screen: the bar (back, "Szukaj"), the search field, a note (counts), the grid of results.
        val root = ui.screen(R.string.ddn_search, scroll = false)
        val (field, edit) = ui.field(R.string.ddn_search, hint = getString(R.string.ddn_search_hint))
        box = edit.apply { isSingleLine = true; imeOptions = EditorInfo.IME_ACTION_SEARCH }
        // The label above the field repeats the bar's title: the field alone (its hint says what to type).
        (field as ViewGroup).getChildAt(0).visibility = View.GONE
        (field.getChildAt(1) as com.google.android.material.textfield.TextInputLayout).apply {
            startIconDrawable = getDrawable(R.drawable.ic_cobalt_search)
            setStartIconTintList(android.content.res.ColorStateList.valueOf(getColor(R.color.cobalt_muted)))
            endIconMode = com.google.android.material.textfield.TextInputLayout.END_ICON_CLEAR_TEXT
        }
        root.addView(field, ui.lp(top = 4))
        info = ui.note("").apply { setPadding(ui.dp(4), 0, ui.dp(4), 0) }
        root.addView(info, ui.lp(top = 8))
        grid = RecyclerView(this).apply { clipToPadding = false }
        // The grid reaches the screen's edges (the column pads 16dp).
        root.addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f).apply { topMargin = ui.dp(8); marginStart = -ui.dp(16); marginEnd = -ui.dp(16) })
        box.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) { val n = ++seq; main.postDelayed({ if (n == seq) search() }, 250) }
        })
        intent.getStringExtra(QUERY)?.let { box.setText(it) }
        load()
    }

    /** The account's files with their descriptions (once per screen; the table is filled in the background). */
    private fun load() {
        info.text = getString(R.string.ddn_search_loading)
        thread {
            val s = DdnSession.get(this) ?: return@thread
            val files = s.allFiles(DdnPrivate.all(this))
            val recs = DdnAi.Db(this).records(s.acct.accountId)
            fun build(r: Map<String, io.github.magiszonekk.discordrive.core.Describe.Record>) {
                // The date a search matches: when the content was made (manifest), else when it was uploaded.
                val taken = DdnAi.Db(this).taken(s.acct.accountId)
                items = files.map { it to Search.Item(it.id, it.name, it.manifestRef?.let(taken::get) ?: it.createdAt, it.manifestRef?.let(r::get)) }
                val described = items!!.count { it.second.record != null }
                main.post { info.text = getString(R.string.ddn_search_ready, files.size, described); search() }
            }
            build(recs)
            // Descriptions other devices stored (not in this phone's table yet): a few reads, then the list again.
            val before = DdnAi.Db(this).taken(s.acct.accountId).size
            val n = runCatching { DdnAi.syncDescriptions(this, s, budget = 60) }.getOrDefault(0)
            if (n > 0 || DdnAi.Db(this).taken(s.acct.accountId).size != before) build(DdnAi.Db(this).records(s.acct.accountId))
        }
    }

    /**
     * Back from the viewer (a file moved to the trash, the Safe, a private album there): the results drop what
     * is no longer in the account's files, without reading the descriptions again.
     */
    override fun onRestart() {
        super.onRestart()
        refreshForTest = false
        val have = items ?: return
        thread {
            val s = DdnSession.get(this) ?: return@thread
            val alive = runCatching { s.allFiles(DdnPrivate.all(this)).associateBy { it.id } }.getOrNull() ?: return@thread
            val now = have.mapNotNull { (c, item) -> alive[c.id]?.let { it to item } }
            main.post { items = now; seq++; search(); refreshForTest = true }
        }
    }

    private fun search() {
        val all = items ?: return
        val q = box.text.toString()
        if (q.isBlank()) { show(emptyList()); return }
        val n = seq
        thread {
            val byId = all.associate { it.first.id to it.first }
            val hits = Search.run(all.map { it.second }, q).mapNotNull { byId[it.id] }
            main.post { if (n == seq) { show(hits); info.text = getString(R.string.ddn_search_found, hits.size) } }
        }
    }

    private fun show(list: List<IndexReplica.Child>) {
        shown = list
        val s = DdnSession.get(this) ?: return
        val cols = maxOf(3, resources.displayMetrics.widthPixels / dp(120))
        val cell = resources.displayMetrics.widthPixels / cols
        grid.layoutManager = GridLayoutManager(this, cols)
        grid.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount() = list.size
            override fun onCreateViewHolder(p: ViewGroup, t: Int): RecyclerView.ViewHolder {
                val f = FrameLayout(this@DdnSearchActivity).apply { layoutParams = ViewGroup.LayoutParams(cell, cell); setPadding(1, 1, 1, 1) }
                f.addView(ImageView(this@DdnSearchActivity).apply { scaleType = ImageView.ScaleType.CENTER_CROP; setBackgroundColor(getColor(R.color.cobalt_tile)) }, FrameLayout.LayoutParams(-1, -1))
                f.addView(ImageView(this@DdnSearchActivity).apply { setImageResource(R.drawable.ic_play); setColorFilter(Color.WHITE) }, FrameLayout.LayoutParams(dp(28), dp(28), Gravity.CENTER))
                f.addView(TextView(this@DdnSearchActivity).apply { androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowSub); setTextColor(getColor(R.color.cobalt_ink)); maxLines = 3; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE; setPadding(dp(8), dp(6), dp(8), dp(8)) }, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
                return object : RecyclerView.ViewHolder(f) {}
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
                val c = list[i]
                val f = h.itemView as FrameLayout
                val img = f.getChildAt(0) as ImageView
                val media = DdnSession.isImage(c.name) || DdnSession.isVideo(c.name)
                f.getChildAt(1).visibility = if (DdnSession.isVideo(c.name)) View.VISIBLE else View.GONE
                val label = f.getChildAt(2) as TextView
                label.visibility = if (media) View.GONE else View.VISIBLE
                label.text = c.name + "\n" + Formatter.formatShortFileSize(this@DdnSearchActivity, c.size ?: 0)
                img.setImageDrawable(null)
                img.contentDescription = c.name
                img.scaleType = ImageView.ScaleType.CENTER_CROP
                img.clearColorFilter()
                img.setPadding(0, 0, 0, 0)
                // Media: the thumbnail (the type icon until it comes); other files: their type icon above the name.
                fun typeIcon() { img.setImageResource(CobaltUi.typeIconOf(c.name, false)); img.setColorFilter(getColor(R.color.cobalt_muted)); img.scaleType = ImageView.ScaleType.CENTER_INSIDE; img.setPadding(0, 0, 0, if (media) 0 else cell / 4) }
                if (media) DdnThumbs.into(s, c.manifestRef, img, cell) { typeIcon() } else typeIcon()
                f.setOnClickListener { open(c) }
            }
        }
    }

    private fun open(c: IndexReplica.Child) {
        // As the Files list: the viewer pages through the results (it opens other files too).
        DdnViewerActivity.pending = shown
        startActivity(Intent(this, DdnViewerActivity::class.java).putExtra("id", c.id))
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    internal fun queryForTest(q: String) = box.setText(q)
    internal fun resultsForTest(): List<String> = shown.map { it.name }
    internal fun readyForTest(): Boolean = items != null
    @Volatile internal var refreshForTest = false

    companion object {
        const val QUERY = "q"
    }
}
