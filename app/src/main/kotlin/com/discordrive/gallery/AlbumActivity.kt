package com.discordrive.gallery

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.discordrive.gallery.api.AiVisionClient
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.snackbar.Snackbar
import kotlin.concurrent.thread

/** Single album (bucket): photo grid + per-album AI analysis. */
class AlbumActivity : AppCompatActivity() {

    private lateinit var bucket: String
    private lateinit var adapter: GalleryAdapter
    private lateinit var progress: LinearProgressIndicator
    private lateinit var statusBarText: TextView
    private var working = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        bucket = intent.getStringExtra("bucket") ?: run { finish(); return }

        setContentView(R.layout.activity_album)
        Insets.apply(findViewById(R.id.albumRoot), bottom = false)

        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        toolbar.title = bucket
        toolbar.setNavigationOnClickListener { finish() }
        toolbar.inflateMenu(R.menu.menu_album)
        toolbar.setOnMenuItemClickListener { item ->
            if (item.itemId == R.id.action_ai_album) runAlbumAi()
            true
        }

        progress = findViewById(R.id.progress)
        statusBarText = findViewById(R.id.statusBarText)

        adapter = GalleryAdapter { asset ->
            startActivity(Intent(this, ViewerActivity::class.java).putExtra("assetId", asset.id))
        }
        findViewById<RecyclerView>(R.id.grid).apply {
            layoutManager = GridLayoutManager(this@AlbumActivity, GalleryAdapter.SPAN_COUNT)
            adapter = this@AlbumActivity.adapter
        }
    }

    override fun onResume() {
        super.onResume()
        refreshGrid()
    }

    private fun refreshGrid() {
        thread {
            val assets = MediaScanner(this).scanAll().filter { it.bucketName == bucket }
            val db = AppDb(this)
            val synced = assets.filter { db.fileIdFor(it) != null }.map { it.id }.toSet()
            runOnUiThread { adapter.submit(assets, synced) }
        }
    }

    private fun setWorking(text: String?) {
        runOnUiThread {
            working = text != null
            progress.visibility = if (text != null) View.VISIBLE else View.GONE
            statusBarText.visibility = if (text != null) View.VISIBLE else View.GONE
            statusBarText.text = text ?: ""
        }
    }

    private fun runAlbumAi() {
        if (working) return
        val client = SessionManager.client ?: return
        val filesKey = SessionManager.filesKey ?: return
        if (!Settings.aiConfigured(this)) {
            Snackbar.make(findViewById(R.id.albumRoot), "Skonfiguruj AI w ustawieniach", Snackbar.LENGTH_LONG)
                .setAction(R.string.action_settings) { startActivity(Intent(this, SettingsActivity::class.java)) }
                .show()
            return
        }
        setWorking("${getString(R.string.album_ai_action)}…")

        thread {
            try {
                val ai = AiVisionClient(Settings.aiUrl(this), Settings.aiKey(this), Settings.aiModel(this))
                val runner = SyncRunner(this, client, filesKey)
                val limit = Settings.aiLimit(this)
                val result = runner.aiScan(ai, Settings.aiModel(this), bucketFilter = bucket, limit = limit) { p ->
                    val limitInfo = if (limit > 0) " (limit $limit)" else ""
                    setWorking("AI ${p.done}/${p.total}$limitInfo · ${p.analyzed} nowych · ${p.failed} błędów\n${p.detail}")
                }
                setWorking(null)
                runOnUiThread {
                    Snackbar.make(
                        findViewById(R.id.albumRoot),
                        "Album „$bucket”: ${result.analyzed} przeanalizowanych, ${result.skipped} pominiętych, ${result.failed} błędów",
                        Snackbar.LENGTH_LONG,
                    ).show()
                }
            } catch (e: Exception) {
                setWorking(null)
                runOnUiThread { Snackbar.make(findViewById(R.id.albumRoot), "Błąd AI: ${e.message}", Snackbar.LENGTH_LONG).show() }
            }
        }
    }
}
