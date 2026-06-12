package com.discordrive.gallery

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.discordrive.gallery.api.AiVisionClient
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.snackbar.Snackbar
import kotlin.concurrent.thread

/** Albums overview — buckets mirrored as collections, like a stock gallery. */
class MainActivity : AppCompatActivity() {

    private lateinit var adapter: AlbumAdapter
    private lateinit var progress: LinearProgressIndicator
    private lateinit var statusBarText: TextView
    private lateinit var emptyView: TextView
    private var working = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!SessionManager.isLoggedIn) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)
        Insets.apply(findViewById(R.id.mainRoot), bottom = false)

        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        toolbar.inflateMenu(R.menu.menu_main)
        toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_search -> startActivity(Intent(this, SearchActivity::class.java))
                R.id.action_sync -> runSync()
                R.id.action_ai -> runAiScan(bucket = null)
                R.id.action_settings -> startActivity(Intent(this, SettingsActivity::class.java))
                R.id.action_trash -> startActivity(Intent(this, TrashActivity::class.java))
            }
            true
        }

        progress = findViewById(R.id.progress)
        statusBarText = findViewById(R.id.statusBarText)
        emptyView = findViewById(R.id.emptyView)

        adapter = AlbumAdapter { album ->
            startActivity(Intent(this, AlbumActivity::class.java).putExtra("bucket", album.name))
        }
        findViewById<RecyclerView>(R.id.grid).apply {
            layoutManager = GridLayoutManager(this@MainActivity, AlbumAdapter.SPAN_COUNT)
            adapter = this@MainActivity.adapter
            setPadding(12, 12, 12, 12)
        }

        ensureMediaPermission()
        SyncWorker.applySchedule(this)
    }

    override fun onResume() {
        super.onResume()
        if (SessionManager.isLoggedIn) refreshAlbums()
    }

    private fun ensureMediaPermission() {
        val permissions = if (Build.VERSION.SDK_INT >= 33) {
            arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        val missing = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshAlbums()
    }

    private fun refreshAlbums() {
        thread {
            val assets = MediaScanner(this).scanAll()
            val albums = assets.groupBy { it.bucketName }.map { (name, items) ->
                Album(
                    name = name,
                    count = items.size,
                    cover = items.first(), // scanAll is newest-first
                    allVideo = items.all { it.isVideo },
                )
            }.sortedByDescending { it.cover.dateAddedSec }
            runOnUiThread {
                adapter.submit(albums)
                emptyView.visibility = if (albums.isEmpty()) View.VISIBLE else View.GONE
            }
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

    private fun runSync() {
        if (working) return
        val client = SessionManager.client ?: return
        val filesKey = SessionManager.filesKey ?: return
        setWorking(getString(R.string.action_sync) + "…")

        thread {
            try {
                val runner = SyncRunner(this, client, filesKey)
                val result = runner.sync { p ->
                    setWorking("Sync ${p.done}/${p.total} · ↑${p.uploaded} · ${p.deduplicated} dedup · ${p.failed} błędów\n${p.detail}")
                }
                setWorking(null)
                runOnUiThread {
                    refreshAlbums()
                    Snackbar.make(
                        findViewById(R.id.mainRoot),
                        "${getString(R.string.sync_done)}: ↑${result.uploaded}, ${result.deduplicated} dedup, ${result.skipped} pominiętych, ${result.failed} błędów",
                        Snackbar.LENGTH_LONG,
                    ).show()
                }
                if (Settings.aiAutoAfterSync(this) && Settings.aiConfigured(this)) runAiScan(bucket = null)
            } catch (e: Throwable) {
                setWorking(null)
                AppLog.e("Main", "sync run failed", e)
                runOnUiThread { Snackbar.make(findViewById(R.id.mainRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show() }
            }
        }
    }

    private fun runAiScan(bucket: String?) {
        if (working) return
        val client = SessionManager.client ?: return
        val filesKey = SessionManager.filesKey ?: return
        if (!Settings.aiConfigured(this)) {
            Snackbar.make(findViewById(R.id.mainRoot), "Skonfiguruj AI w ustawieniach", Snackbar.LENGTH_LONG)
                .setAction(R.string.action_settings) { startActivity(Intent(this, SettingsActivity::class.java)) }
                .show()
            return
        }
        setWorking(getString(R.string.action_ai) + "…")

        thread {
            try {
                val ai = AiVisionClient(Settings.aiUrl(this), Settings.aiKey(this), Settings.aiModel(this))
                val runner = SyncRunner(this, client, filesKey)
                val limit = Settings.aiLimit(this)
                val result = runner.aiScan(ai, Settings.aiModel(this), bucket, limit) { p ->
                    val limitInfo = if (limit > 0) " (limit $limit)" else ""
                    setWorking("AI ${p.done}/${p.total}$limitInfo · ${p.analyzed} nowych · ${p.failed} błędów\n${p.detail}")
                }
                setWorking(null)
                runOnUiThread {
                    Snackbar.make(
                        findViewById(R.id.mainRoot),
                        "Analiza AI: ${result.analyzed} nowych, ${result.skipped} pominiętych, ${result.failed} błędów",
                        Snackbar.LENGTH_LONG,
                    ).show()
                }
            } catch (e: Exception) {
                setWorking(null)
                AppLog.e("Main", "AI run failed", e)
                runOnUiThread { Snackbar.make(findViewById(R.id.mainRoot), "Błąd AI: ${e.message}", Snackbar.LENGTH_LONG).show() }
            }
        }
    }
}
