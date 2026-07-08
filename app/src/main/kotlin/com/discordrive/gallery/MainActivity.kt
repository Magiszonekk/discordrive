package com.discordrive.gallery

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.TextView
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
class MainActivity : SessionActivity() {

    private lateinit var adapter: AlbumAdapter
    private lateinit var progress: LinearProgressIndicator
    private lateinit var statusBarText: TextView
    private lateinit var emptyView: TextView
    private var working = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // No login gate: the gallery opens straight into local media (works
        // offline). A session is only requested when a cloud action needs it.

        setContentView(R.layout.activity_main)
        Insets.apply(findViewById(R.id.mainRoot), bottom = false)

        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        toolbar.inflateMenu(R.menu.menu_main)
        // Accent the AI action so the chosen colour shows up on the home screen too.
        val accent = com.google.android.material.color.MaterialColors.getColor(
            toolbar, com.google.android.material.R.attr.colorPrimary,
        )
        toolbar.menu.findItem(R.id.action_ai)?.icon?.mutate()?.setTint(accent)
        toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_search -> startActivity(Intent(this, SearchActivity::class.java)) // local cache, offline OK
                R.id.action_sync -> runSync()
                R.id.action_ai -> runAiScan(bucket = null)
                R.id.action_settings -> startActivity(Intent(this, SettingsActivity::class.java))
            }
            true
        }

        progress = findViewById(R.id.progress)
        statusBarText = findViewById(R.id.statusBarText)
        emptyView = findViewById(R.id.emptyView)

        adapter = AlbumAdapter { album ->
            when {
                album.isTrash -> requireSession { startActivity(Intent(this, TrashActivity::class.java)) }
                album.isFavorites ->
                    startActivity(Intent(this, AlbumActivity::class.java).putExtra("favorites", true))
                album.isPrivate -> PrivateUnlock.unlock(this) {
                    startActivity(
                        Intent(this, AlbumActivity::class.java)
                            .putExtra("bucket", album.name)
                            .putExtra("unlocked", true),
                    )
                }
                else -> startActivity(Intent(this, AlbumActivity::class.java).putExtra("bucket", album.name))
            }
        }
        findViewById<RecyclerView>(R.id.grid).apply {
            layoutManager = GridLayoutManager(this@MainActivity, AlbumAdapter.SPAN_COUNT)
            adapter = this@MainActivity.adapter
            setPadding(12, 12, 12, 12)
        }

        ensureMediaPermission()
        SyncWorker.applySchedule(this)
        // Refresh cloud badges live when a foreground sync finishes.
        SyncWorker.nowWorkLiveData(this).observe(this) { infos ->
            if (infos.any { it.state.isFinished }) refreshAlbums()
        }
        tryRestoreQuietly() // background auto-login; UI works regardless
        Updater.check(this) // offer in-app update if a newer APK is published
    }

    override fun onResume() {
        super.onResume()
        refreshAlbums()
        tryRestoreQuietly() // periodic best-effort re-login
    }

    private fun ensureMediaPermission() {
        val permissions = if (Build.VERSION.SDK_INT >= 33) {
            arrayOf(
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.POST_NOTIFICATIONS, // background-sync progress notification
            )
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
            val assets = MediaScanner(this).scanGallery()
            val hidden = PrivateAlbums.all(this)
            val visible = if (hidden.isEmpty()) assets else assets.filter { it.bucketName !in hidden }
            val albums = visible.groupBy { it.bucketName }.map { (name, items) ->
                Album(
                    name = name,
                    count = items.size,
                    cover = items.first(), // scanAll is newest-first
                    allVideo = items.all { it.isVideo },
                )
            }.sortedByDescending { it.cover?.dateAddedSec ?: 0L }
            // Favorites, private (locked, no preview) and Trash pin to the very end.
            val favIds = AppDb(this).favoriteIds()
            val favAssets = visible.filter { it.id in favIds } // newest-first, like assets
            val privateAlbums = hidden
                .filter { name -> assets.any { it.bucketName == name } } // skip vanished buckets
                .sorted()
                .map { name -> Album(name = name, count = 0, cover = null, allVideo = false, isPrivate = true) }
            val withTrash = albums + Album(
                name = getString(R.string.favorites_title),
                count = favAssets.size,
                cover = favAssets.firstOrNull(),
                allVideo = false,
                isFavorites = true,
            ) + privateAlbums + Album(
                name = getString(R.string.trash_title),
                count = 0,
                cover = null,
                allVideo = false,
                isTrash = true,
            )
            runOnUiThread {
                adapter.submit(withTrash)
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

    private fun runSync() = requireSession {
        // Run as a foreground-service job (WorkManager) so it keeps going when the
        // app is backgrounded or the screen turns off — progress/pause live in the
        // notification. (A second tap is a no-op: the worker serializes via tryBegin.)
        SyncWorker.runNow(this)
        Snackbar.make(findViewById(R.id.mainRoot), R.string.sync_started_bg, Snackbar.LENGTH_LONG).show()
    }

    private fun runAiScan(bucket: String?) = requireSession {
        if (!Settings.aiConfigured(this)) {
            Snackbar.make(findViewById(R.id.mainRoot), "Skonfiguruj AI w ustawieniach", Snackbar.LENGTH_LONG)
                .setAction(R.string.action_settings) { startActivity(Intent(this, SettingsActivity::class.java)) }
                .show()
            return@requireSession
        }
        // Foreground-service job (like sync): survives backgrounding, shows progress
        // + pause/resume in the notification.
        SyncWorker.runNow(this, SyncWorker.MODE_AI, bucket)
        Snackbar.make(findViewById(R.id.mainRoot), R.string.ai_started_bg, Snackbar.LENGTH_LONG).show()
    }
}
