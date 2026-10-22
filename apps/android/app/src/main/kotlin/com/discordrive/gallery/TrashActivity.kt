package com.discordrive.gallery

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.discordrive.gallery.api.FileDto
import com.discordrive.gallery.crypto.DdvCrypto
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.snackbar.Snackbar
import kotlin.concurrent.thread

/**
 * Trash, Pixel-style: deleted files wait here ~30 days (server auto-purges),
 * each can be restored or permanently deleted; "empty trash" purges all.
 */
class TrashActivity : AppCompatActivity() {

    data class Entry(val file: FileDto, val name: String, val asset: MediaAsset?)

    private lateinit var adapter: TrashAdapter
    private lateinit var progress: LinearProgressIndicator
    private lateinit var emptyView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_trash)
        Insets.apply(findViewById(R.id.trashRoot))

        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        toolbar.setNavigationOnClickListener { finish() }
        toolbar.inflateMenu(R.menu.menu_trash)
        toolbar.setOnMenuItemClickListener { item ->
            if (item.itemId == R.id.action_empty_trash) confirmEmptyTrash()
            true
        }

        progress = findViewById(R.id.trashProgress)
        emptyView = findViewById(R.id.trashEmpty)
        adapter = TrashAdapter { entry -> showEntryActions(entry) }
        findViewById<RecyclerView>(R.id.trashList).apply {
            layoutManager = LinearLayoutManager(this@TrashActivity)
            adapter = this@TrashActivity.adapter
        }

        refresh()
    }

    private fun refresh() {
        val client = SessionManager.client ?: return
        val filesKey = SessionManager.filesKey ?: return
        progress.visibility = View.VISIBLE

        thread {
            try {
                val db = AppDb(this)
                val assetsById = MediaScanner(this).scanAll().associateBy { it.id }
                val entries = client.trashedFiles().map { file ->
                    val name = runCatching {
                        val rootFek = DdvCrypto.unwrapRootFek(file.wrappedFEK, filesKey)
                        file.encryptedName?.let { DdvCrypto.decryptMeta(rootFek, it) }
                    }.getOrNull() ?: file.id
                    Entry(file, name, db.assetIdForFile(file.id)?.let { assetsById[it] })
                }
                runOnUiThread {
                    progress.visibility = View.GONE
                    emptyView.visibility = if (entries.isEmpty()) View.VISIBLE else View.GONE
                    adapter.submit(entries)
                }
            } catch (e: Exception) {
                runOnUiThread {
                    progress.visibility = View.GONE
                    Snackbar.make(findViewById(R.id.trashRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun showEntryActions(entry: Entry) {
        MaterialAlertDialogBuilder(this)
            .setTitle(entry.name)
            .setItems(
                arrayOf(getString(R.string.trash_restore), getString(R.string.trash_purge)),
            ) { _, which ->
                when (which) {
                    0 -> restore(entry)
                    1 -> confirmPurge(entry)
                }
            }
            .show()
    }

    private fun restore(entry: Entry) {
        val client = SessionManager.client ?: return
        thread {
            try {
                client.restoreFile(entry.file.id)
                runOnUiThread {
                    Snackbar.make(findViewById(R.id.trashRoot), getString(R.string.trash_restored, entry.name), Snackbar.LENGTH_LONG).show()
                    refresh()
                }
            } catch (e: Exception) {
                runOnUiThread { Snackbar.make(findViewById(R.id.trashRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show() }
            }
        }
    }

    private fun confirmPurge(entry: Entry) {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.trash_purge)
            .setMessage(getString(R.string.trash_purge_confirm, entry.name))
            .setPositiveButton(R.string.trash_purge) { _, _ ->
                val client = SessionManager.client ?: return@setPositiveButton
                thread {
                    try {
                        client.purgeFile(entry.file.id)
                        AppDb(this).forgetFile(entry.file.id)
                        runOnUiThread { refresh() }
                    } catch (e: Exception) {
                        runOnUiThread { Snackbar.make(findViewById(R.id.trashRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show() }
                    }
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun confirmEmptyTrash() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.trash_empty_action)
            .setMessage(R.string.trash_empty_confirm)
            .setPositiveButton(R.string.trash_empty_action) { _, _ ->
                val client = SessionManager.client ?: return@setPositiveButton
                thread {
                    try {
                        val db = AppDb(this)
                        val ids = client.trashedFiles().map { it.id }
                        val purged = client.emptyTrash()
                        ids.forEach(db::forgetFile)
                        runOnUiThread {
                            Snackbar.make(findViewById(R.id.trashRoot), getString(R.string.trash_emptied, purged), Snackbar.LENGTH_LONG).show()
                            refresh()
                        }
                    } catch (e: Exception) {
                        runOnUiThread { Snackbar.make(findViewById(R.id.trashRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show() }
                    }
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    inner class TrashAdapter(private val onClick: (Entry) -> Unit) : RecyclerView.Adapter<TrashAdapter.Holder>() {

        private var entries: List<Entry> = emptyList()

        fun submit(newEntries: List<Entry>) {
            entries = newEntries
            notifyDataSetChanged()
        }

        inner class Holder(view: View) : RecyclerView.ViewHolder(view) {
            val thumb: ImageView = view.findViewById(R.id.resultThumb)
            val name: TextView = view.findViewById(R.id.resultName)
            val description: TextView = view.findViewById(R.id.resultDescription)
            val tags: TextView = view.findViewById(R.id.resultTags)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_search_result, parent, false))

        override fun getItemCount() = entries.size

        override fun onBindViewHolder(holder: Holder, position: Int) {
            val entry = entries[position]
            holder.name.text = entry.name
            holder.description.text = getString(
                R.string.trash_deleted_at,
                entry.file.deletedAt?.take(10) ?: "—",
            )
            holder.tags.text = ""
            holder.thumb.setImageDrawable(null)
            entry.asset?.let { ThumbLoader.load(holder.itemView.context, it, holder.thumb, 192) }
            holder.itemView.setOnClickListener { onClick(entry) }
        }
    }
}
