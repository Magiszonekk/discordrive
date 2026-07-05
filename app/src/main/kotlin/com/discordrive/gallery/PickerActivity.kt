package com.discordrive.gallery

import android.content.Intent
import android.os.Bundle
import android.provider.DocumentsContract
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.doAfterTextChanged
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.discordrive.gallery.api.EnrichmentRecord
import com.google.android.material.appbar.MaterialToolbar
import kotlin.concurrent.thread

/**
 * In-app picker for ACTION_GET_CONTENT / ACTION_PICK: attaching a file in
 * another app (Discord…) can open THIS gallery — date-grouped grid plus the
 * AI search (tags/description/OCR/transcript) — instead of the stock
 * DocumentsUI. The picked item is returned as a grantable URI of our
 * DocumentsProvider, so cloud-only files download+decrypt transparently
 * when the receiving app opens them.
 */
class PickerActivity : AppCompatActivity() {

    private lateinit var adapter: GalleryAdapter
    private lateinit var emptyView: TextView

    private var allAssets: List<MediaAsset> = emptyList()
    private var syncedIds: Set<Long> = emptySet()
    private var enrichmentByAssetId: Map<Long, EnrichmentRecord> = emptyMap()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_picker)
        Insets.apply(findViewById(R.id.pickerRoot))

        findViewById<MaterialToolbar>(R.id.toolbar).setNavigationOnClickListener {
            setResult(RESULT_CANCELED)
            finish()
        }
        emptyView = findViewById(R.id.pickerEmpty)

        adapter = GalleryAdapter(onClick = { returnPick(it) })
        findViewById<RecyclerView>(R.id.pickerGrid).apply {
            layoutManager = GridLayoutManager(this@PickerActivity, GalleryAdapter.SPAN_COUNT).also { glm ->
                glm.spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
                    override fun getSpanSize(position: Int) =
                        if (this@PickerActivity.adapter.isHeader(position)) GalleryAdapter.SPAN_COUNT else 1
                }
            }
            adapter = this@PickerActivity.adapter
        }

        val queryInput = findViewById<EditText>(R.id.pickerQuery)
        queryInput.doAfterTextChanged { text -> refresh(text?.toString().orEmpty()) }

        thread {
            val db = AppDb(this)
            val wanted = wantedMimes()
            val assets = MediaScanner(this).scanGallery()
                .filter { asset -> wanted.isEmpty() || wanted.any { asset.mimeType.startsWith(it) } }
            val synced = assets.filter { db.fileIdForAny(it) != null }.map { it.id }.toSet()
            // enrichments keyed by the on-screen asset id, for the search filter
            val byAsset = HashMap<Long, EnrichmentRecord>()
            for ((fileId, record) in db.allEnrichments()) {
                db.assetIdForFile(fileId)?.let { byAsset[it] = record }
            }
            for (asset in assets) {
                val cloudId = asset.cloudFileId ?: continue
                db.enrichmentFor(cloudId)?.let { byAsset[asset.id] = it }
            }
            runOnUiThread {
                allAssets = assets
                syncedIds = synced
                enrichmentByAssetId = byAsset
                refresh(queryInput.text?.toString().orEmpty())
            }
        }
    }

    /** Requested mime prefixes ("image/", "video/"); empty = anything we have. */
    private fun wantedMimes(): List<String> {
        val raw = buildList {
            intent.type?.let { add(it) }
            intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES)?.let { addAll(it) }
        }
        if (raw.any { it == "*/*" }) return emptyList()
        return raw.map { it.substringBefore('*') }.filter { it.isNotBlank() }
    }

    private fun refresh(query: String) {
        val q = query.trim().lowercase()
        val shown = if (q.isEmpty()) {
            allAssets
        } else {
            allAssets.filter { asset ->
                if (asset.displayName.lowercase().contains(q)) return@filter true
                val r = enrichmentByAssetId[asset.id] ?: return@filter false
                r.description.lowercase().contains(q) ||
                    r.tags.any { it.lowercase().contains(q) } ||
                    r.ocrText?.lowercase()?.contains(q) == true ||
                    r.transcript?.lowercase()?.contains(q) == true
            }
        }
        adapter.submit(shown, syncedIds)
        emptyView.visibility = if (shown.isEmpty()) TextView.VISIBLE else TextView.GONE
    }

    /** Hands the picked item back as a grantable URI of our DocumentsProvider. */
    private fun returnPick(asset: MediaAsset) {
        val docId = asset.cloudFileId?.let { "cloud:$it" } ?: "media:${asset.id}"
        val uri = DocumentsContract.buildDocumentUri("$packageName.documents", docId)
        setResult(
            RESULT_OK,
            Intent().setDataAndType(uri, asset.mimeType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
        )
        finish()
    }
}
