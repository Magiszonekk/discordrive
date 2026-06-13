package com.discordrive.gallery

import android.content.Intent
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.discordrive.gallery.api.AiVisionClient
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.snackbar.Snackbar
import kotlin.concurrent.thread

/**
 * Single album (bucket): photo grid + per-album AI analysis.
 *
 * Selection follows the Google Photos flow: long-press enters selection mode
 * and selects the item, taps toggle further items, the toolbar turns into a
 * contextual action bar with batch actions (trash model — no hard delete
 * outside "delete everywhere").
 */
class AlbumActivity : SessionActivity() {

    private lateinit var bucket: String
    private lateinit var toolbar: MaterialToolbar
    private lateinit var adapter: GalleryAdapter
    private lateinit var progress: LinearProgressIndicator
    private lateinit var statusBarText: TextView
    private var working = false

    private var currentAssets: List<MediaAsset> = emptyList()
    private val selectedIds = linkedSetOf<Long>()
    private var selectionMode = false
    private var defaultNavIcon: Drawable? = null
    private lateinit var backCallback: OnBackPressedCallback
    private var albumDescription: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        bucket = intent.getStringExtra("bucket") ?: run { finish(); return }

        setContentView(R.layout.activity_album)
        Insets.apply(findViewById(R.id.albumRoot), bottom = false)

