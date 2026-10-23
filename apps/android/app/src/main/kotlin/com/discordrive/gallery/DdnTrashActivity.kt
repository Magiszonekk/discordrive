package com.discordrive.gallery

import android.content.Context
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.DateUtils
import android.text.format.Formatter
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import io.github.magiszonekk.discordrive.core.IndexReplica
import io.github.magiszonekk.discordrive.core.TrashPolicy
import kotlin.concurrent.thread

/**
 * The account's trash: what was deleted (by any device), with the days left before it goes for good (30 days,
 * server time). Select items → Restore (back where they were, or "Odzyskane" when that folder is gone) or
 * Delete for good (asks first). Nothing here is undone by the phone alone: every action is an operation in the
 * account's log, the other devices see it.
 */
class DdnTrashActivity : AppCompatActivity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var list: RecyclerView
    private lateinit var status: TextView
    private lateinit var restore: Button
    private lateinit var purge: Button
    private lateinit var loading: android.widget.ProgressBar
    @Volatile private var loaded = false
    private var items: List<IndexReplica.Child> = emptyList()
    private val selected = LinkedHashSet<String>()
    private var serverNow = System.currentTimeMillis()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = dp(16)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(getColor(R.color.bg)) }
        root.addView(TextView(this).apply { text = getString(R.string.ddn_trash); textSize = 20f; setTypeface(typeface, Typeface.BOLD); setTextColor(getColor(R.color.text)); setPadding(pad, pad, pad, dp(4)) })
        status = TextView(this).apply { textSize = 12f; setTextColor(getColor(R.color.text_dim)); setPadding(pad, 0, pad, dp(8)); text = getString(R.string.ddn_trash_note) }
        root.addView(status)
        // Loading (the account is synced first): not an empty trash.
        loading = android.widget.ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { isIndeterminate = true }
        root.addView(loading, LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT))
        status.text = getString(R.string.ddn_trash_loading)
        list = RecyclerView(this).apply { layoutManager = LinearLayoutManager(this@DdnTrashActivity) }
        root.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END; setPadding(dp(8), dp(4), dp(8), dp(8)) }
        restore = Button(this).apply { text = getString(R.string.ddn_trash_restore); isEnabled = false; setOnClickListener { act(restore = true) } }
        purge = Button(this).apply { text = getString(R.string.ddn_trash_purge); isEnabled = false; setOnClickListener { confirmPurge() } }
        bar.addView(restore)
        bar.addView(purge)
        root.addView(bar)
        setContentView(root)
        Insets.apply(root)
        load()
    }

    private fun load() {
        thread {
            val s = DdnSession.get(this) ?: run { main.post { finish() }; return@thread }
            runCatching { s.refresh() }
            serverNow = runCatching { s.sync.api.gcStatus().now }.getOrDefault(System.currentTimeMillis())
            val t = s.trash()
            main.post { items = t; loaded = true; selected.retainAll(t.map { it.id }.toSet()); show() }
        }
    }

    private fun show() {
        loading.visibility = if (loaded) android.view.View.GONE else android.view.View.VISIBLE
        status.text = if (!loaded) getString(R.string.ddn_trash_loading) else if (items.isEmpty()) getString(R.string.ddn_trash_empty) else getString(R.string.ddn_trash_note)
        restore.isEnabled = selected.isNotEmpty()
        purge.isEnabled = selected.isNotEmpty()
        list.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount() = items.size
            override fun onCreateViewHolder(p: ViewGroup, t: Int) = object : RecyclerView.ViewHolder(row()) {}
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
                val c = items[i]
                val v = h.itemView as LinearLayout
                val box = v.getChildAt(0) as CheckBox
                val icon = v.getChildAt(1) as ImageView
                val text = v.getChildAt(2) as LinearLayout
                icon.setImageResource(if (c.isFolder) R.drawable.ic_cloud_done else R.drawable.ic_photo)
                (text.getChildAt(0) as TextView).text = c.name
                val left = TrashPolicy.daysLeft(c.trashedAt ?: serverNow, serverNow)
                val what = if (c.isFolder) getString(R.string.ddn_folder) else Formatter.formatShortFileSize(this@DdnTrashActivity, c.size ?: 0)
                val whenTrashed = c.trashedAt?.let { DateUtils.getRelativeTimeSpanString(it, serverNow, DateUtils.MINUTE_IN_MILLIS) } ?: ""
                (text.getChildAt(1) as TextView).text = getString(R.string.ddn_trash_row, what, whenTrashed, resources.getQuantityString(R.plurals.ddn_trash_days, left, left))
                box.setOnCheckedChangeListener(null)
                box.isChecked = c.id in selected
                box.setOnCheckedChangeListener { _, on -> if (on) selected += c.id else selected -= c.id; restore.isEnabled = selected.isNotEmpty(); purge.isEnabled = selected.isNotEmpty() }
                v.setOnClickListener { box.isChecked = !box.isChecked }
            }
        }
    }

    private fun confirmPurge() {
        val n = selected.size
        AlertDialog.Builder(this)
            .setTitle(R.string.ddn_trash_purge)
            .setMessage(resources.getQuantityString(R.plurals.ddn_trash_purge_ask, n, n))
            .setPositiveButton(R.string.ddn_trash_purge) { _, _ -> act(restore = false) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun act(restore: Boolean) {
        val ids = selected.toList()
        if (ids.isEmpty()) return
        loaded = false
        loading.visibility = android.view.View.VISIBLE
        this.restore.isEnabled = false
        purge.isEnabled = false
        thread {
            val r = runCatching { DdnSession.get(this)!!.let { s -> if (restore) s.restore(ids) else s.purge(ids) } }
            main.post {
                r.onSuccess { outcome ->
                    Toast.makeText(this, if (outcome == "applied") getString(if (restore) R.string.ddn_trash_restored else R.string.ddn_trash_purged) else getString(R.string.ddn_trash_not_done, outcome), Toast.LENGTH_LONG).show()
                    selected.clear()
                }.onFailure { Toast.makeText(this, getString(R.string.ddn_error, it.message), Toast.LENGTH_LONG).show() }
                load()
            }
        }
    }

    private fun row(): LinearLayout {
        val v = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(8), dp(6), dp(16), dp(6))
            layoutParams = ViewGroup.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT); isClickable = true
            setBackgroundResource(android.R.drawable.list_selector_background)
        }
        v.addView(CheckBox(this))
        v.addView(ImageView(this).apply { setColorFilter(getColor(R.color.text_dim)) }, LinearLayout.LayoutParams(dp(36), dp(36)))
        val t = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, 0, 0) }
        t.addView(TextView(this).apply { textSize = 15f; setTextColor(getColor(R.color.text)); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE })
        t.addView(TextView(this).apply { textSize = 12f; setTextColor(getColor(R.color.text_dim)) })
        v.addView(t, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        return v
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // ── for the instrumentation test ──
    internal fun countForTest(): Int = items.size
    internal fun loadingShownForTest(): Boolean = loading.visibility == android.view.View.VISIBLE
    internal fun selectForTest(id: String) { selected += id; show() }
    internal fun actForTest(restore: Boolean) = act(restore)

    companion object {
        fun open(c: Context) = c.startActivity(android.content.Intent(c, DdnTrashActivity::class.java))
    }
}
