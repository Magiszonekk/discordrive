package com.discordrive.gallery

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.discordrive.gallery.api.EnrichmentEngine
import com.discordrive.gallery.api.EnrichmentRecord
import com.discordrive.gallery.crypto.DdvCrypto
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.progressindicator.LinearProgressIndicator
import kotlin.concurrent.thread

/** Client-side search over decrypted AI enrichments. */
class SearchActivity : AppCompatActivity() {

    data class Result(val fileId: String, val name: String, val record: EnrichmentRecord, val asset: MediaAsset?)

    private lateinit var adapter: ResultAdapter
    private lateinit var progress: LinearProgressIndicator
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_search)
        Insets.apply(findViewById(R.id.searchRoot))

        findViewById<MaterialToolbar>(R.id.toolbar).setNavigationOnClickListener { finish() }
        progress = findViewById(R.id.searchProgress)
        status = findViewById(R.id.searchStatus)

        adapter = ResultAdapter { result ->
            result.asset?.let {
                startActivity(
                    Intent(this, ViewerActivity::class.java)
                        .putExtra("assetId", it.id)
                        .putExtra("bucket", it.bucketName),
                )
            }
        }
        findViewById<RecyclerView>(R.id.results).apply {
            layoutManager = LinearLayoutManager(this@SearchActivity)
            adapter = this@SearchActivity.adapter
        }

        val queryInput = findViewById<EditText>(R.id.queryInput)
        queryInput.setOnEditorActionListener { _, actionId, event ->
            val isSubmit = actionId == EditorInfo.IME_ACTION_SEARCH ||
                actionId == EditorInfo.IME_ACTION_DONE ||
                event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER
            if (isSubmit) {
                search(queryInput.text.toString())
                true
            } else false
        }
        queryInput.requestFocus()
    }

    private fun search(query: String) {
        if (query.isBlank()) return
        val client = SessionManager.client ?: return
        val filesKey = SessionManager.filesKey ?: return
        progress.visibility = View.VISIBLE
        status.visibility = View.GONE

        thread {
            try {
                val db = AppDb(this)
                val engine = EnrichmentEngine(client)

                // ensure enrichment cache covers all remote files (fetch missing once)
                val remoteFiles = client.galleryDeltaAll(null).files
                    .filter { it.status == "READY" && it.deletedAt == null }
                val known = db.enrichedFileIds()
                val missing = remoteFiles.filter { it.id !in known }
                if (missing.isNotEmpty()) {
                    runOnUiThread { status.visibility = View.VISIBLE; status.text = getString(R.string.search_indexing) }
                    for (file in missing) {
                        engine.loadEnrichment(file, filesKey)?.let { db.rememberEnrichment(file.id, it) }
                    }
                }

                val fileById = remoteFiles.associateBy { it.id }
                val assetsById = MediaScanner(this).scanAll().associateBy { it.id }
                val results = db.allEnrichments().mapNotNull { (fileId, record) ->
                    if (!engine.matches(record, query)) return@mapNotNull null
                    val file = fileById[fileId]
                    val name = file?.let { dto ->
                        runCatching {
                            val rootFek = DdvCrypto.unwrapRootFek(dto.wrappedFEK, filesKey)
                            dto.encryptedName?.let { DdvCrypto.decryptMeta(rootFek, it) }
                        }.getOrNull()
                    } ?: fileId
                    Result(fileId, name, record, db.assetIdForFile(fileId)?.let { assetsById[it] })
                }.sortedBy { it.name }

                runOnUiThread {
                    progress.visibility = View.GONE
                    status.visibility = if (results.isEmpty()) View.VISIBLE else View.GONE
                    status.text = getString(R.string.search_empty)
                    adapter.submit(results)
                }
            } catch (e: Exception) {
                runOnUiThread {
                    progress.visibility = View.GONE
                    status.visibility = View.VISIBLE
                    status.text = "Błąd: ${e.message}"
                }
            }
        }
    }

    inner class ResultAdapter(private val onClick: (Result) -> Unit) : RecyclerView.Adapter<ResultAdapter.Holder>() {

        private var results: List<Result> = emptyList()

        fun submit(newResults: List<Result>) {
            results = newResults
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

        override fun getItemCount() = results.size

        override fun onBindViewHolder(holder: Holder, position: Int) {
            val result = results[position]
            holder.name.text = if (result.asset == null) {
                "${result.name} · ${holder.itemView.context.getString(R.string.search_cloud_only)}"
            } else result.name
            holder.description.text = result.record.description
            holder.tags.text = result.record.tags.joinToString("  ") { "#$it" }
            holder.thumb.setImageDrawable(null)
            result.asset?.let { ThumbLoader.load(holder.itemView.context, it, holder.thumb, 192) }
            holder.itemView.setOnClickListener { onClick(result) }
        }
    }
}
