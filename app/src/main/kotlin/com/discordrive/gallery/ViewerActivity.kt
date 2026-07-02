package com.discordrive.gallery

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.text.format.Formatter
import android.view.LayoutInflater
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import com.discordrive.gallery.api.AiVisionClient
import com.discordrive.gallery.api.UploadEngine
import com.discordrive.gallery.crypto.DdvCrypto
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * Full-screen viewer with horizontal swipe between the album's items
 * (gallery-style). Images load full-screen; videos show a poster frame with a
 * play button; tapping play streams the file inline via ExoPlayer (no external
 * app). Tap toggles the info panel (name + AI description/tags).
 */
class ViewerActivity : SessionActivity() {

    private var panelVisible = true
    private var assets: List<MediaAsset> = emptyList()
    private var shownAsset: MediaAsset? = null
    private var bucket: String? = null
    private lateinit var pager: ViewPager2
    private lateinit var adapter: PageAdapter

    private lateinit var infoPanel: View
    private lateinit var toolbar: MaterialToolbar
    private lateinit var nameView: TextView
    private lateinit var descriptionView: TextView
    private lateinit var chips: ChipGroup
    private lateinit var clearAiButton: View
    private lateinit var editAiButton: View
    private lateinit var analyzeAiButton: View

    private val localDeleteLauncher =
        registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
            if (result.resultCode == RESULT_OK) reloadAfterLocalRemoval()
        }

    // Single inline player, attached to whichever video page is playing.
    private var player: ExoPlayer? = null
    private var activePlayerView: PlayerView? = null
    private var activeImage: ImageView? = null
    private var activePlay: ImageView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_viewer)

        val assetId = intent.getLongExtra("assetId", -1)
        val bucket = intent.getStringExtra("bucket")
        val pager = findViewById<ViewPager2>(R.id.pager)
        infoPanel = findViewById(R.id.infoPanel)
        Insets.apply(infoPanel, top = false)

        toolbar = findViewById(R.id.viewerToolbar)
        Insets.apply(toolbar, bottom = false)
        toolbar.setNavigationOnClickListener { finish() }
        toolbar.inflateMenu(R.menu.menu_viewer)
        toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_viewer_sync -> syncCurrent()
                R.id.action_viewer_info -> showInfoDialog()
                R.id.action_viewer_move -> moveCurrent()
                R.id.action_viewer_delete_cloud -> confirmDelete(alsoLocal = false)
                R.id.action_viewer_delete_everywhere -> confirmDelete(alsoLocal = true)
                R.id.action_viewer_delete_local -> deleteCurrentLocal()
            }
            true
        }
        nameView = findViewById(R.id.fileName)
        descriptionView = findViewById(R.id.description)
        chips = findViewById(R.id.tagChips)
        clearAiButton = findViewById(R.id.clearAiButton)
        clearAiButton.setOnClickListener { deleteCurrentAnalysis() }
        editAiButton = findViewById(R.id.editAiButton)
        editAiButton.setOnClickListener { editCurrentAnalysis() }
        analyzeAiButton = findViewById(R.id.analyzeAiButton)
        analyzeAiButton.setOnClickListener { analyzeCurrent() }

        this.bucket = bucket
        this.pager = pager
        adapter = PageAdapter()
        pager.adapter = adapter
        pager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) {
                stopPlayback() // releases any video playing on the previous page
                if (position in assets.indices) showInfo(assets[position])
            }
        })
        loadAssets(focusAssetId = assetId, fallbackIndex = 0)
    }

    /** (Re)loads the album's assets and focuses one (or a fallback index). */
    private fun loadAssets(focusAssetId: Long, fallbackIndex: Int) {
        thread {
            val all = MediaScanner(this).scanGallery()
            val scoped = bucket?.let { b -> all.filter { it.bucketName == b } }
                ?.takeIf { it.isNotEmpty() } ?: all
            runOnUiThread {
                if (scoped.isEmpty()) { finish(); return@runOnUiThread }
                assets = scoped
                adapter.notifyDataSetChanged()
                val idx = scoped.indexOfFirst { it.id == focusAssetId }
                    .let { if (it >= 0) it else fallbackIndex.coerceIn(0, scoped.lastIndex) }
                pager.setCurrentItem(idx, false)
                showInfo(scoped[idx])
            }
        }
    }

    private fun reloadAfterLocalRemoval() {
        loadAssets(focusAssetId = shownAsset?.id ?: -1L, fallbackIndex = pager.currentItem)
    }

    private fun showInfo(asset: MediaAsset) {
        shownAsset = asset
        nameView.text = asset.displayName
        descriptionView.text = ""
        chips.removeAllViews()
        clearAiButton.visibility = View.GONE
        editAiButton.visibility = View.GONE
        analyzeAiButton.visibility = View.GONE
        thread {
            val db = AppDb(this)
            val fileId = db.fileIdForAny(asset)
            val record = fileId?.let { db.enrichmentFor(it) }
            runOnUiThread {
                if (shownAsset?.id != asset.id) return@runOnUiThread // already swiped on
                if (record != null) {
                    descriptionView.text = record.description
                    chips.removeAllViews()
                    record.tags.take(10).forEach { tag ->
                        chips.addView(Chip(this).apply { text = tag; isClickable = false })
                    }
                    clearAiButton.visibility = View.VISIBLE
                    editAiButton.visibility = View.VISIBLE
                } else {
                    descriptionView.text = getString(R.string.viewer_no_enrichment)
                    // offer analysis only for synced photos with a local file (vision
                    // reads the original — cloud-only previews can't be analyzed here)
                    analyzeAiButton.visibility =
                        if (fileId != null && asset.cloudFileId == null) View.VISIBLE else View.GONE
                }
            }
        }
    }

    /** Analyzes just this photo with AI on demand and shows the result. */
    private fun analyzeCurrent() {
        val asset = shownAsset ?: return
        if (!Settings.aiConfigured(this)) {
            Snackbar.make(findViewById(R.id.viewerRoot), "Skonfiguruj AI w ustawieniach", Snackbar.LENGTH_LONG)
                .setAction(R.string.action_settings) {
                    startActivity(android.content.Intent(this, SettingsActivity::class.java))
                }.show()
            return
        }
        requireSession {
            val client = SessionManager.client ?: return@requireSession
            val filesKey = SessionManager.filesKey ?: return@requireSession
            analyzeAiButton.visibility = View.GONE
            descriptionView.text = getString(R.string.viewer_analyzing)
            thread {
                try {
                    val ai = AiVisionClient(Settings.aiUrl(this), Settings.aiKey(this), Settings.aiModel(this))
                    SyncRunner(this, client, filesKey).analyzeOne(ai, Settings.aiModel(this), asset)
                    runOnUiThread { if (shownAsset?.id == asset.id) showInfo(asset) }
                } catch (e: Exception) {
                    AppLog.w("Viewer", "single AI failed for ${asset.displayName}", e)
                    runOnUiThread {
                        if (shownAsset?.id == asset.id) {
                            descriptionView.text = getString(R.string.viewer_no_enrichment)
                            analyzeAiButton.visibility = View.VISIBLE
                        }
                        Snackbar.make(findViewById(R.id.viewerRoot), "Błąd AI: ${e.message}", Snackbar.LENGTH_LONG).show()
                    }
                }
            }
        }
    }

    /**
     * Manual correction of the AI analysis: dialog with the description and
     * comma-separated tags; the edited record is re-encrypted and uploaded
     * like a fresh analysis (per-file blob + local cache + cloud index), so
     * it syncs to other devices. The transcript/OCR fields are preserved.
     */
    private fun editCurrentAnalysis() {
        val asset = shownAsset ?: return
        requireSession {
            val client = SessionManager.client ?: return@requireSession
            val filesKey = SessionManager.filesKey ?: return@requireSession
            thread {
                val db = AppDb(this)
                val fileId = db.fileIdForAny(asset) ?: return@thread
                val record = db.enrichmentFor(fileId) ?: return@thread
                runOnUiThread {
                    if (shownAsset?.id != asset.id) return@runOnUiThread
                    val view = LayoutInflater.from(this).inflate(R.layout.dialog_edit_enrichment, null)
                    val descInput = view.findViewById<TextView>(R.id.editDescription)
                    val tagsInput = view.findViewById<TextView>(R.id.editTags)
                    descInput.text = record.description
                    tagsInput.text = record.tags.joinToString(", ")
                    MaterialAlertDialogBuilder(this)
                        .setTitle(R.string.edit_ai_title)
                        .setView(view)
                        .setPositiveButton(R.string.settings_save) { _, _ ->
                            val newDesc = descInput.text.toString().trim()
                            val newTags = tagsInput.text.toString()
                                .split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct()
                            saveEditedAnalysis(asset, fileId, record.copy(description = newDesc, tags = newTags))
                        }
                        .setNegativeButton(android.R.string.cancel, null)
                        .show()
                }
            }
        }
    }

    private fun saveEditedAnalysis(asset: MediaAsset, fileId: String, updated: com.discordrive.gallery.api.EnrichmentRecord) {
        val client = SessionManager.client ?: return
        val filesKey = SessionManager.filesKey ?: return
        thread {
            try {
                val file = client.file(fileId) ?: throw IllegalStateException("Plik zniknął z chmury")
                val db = AppDb(this)
                com.discordrive.gallery.api.EnrichmentEngine(client).saveEnrichment(fileId, file.wrappedFEK, filesKey, updated)
                db.rememberEnrichment(fileId, updated)
                EnrichmentIndex.push(client, filesKey, db) // keep the E2EE cloud index current
                runOnUiThread {
                    if (shownAsset?.id == asset.id) showInfo(asset)
                    Snackbar.make(findViewById(R.id.viewerRoot), R.string.edit_ai_saved, Snackbar.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                AppLog.w("Viewer", "edit analysis failed", e)
                runOnUiThread {
                    Snackbar.make(findViewById(R.id.viewerRoot), "Błąd zapisu: ${e.message}", Snackbar.LENGTH_LONG).show()
                }
            }
        }
    }

    /** Deletes this photo's AI analysis (cloud blob + local cache). */
    private fun deleteCurrentAnalysis() {
        val asset = shownAsset ?: return
        requireSession {
            val client = SessionManager.client ?: return@requireSession
            clearAiButton.visibility = View.GONE
            thread {
                val db = AppDb(this)
                val fileId = db.fileIdFor(asset)
                if (fileId != null) {
                    runCatching { client.deleteEnrichments(listOf(fileId)) }
                        .onFailure { AppLog.w("Viewer", "delete analysis failed", it) }
                    db.forgetEnrichment(fileId)
                    SessionManager.filesKey?.let { EnrichmentIndex.remove(client, it, listOf(fileId)) } // reflect in cloud index
                }
                runOnUiThread {
                    if (shownAsset?.id == asset.id) {
                        descriptionView.text = getString(R.string.viewer_no_enrichment)
                        chips.removeAllViews()
                    }
                    Snackbar.make(findViewById(R.id.viewerRoot), getString(R.string.ai_cleared, 1), Snackbar.LENGTH_SHORT).show()
                }
            }
        }
    }

    // === Overflow actions (sync / move / delete / info) ===

    /** Uploads just this photo (skips/dedupes if already synced). */
    private fun syncCurrent() {
        val asset = shownAsset ?: return
        if (asset.cloudFileId != null) { snack(getString(R.string.viewer_cloud_only)); return } // already in cloud, no local bytes
        requireSession {
            val client = SessionManager.client ?: return@requireSession
            val filesKey = SessionManager.filesKey ?: return@requireSession
            snack(getString(R.string.action_sync_this) + "…")
            thread {
                try {
                    val result = SyncRunner(this, client, filesKey).syncAssets(listOf(asset)) { }
                    runOnUiThread {
                        snack(
                            if (result.uploaded > 0) getString(R.string.sync_one_done)
                            else getString(R.string.sync_one_already),
                        )
                        if (shownAsset?.id == asset.id) showInfo(asset) // refresh cloud status / analyze button
                    }
                } catch (e: Throwable) {
                    AppLog.e("Viewer", "single sync failed", e)
                    runOnUiThread { snack("Błąd: ${e.message}") }
                }
            }
        }
    }

    private fun moveCurrent() {
        val asset = shownAsset ?: return
        requireSession {
            val client = SessionManager.client ?: return@requireSession
            val filesKey = SessionManager.filesKey ?: return@requireSession
            thread {
                val fileId = AppDb(this).fileIdForAny(asset)
                if (fileId == null) {
                    runOnUiThread { snack(getString(R.string.viewer_not_synced)) }
                    return@thread
                }
                val folders = runCatching {
                    client.folders(null).mapNotNull { folder ->
                        runCatching {
                            val key = DdvCrypto.unwrapKeyPacked(DdvCrypto.b64decode(folder.wrappedFolderKey), filesKey)
                            val body = DdvCrypto.decryptMeta(key, folder.encryptedBody)
                            val name = (kotlinx.serialization.json.Json.parseToJsonElement(body) as kotlinx.serialization.json.JsonObject)
                                .getValue("name").let { (it as kotlinx.serialization.json.JsonPrimitive).content }
                            name to folder.id
                        }.getOrNull()
                    }.sortedBy { it.first }
                }.getOrElse {
                    runOnUiThread { snack("Błąd: ${it.message}") }
                    return@thread
                }
                runOnUiThread {
                    val labels = folders.map { it.first }
                    MaterialAlertDialogBuilder(this)
                        .setTitle(R.string.action_move_to_album)
                        .setItems(labels.toTypedArray()) { _, which ->
                            moveTo(asset, fileId, folders[which].second, folders[which].first)
                        }
                        .setNegativeButton(android.R.string.cancel, null)
                        .show()
                }
            }
        }
    }

    private fun moveTo(asset: MediaAsset, fileId: String, folderId: String, folderName: String) {
        val client = SessionManager.client ?: return
        thread {
            runCatching { client.moveFile(fileId, folderId) }
                .onSuccess { runOnUiThread { snack(getString(R.string.sel_moved, 1, folderName)) } }
                .onFailure {
                    AppLog.w("Viewer", "move failed", it)
                    runOnUiThread { snack("Błąd: ${it.message}") }
                }
        }
    }

    private fun confirmDelete(alsoLocal: Boolean) {
        val asset = shownAsset ?: return
        MaterialAlertDialogBuilder(this)
            .setMessage(getString(if (alsoLocal) R.string.sel_everywhere_confirm else R.string.sel_trash_confirm, 1))
            .setPositiveButton(R.string.action_delete_cloud) { _, _ -> trashCurrent(asset, alsoLocal) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun trashCurrent(asset: MediaAsset, alsoLocal: Boolean) {
        requireSession {
            val client = SessionManager.client ?: return@requireSession
            thread {
                val db = AppDb(this)
                val fileId = db.fileIdForAny(asset)
                val trashed = fileId != null && runCatching { client.deleteFile(fileId) }
                    .onFailure { AppLog.w("Viewer", "trash failed", it) }.getOrDefault(false)
                // cloud-only item trashed → drop its local preview entry so it vanishes from the grid
                if (trashed && asset.cloudFileId != null) {
                    asset.previewPath?.let { runCatching { java.io.File(it).delete() } }
                    db.forgetCloudItem(asset.cloudFileId)
                }
                runOnUiThread {
                    snack(if (trashed) getString(R.string.sel_trashed, 1) else getString(R.string.sel_none_synced))
                    when {
                        alsoLocal && asset.cloudFileId == null -> deleteCurrentLocal() // removes the device copy too
                        asset.cloudFileId != null -> reloadAfterLocalRemoval() // no local copy; just refresh
                    }
                }
            }
        }
    }

    private fun deleteCurrentLocal() {
        val asset = shownAsset ?: return
        if (asset.cloudFileId != null) { snack(getString(R.string.viewer_cloud_only)); return } // no local copy
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            val request = android.provider.MediaStore.createDeleteRequest(contentResolver, listOf(asset.uri))
            localDeleteLauncher.launch(IntentSenderRequest.Builder(request.intentSender).build())
        } else {
            runCatching { contentResolver.delete(asset.uri, null, null) }
            reloadAfterLocalRemoval()
        }
    }

    private fun showInfoDialog() {
        val asset = shownAsset ?: return
        snack(getString(R.string.viewer_info_loading))
        thread {
            val db = AppDb(this)
            val fileId = db.fileIdForAny(asset)
            val hasLocalAi = fileId?.let { db.enrichmentFor(it) != null } ?: false
            // best-effort cloud status (only if a session is already live)
            val remoteStatus = if (fileId != null && SessionManager.isLoggedIn) {
                runCatching { SessionManager.client?.file(fileId)?.status }.getOrNull()
            } else {
                null
            }
            val df = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
            val cloud = when {
                fileId == null -> getString(R.string.viewer_info_cloud_no)
                remoteStatus != null -> getString(R.string.viewer_info_cloud_yes, remoteStatus)
                else -> getString(R.string.viewer_info_cloud_synced)
            }
            val text = buildString {
                append(getString(R.string.viewer_info_name, asset.displayName)).append('\n')
                append(getString(R.string.viewer_info_album, asset.bucketName)).append('\n')
                append(getString(R.string.viewer_info_type, asset.mimeType)).append('\n')
                append(getString(R.string.viewer_info_size, Formatter.formatShortFileSize(this@ViewerActivity, asset.sizeBytes))).append('\n')
                append(getString(R.string.viewer_info_date, df.format(Date(asset.dateAddedSec * 1000)))).append('\n')
                append(getString(R.string.viewer_info_cloud, cloud)).append('\n')
                append(getString(R.string.viewer_info_ai, getString(if (hasLocalAi) R.string.viewer_info_yes else R.string.viewer_info_no)))
            }
            runOnUiThread {
                MaterialAlertDialogBuilder(this)
                    .setTitle(R.string.viewer_info_title)
                    .setMessage(text)
                    .setPositiveButton(android.R.string.ok, null)
                    .show()
            }
        }
    }

    private fun snack(msg: String) =
        Snackbar.make(findViewById(R.id.viewerRoot), msg, Snackbar.LENGTH_LONG).show()

    private fun togglePanel() {
        panelVisible = !panelVisible
        val v = if (panelVisible) View.VISIBLE else View.GONE
        infoPanel.visibility = v
        toolbar.visibility = v
    }

    /** Attaches the shared player to the tapped video page and starts inline playback. */
    private fun startPlayback(playerView: PlayerView, image: ImageView, play: ImageView, asset: MediaAsset) {
        if (asset.cloudFileId != null) {
            startCloudPlayback(playerView, image, play, asset) // fetch full file on demand, then play
        } else {
            playFromUri(playerView, image, play, asset.uri)
        }
    }

    /** Downloads a cloud-only video's full file to cache, then plays it inline. */
    private fun startCloudPlayback(playerView: PlayerView, image: ImageView, play: ImageView, asset: MediaAsset) {
        val client = SessionManager.client
        val filesKey = SessionManager.filesKey
        val fileId = asset.cloudFileId ?: return
        if (client == null || filesKey == null) { snack(getString(R.string.viewer_needs_session)); return }
        snack(getString(R.string.viewer_fetching_video))
        thread {
            try {
                val file = client.file(fileId) ?: error("file gone")
                val cache = java.io.File(cacheDir, "cloud-video-${asset.id}.bin")
                java.io.FileOutputStream(cache).use { UploadEngine(client).downloadToStream(file, filesKey, it) }
                runOnUiThread {
                    if (shownAsset?.id == asset.id) playFromUri(playerView, image, play, Uri.fromFile(cache))
                }
            } catch (e: Throwable) {
                AppLog.w("Viewer", "cloud video fetch failed for ${asset.displayName}", e)
                runOnUiThread { snack("Błąd: ${e.message}") }
            }
        }
    }

    private fun playFromUri(playerView: PlayerView, image: ImageView, play: ImageView, uri: Uri) {
        stopPlayback()
        val p = ExoPlayer.Builder(this).build()
        playerView.player = p
        playerView.visibility = View.VISIBLE
        image.visibility = View.GONE
        play.visibility = View.GONE
        p.setMediaItem(MediaItem.fromUri(uri))
        p.prepare()
        p.playWhenReady = true
        player = p
        activePlayerView = playerView
        activeImage = image
        activePlay = play
        attachVideoZoom(playerView)
    }

    /** Two-finger pinch zoom for the playing video; single-finger taps still reach the controls. */
    @Suppress("ClickableViewAccessibility")
    private fun attachVideoZoom(playerView: PlayerView) {
        val detector = ScaleGestureDetector(
            this,
            object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScale(d: ScaleGestureDetector): Boolean {
                    val scale = (playerView.scaleX * d.scaleFactor).coerceIn(1f, 5f)
                    playerView.scaleX = scale
                    playerView.scaleY = scale
                    if (scale == 1f) { playerView.translationX = 0f; playerView.translationY = 0f }
                    return true
                }
            },
        )
        playerView.setOnTouchListener { _, event ->
            detector.onTouchEvent(event)
            detector.isInProgress // consume only while pinching; taps fall through to controls
        }
    }

    private fun resetViewTransform(view: View) {
        view.scaleX = 1f
        view.scaleY = 1f
        view.translationX = 0f
        view.translationY = 0f
    }

    private fun stopPlayback() {
        player?.release()
        player = null
        activePlayerView?.let { it.player = null; it.visibility = View.GONE; it.setOnTouchListener(null); resetViewTransform(it) }
        activeImage?.visibility = View.VISIBLE
        activePlay?.visibility = View.VISIBLE
        activePlayerView = null
        activeImage = null
        activePlay = null
    }

    override fun onPause() {
        super.onPause()
        player?.pause()
    }

    override fun onDestroy() {
        super.onDestroy()
        stopPlayback()
    }

    private inner class PageAdapter : RecyclerView.Adapter<PageAdapter.PageHolder>() {

        private val decoder = Executors.newFixedThreadPool(2)

        inner class PageHolder(view: View) : RecyclerView.ViewHolder(view) {
            val image: ZoomableImageView = view.findViewById(R.id.pageImage)
            val play: ImageView = view.findViewById(R.id.pagePlay)
            val playerView: PlayerView = view.findViewById(R.id.playerView)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) = PageHolder(
            LayoutInflater.from(parent.context).inflate(R.layout.item_viewer_page, parent, false),
        )

        override fun getItemCount() = assets.size

        override fun onBindViewHolder(holder: PageHolder, position: Int) {
            val asset = assets[position]
            holder.image.tag = asset.id
            holder.image.setImageDrawable(null)
            // reset any recycled player state
            holder.playerView.player = null
            holder.playerView.visibility = View.GONE
            resetViewTransform(holder.playerView)
            holder.image.visibility = View.VISIBLE
            holder.play.visibility = if (asset.isVideo) View.VISIBLE else View.GONE
            holder.image.onSingleTap = { togglePanel() }
            holder.play.setOnClickListener { startPlayback(holder.playerView, holder.image, holder.play, asset) }

            decoder.execute {
                // First paint: a fast local image. Cloud-only items use their cached
                // preview; local items decode the MediaStore file / video thumbnail.
                val initial = when {
                    asset.previewPath != null -> decodeFile(asset.previewPath)
                    asset.isVideo -> runCatching {
                        contentResolver.loadThumbnail(asset.uri, android.util.Size(1280, 1280), null)
                    }.getOrNull()
                    else -> decodeScaled(asset)
                }
                runOnUiThread {
                    if (holder.image.tag == asset.id && initial != null) holder.image.setImageBitmap(initial)
                }
                // Cloud-only photo: fetch the full file on demand and swap in the sharp
                // image for zoom (video full files are fetched on the play tap instead).
                if (asset.cloudFileId != null && !asset.isVideo) fetchFullImage(holder, asset)
            }
        }

        /** Downloads a cloud-only photo's full bytes and swaps the sharp image in. */
        private fun fetchFullImage(holder: PageHolder, asset: MediaAsset) {
            val client = SessionManager.client ?: return // offline → keep the preview
            val filesKey = SessionManager.filesKey ?: return
            val fileId = asset.cloudFileId ?: return
            runCatching {
                val file = client.file(fileId) ?: return
                val bytes = UploadEngine(client).downloadFile(file, filesKey)
                val bmp = decodeScaledBytes(bytes) ?: return
                runOnUiThread {
                    if (holder.image.tag == asset.id) holder.image.setImageBitmap(bmp)
                }
            }.onFailure { AppLog.w("Viewer", "full image fetch failed for ${asset.displayName}", it) }
        }

        private fun decodeScaled(asset: MediaAsset): Bitmap? = runCatching {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            contentResolver.openInputStream(asset.uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            val sample = sampleSizeFor(bounds.outWidth, bounds.outHeight)
            contentResolver.openInputStream(asset.uri)?.use { stream ->
                BitmapFactory.decodeStream(stream, null, BitmapFactory.Options().apply { inSampleSize = sample })
            }
        }.getOrNull()

        private fun decodeFile(path: String): Bitmap? = runCatching {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, bounds)
            BitmapFactory.decodeFile(path, BitmapFactory.Options().apply {
                inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight)
            })
        }.getOrNull()

        private fun decodeScaledBytes(bytes: ByteArray): Bitmap? = runCatching {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply {
                inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight)
            })
        }.getOrNull()

        private fun sampleSizeFor(w: Int, h: Int): Int {
            val screenMax = maxOf(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
            var sample = 1
            while (maxOf(w, h) / (sample * 2) >= screenMax) sample *= 2
            return sample
        }
    }
}
