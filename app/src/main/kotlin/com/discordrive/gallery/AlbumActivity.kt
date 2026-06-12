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

        adapter = GalleryAdapter(
            onClick = { asset ->
                startActivity(Intent(this, ViewerActivity::class.java).putExtra("assetId", asset.id))
            },
            onLongClick = { asset -> showAssetActions(asset) },
        )
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

    // === File actions (long-press) — trash model, no hard delete here ===

    private fun showAssetActions(asset: MediaAsset) {
        val fileId = AppDb(this).fileIdFor(asset)
        val actions = mutableListOf<Pair<String, () -> Unit>>()
        if (fileId != null) {
            actions += getString(R.string.action_move_to_album) to { pickMoveTarget(asset, fileId) }
            actions += getString(R.string.action_delete_cloud) to { deleteFromCloud(asset, fileId, alsoLocal = false) }
            actions += getString(R.string.action_delete_everywhere) to { deleteFromCloud(asset, fileId, alsoLocal = true) }
        }
        actions += getString(R.string.action_delete_local) to { deleteLocal(asset) }

        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(asset.displayName)
            .setItems(actions.map { it.first }.toTypedArray()) { _, which -> actions[which].second() }
            .show()
    }

    private fun deleteFromCloud(asset: MediaAsset, fileId: String, alsoLocal: Boolean) {
        val client = SessionManager.client ?: return
        thread {
            try {
                client.deleteFile(fileId)
                runOnUiThread {
                    Snackbar.make(findViewById(R.id.albumRoot), R.string.deleted_to_trash, Snackbar.LENGTH_LONG).show()
                    if (alsoLocal) deleteLocal(asset) else refreshGrid()
                }
            } catch (e: Exception) {
                runOnUiThread { Snackbar.make(findViewById(R.id.albumRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show() }
            }
        }
    }

    /** MediaStore delete — Android shows its own confirmation dialog. */
    private fun deleteLocal(asset: MediaAsset) {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            val intent = android.provider.MediaStore.createDeleteRequest(contentResolver, listOf(asset.uri))
            startIntentSenderForResult(intent.intentSender, REQUEST_DELETE_LOCAL, null, 0, 0, 0)
        } else {
            runCatching { contentResolver.delete(asset.uri, null, null) }
            refreshGrid()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_DELETE_LOCAL) refreshGrid()
    }

    private fun pickMoveTarget(asset: MediaAsset, fileId: String) {
        val client = SessionManager.client ?: return
        val filesKey = SessionManager.filesKey ?: return
        thread {
            try {
                val folders = client.folders(null).mapNotNull { folder ->
                    runCatching {
                        val key = com.discordrive.gallery.crypto.DdvCrypto.unwrapKeyPacked(
                            com.discordrive.gallery.crypto.DdvCrypto.b64decode(folder.wrappedFolderKey), filesKey,
                        )
                        val body = com.discordrive.gallery.crypto.DdvCrypto.decryptMeta(key, folder.encryptedBody)
                        val name = kotlinx.serialization.json.Json.parseToJsonElement(body)
                            .let { it as kotlinx.serialization.json.JsonObject }
                            .getValue("name").let { (it as kotlinx.serialization.json.JsonPrimitive).content }
                        name to folder.id
                    }.getOrNull()
                }.sortedBy { it.first }

                runOnUiThread {
                    val labels = folders.map { it.first } + getString(R.string.action_new_album)
                    com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
                        .setTitle(R.string.action_move_to_album)
                        .setItems(labels.toTypedArray()) { _, which ->
                            if (which < folders.size) {
                                moveTo(asset, fileId, folders[which].second, folders[which].first)
                            } else {
                                promptNewAlbum { newId, newName -> moveTo(asset, fileId, newId, newName) }
                            }
                        }
                        .show()
                }
            } catch (e: Exception) {
                runOnUiThread { Snackbar.make(findViewById(R.id.albumRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show() }
            }
        }
    }

    private fun promptNewAlbum(onCreated: (folderId: String, name: String) -> Unit) {
        val input = android.widget.EditText(this).apply { hint = getString(R.string.new_album_hint) }
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(R.string.action_new_album)
            .setView(input)
            .setPositiveButton(R.string.settings_save) { _, _ ->
                val name = input.text.toString().trim()
                if (name.isEmpty()) return@setPositiveButton
                val client = SessionManager.client ?: return@setPositiveButton
                val filesKey = SessionManager.filesKey ?: return@setPositiveButton
                thread {
                    try {
                        val folderId = com.discordrive.gallery.api.FolderManager(client)
                            .ensureFolder(name, parentFolderId = null, filesKey = filesKey)
                        runOnUiThread { onCreated(folderId, name) }
                    } catch (e: Exception) {
                        runOnUiThread { Snackbar.make(findViewById(R.id.albumRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show() }
                    }
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun moveTo(asset: MediaAsset, fileId: String, folderId: String, folderName: String) {
        val client = SessionManager.client ?: return
        thread {
            try {
                client.moveFile(fileId, folderId)
                runOnUiThread {
                    Snackbar.make(findViewById(R.id.albumRoot), getString(R.string.moved_to, folderName), Snackbar.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                runOnUiThread { Snackbar.make(findViewById(R.id.albumRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show() }
            }
        }
    }

    private companion object {
        const val REQUEST_DELETE_LOCAL = 42
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
