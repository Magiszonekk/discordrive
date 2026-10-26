package com.discordrive.gallery

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.DateUtils
import android.text.format.Formatter
import android.view.ViewGroup
import android.widget.CheckBox
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
    private lateinit var restore: com.google.android.material.button.MaterialButton
    private lateinit var purge: com.google.android.material.button.MaterialButton
    private lateinit var ui: CobaltUi
    private lateinit var loading: android.view.View
    @Volatile private var loaded = false
    /** Tests: the screen opened in its loading state (a load may be done before a test can look). */
    @Volatile private var loadingAtStart = false
    private var items: List<IndexReplica.Child> = emptyList()
    private val selected = LinkedHashSet<String>()
    private var serverNow = System.currentTimeMillis()

    override fun onCreate(savedInstanceState: Bundle?) {
        keepOpenForTest = intent.getBooleanExtra(KEEP_OPEN_FOR_TEST, false)
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        ui = CobaltUi(this)
        // One heading (the bar), the note, the list, the actions at the bottom.
        val root = ui.screen(R.string.ddn_trash, scroll = false)
        status = ui.note(getString(R.string.ddn_trash_loading))
        root.addView(status, ui.lp(top = 4))
        // Loading (the account is synced first): not an empty trash.
        loading = com.google.android.material.progressindicator.LinearProgressIndicator(this).apply { isIndeterminate = true }
        root.addView(loading, ui.lp(top = 8))
        loadingAtStart = loading.visibility == android.view.View.VISIBLE
        list = RecyclerView(this).apply { layoutManager = LinearLayoutManager(this@DdnTrashActivity); clipToPadding = false }
        root.addView(list, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = dp(8) })
        restore = ui.button(R.string.ddn_trash_restore, CobaltUi.Kind.TONAL) { act(restore = true) }.apply { isEnabled = false }
        purge = ui.button(R.string.ddn_trash_purge, CobaltUi.Kind.DANGER) { confirmPurge() }.apply { isEnabled = false }
        ui.actionBar(root, restore, purge)
        load()
    }

    private fun load() {
        thread {
            // No account: nothing to show (tests of the screen's look keep it open, empty).
            val s = DdnSession.get(this) ?: run { main.post { if (keepOpenForTest) { loaded = true; show() } else finish() }; return@thread }
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
            override fun onCreateViewHolder(p: ViewGroup, t: Int): RecyclerView.ViewHolder {
                val r = ui.listRow(com.google.android.material.checkbox.MaterialCheckBox(this@DdnTrashActivity))
                return object : RecyclerView.ViewHolder(r.view) {}.also { it.itemView.tag = r }
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
                val c = items[i]
                val r = h.itemView.tag as CobaltUi.ListRow
                val v = r.view
                val box = v.getChildAt(0) as CheckBox
                r.icon.setImageResource(if (c.isFolder) R.drawable.ic_albums else R.drawable.ic_photo)
                r.title.text = c.name
                val left = TrashPolicy.daysLeft(c.trashedAt ?: serverNow, serverNow)
                val what = if (c.isFolder) getString(R.string.ddn_folder) else Formatter.formatShortFileSize(this@DdnTrashActivity, c.size ?: 0)
                val whenTrashed = c.trashedAt?.let { DateUtils.getRelativeTimeSpanString(it, serverNow, DateUtils.MINUTE_IN_MILLIS) } ?: ""
                r.sub.text = getString(R.string.ddn_trash_row, what, whenTrashed, plq(R.plurals.ddn_trash_days, left, left))
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
            .setMessage(plq(R.plurals.ddn_trash_purge_ask, n, n))
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

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // ── for the instrumentation test ──
    /** Tests of the look: without an account the screen stays open (empty) instead of closing. */
    internal var keepOpenForTest = false
    internal fun countForTest(): Int = items.size
    internal fun loadingShownForTest(): Boolean = loading.visibility == android.view.View.VISIBLE
    internal fun openedLoadingForTest(): Boolean = loadingAtStart && status.text.isNotEmpty()
    internal fun selectForTest(id: String) { selected += id; show() }
    internal fun actForTest(restore: Boolean) = act(restore)

    companion object {
        internal const val KEEP_OPEN_FOR_TEST = "keepOpenForTest"
        fun open(c: Context) = c.startActivity(android.content.Intent(c, DdnTrashActivity::class.java))
    }
}