        toolbar = findViewById(R.id.toolbar)
        defaultNavIcon = toolbar.navigationIcon
        toolbar.title = bucket
        toolbar.setNavigationOnClickListener { if (selectionMode) exitSelection() else finish() }
        toolbar.inflateMenu(R.menu.menu_album)
        toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_ai_album -> requireSession { runAlbumAi() }
                R.id.action_album_desc -> requireSession { editAlbumDescription() }
                R.id.action_album_clear_ai -> requireSession { confirmClearAlbumAnalyses() }
                R.id.action_sel_move -> requireSession { pickMoveTargetForSelection() }
                R.id.action_sel_delete_cloud -> requireSession { confirmTrashSelection(alsoLocal = false) }
                R.id.action_sel_delete_everywhere -> requireSession { confirmTrashSelection(alsoLocal = true) }
                R.id.action_sel_delete_local -> deleteLocalBatch(selectedAssets())
            }
            true
        }

        backCallback = object : OnBackPressedCallback(false) {
            override fun handleOnBackPressed() = exitSelection()
        }
        onBackPressedDispatcher.addCallback(this, backCallback)

        progress = findViewById(R.id.progress)
        statusBarText = findViewById(R.id.statusBarText)

        adapter = GalleryAdapter(
            onClick = { asset ->
                if (selectionMode) {
                    toggleSelection(asset)
                } else {
                    startActivity(
                        Intent(this, ViewerActivity::class.java)
                            .putExtra("assetId", asset.id)
                            .putExtra("bucket", bucket),
                    )
                }
            },
            onLongClick = { asset ->
                if (selectionMode) toggleSelection(asset) else enterSelection(asset)
            },
        )
        findViewById<RecyclerView>(R.id.grid).apply {
            layoutManager = GridLayoutManager(this@AlbumActivity, GalleryAdapter.SPAN_COUNT)
            adapter = this@AlbumActivity.adapter
        }
    }

    override fun onResume() {
        super.onResume()
        refreshGrid()
        loadAlbumDescription()
    }

    /** Loads the (E2EE) album description into the toolbar subtitle, in the background. */
    private fun loadAlbumDescription() {
        val client = SessionManager.client ?: return
        val filesKey = SessionManager.filesKey ?: return
        thread {
            val desc = AlbumDescriptions.load(client, filesKey, bucket)
            runOnUiThread {
                albumDescription = desc
                if (!selectionMode) toolbar.subtitle = desc
            }
        }
    }

    /** Dialog to add/edit the per-album description used as AI context. */
    private fun editAlbumDescription() {
        val client = SessionManager.client ?: return
        val filesKey = SessionManager.filesKey ?: return
        val input = android.widget.EditText(this).apply {
            hint = getString(R.string.album_desc_hint)
            setText(albumDescription ?: "")
            setSelection(text.length)
            isSingleLine = false
            minLines = 2
            maxLines = 5
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.album_desc_title, bucket))
            .setMessage(R.string.album_desc_help)
            .setView(input)
            .setPositiveButton(R.string.settings_save) { _, _ ->
                val text = input.text.toString().trim()
                thread {
                    runCatching { AlbumDescriptions.save(client, filesKey, bucket, text) }
                        .onSuccess {
                            runOnUiThread {
                                albumDescription = text.ifBlank { null }
                                if (!selectionMode) toolbar.subtitle = albumDescription
                                Snackbar.make(findViewById(R.id.albumRoot), R.string.album_desc_saved, Snackbar.LENGTH_SHORT).show()
                            }
                        }
                        .onFailure { e ->
                            AppLog.w("Album", "save album description failed", e)
                            runOnUiThread { Snackbar.make(findViewById(R.id.albumRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show() }
                        }
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun refreshGrid() {
        thread {
            val assets = MediaScanner(this).scanAll().filter { it.bucketName == bucket }
            val db = AppDb(this)
            val synced = assets.filter { db.fileIdFor(it) != null }.map { it.id }.toSet()
            runOnUiThread {
                currentAssets = assets
                // drop selections whose assets disappeared (e.g. deleted locally)
                selectedIds.retainAll(assets.map { it.id }.toSet())
                if (selectionMode && selectedIds.isEmpty()) {
                    exitSelectionUiOnly()
                }
                adapter.submit(assets, synced)
                adapter.setSelection(selectionMode, selectedIds.toSet())
                if (assets.isEmpty()) finish()
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

    // === Selection mode (Google Photos flow) ===

    private fun enterSelection(asset: MediaAsset) {
        selectionMode = true
        selectedIds.add(asset.id)
        updateSelectionUi()
    }

    private fun toggleSelection(asset: MediaAsset) {
        if (!selectedIds.add(asset.id)) selectedIds.remove(asset.id)
        if (selectedIds.isEmpty()) exitSelection() else updateSelectionUi()
    }

    private fun exitSelection() {
        selectedIds.clear()
        exitSelectionUiOnly()
    }

    private fun exitSelectionUiOnly() {
        selectionMode = false
        updateSelectionUi()
    }

    private fun updateSelectionUi() {
        backCallback.isEnabled = selectionMode
        adapter.setSelection(selectionMode, selectedIds.toSet())
        toolbar.menu.clear()
        if (selectionMode) {
            toolbar.title = getString(R.string.selection_count, selectedIds.size)
            toolbar.subtitle = null
            toolbar.setNavigationIcon(R.drawable.ic_close)
            toolbar.navigationContentDescription = getString(R.string.selection_exit)
            toolbar.inflateMenu(R.menu.menu_selection)
        } else {
            toolbar.title = bucket
            toolbar.subtitle = albumDescription
            toolbar.navigationIcon = defaultNavIcon
            toolbar.inflateMenu(R.menu.menu_album)
        }
    }

    private fun selectedAssets(): List<MediaAsset> = currentAssets.filter { it.id in selectedIds }

    // === Batch actions — trash model, no hard delete here ===

    private fun confirmTrashSelection(alsoLocal: Boolean) {
        val assets = selectedAssets()
        if (assets.isEmpty()) return
        MaterialAlertDialogBuilder(this)
            .setMessage(
                getString(
                    if (alsoLocal) R.string.sel_everywhere_confirm else R.string.sel_trash_confirm,
                    assets.size,
                ),
            )
            .setPositiveButton(R.string.action_delete_cloud) { _, _ -> trashSelection(assets, alsoLocal) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun trashSelection(assets: List<MediaAsset>, alsoLocal: Boolean) {
        val client = SessionManager.client ?: return
        setWorking(getString(R.string.action_delete_cloud) + "…")
        thread {
            val db = AppDb(this)
            var trashed = 0
            var unsynced = 0
            for (asset in assets) {
                val fileId = db.fileIdFor(asset) ?: run { unsynced++; null } ?: continue
                runCatching { client.deleteFile(fileId); trashed++ }
                    .onFailure { AppLog.w("Album", "trash failed for ${asset.displayName}", it) }
            }
            setWorking(null)
            runOnUiThread {
                val message = when {
                    trashed == 0 && unsynced > 0 -> getString(R.string.sel_none_synced)
                    unsynced > 0 -> getString(R.string.sel_trashed_partial, trashed, unsynced)
                    else -> getString(R.string.sel_trashed, trashed)
                }
                Snackbar.make(findViewById(R.id.albumRoot), message, Snackbar.LENGTH_LONG).show()
                if (alsoLocal) {
                    deleteLocalBatch(assets)
                } else {
                    exitSelection()
                    refreshGrid()
                }
            }
        }
    }

    /** MediaStore delete — Android shows one confirmation dialog for the whole batch. */
    private fun deleteLocalBatch(assets: List<MediaAsset>) {
        if (assets.isEmpty()) return
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            val intent = android.provider.MediaStore.createDeleteRequest(contentResolver, assets.map { it.uri })
            startIntentSenderForResult(intent.intentSender, REQUEST_DELETE_LOCAL, null, 0, 0, 0)
        } else {
            assets.forEach { runCatching { contentResolver.delete(it.uri, null, null) } }
            exitSelection()
            refreshGrid()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_DELETE_LOCAL) {
            exitSelection()
            refreshGrid()
        }
    }

    private fun pickMoveTargetForSelection() {
        val client = SessionManager.client ?: return
        val filesKey = SessionManager.filesKey ?: return
        val assets = selectedAssets()
        if (assets.isEmpty()) return
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
                    MaterialAlertDialogBuilder(this)
                        .setTitle(R.string.action_move_to_album)
                        .setItems(labels.toTypedArray()) { _, which ->
                            if (which < folders.size) {
                                moveSelectionTo(assets, folders[which].second, folders[which].first)
                            } else {
                                promptNewAlbum { newId, newName -> moveSelectionTo(assets, newId, newName) }
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
        MaterialAlertDialogBuilder(this)
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

    private fun moveSelectionTo(assets: List<MediaAsset>, folderId: String, folderName: String) {
        val client = SessionManager.client ?: return
        setWorking(getString(R.string.action_move_to_album))
        thread {
            val db = AppDb(this)
            var moved = 0
            var unsynced = 0
            for (asset in assets) {
                val fileId = db.fileIdFor(asset) ?: run { unsynced++; null } ?: continue
                runCatching { client.moveFile(fileId, folderId); moved++ }
                    .onFailure { AppLog.w("Album", "move failed for ${asset.displayName}", it) }
            }
            setWorking(null)
            runOnUiThread {
                val message = if (moved == 0 && unsynced > 0) {
                    getString(R.string.sel_none_synced)
                } else {
                    getString(R.string.sel_moved, moved, folderName)
                }
                Snackbar.make(findViewById(R.id.albumRoot), message, Snackbar.LENGTH_LONG).show()
                exitSelection()
                refreshGrid()
            }
        }
    }

    private companion object {
        const val REQUEST_DELETE_LOCAL = 42
    }

    /** Deletes all AI analyses for files in this album (cloud + local cache). */
    private fun confirmClearAlbumAnalyses() {
        val client = SessionManager.client ?: return
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.album_clear_ai_action)
            .setMessage(getString(R.string.album_clear_ai_confirm, bucket))
            .setPositiveButton(R.string.action_delete_cloud) { _, _ ->
                setWorking("${getString(R.string.album_clear_ai_action)}…")
                thread {
                    val db = AppDb(this)
                    val fileIds = db.enrichedFileIdsInBucket(bucket).toList()
                    val deleted = runCatching {
                        if (fileIds.isNotEmpty()) client.deleteEnrichments(fileIds) else 0
                    }.onFailure { AppLog.w("Album", "clear album AI failed", it) }.getOrDefault(0)
                    fileIds.forEach { db.forgetEnrichment(it) }
                    setWorking(null)
                    runOnUiThread {
                        Snackbar.make(findViewById(R.id.albumRoot), getString(R.string.ai_cleared, deleted), Snackbar.LENGTH_LONG).show()
                    }
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
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
                AppLog.e("Album", "AI run failed", e)
                runOnUiThread { Snackbar.make(findViewById(R.id.albumRoot), "Błąd AI: ${e.message}", Snackbar.LENGTH_LONG).show() }
            }
        }
    }
}
