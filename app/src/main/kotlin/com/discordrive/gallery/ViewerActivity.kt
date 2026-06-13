package com.discordrive.gallery

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * Full-screen viewer with horizontal swipe between the album's items
 * (gallery-style). Images load full-screen; videos show a poster frame with a
 * play button; tapping play streams the file inline via ExoPlayer (no external
 * app). Tap toggles the info panel (name + AI description/tags).
 */
class ViewerActivity : AppCompatActivity() {

    private var panelVisible = true
    private var assets: List<MediaAsset> = emptyList()

    private lateinit var infoPanel: View
    private lateinit var nameView: TextView
    private lateinit var descriptionView: TextView
    private lateinit var chips: ChipGroup

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
        nameView = findViewById(R.id.fileName)
        descriptionView = findViewById(R.id.description)
        chips = findViewById(R.id.tagChips)

        thread {
            val all = MediaScanner(this).scanAll()
            val scoped = if (bucket != null) all.filter { it.bucketName == bucket } else all
            val list = if (scoped.any { it.id == assetId }) scoped else all
            val start = list.indexOfFirst { it.id == assetId }
            if (start < 0) {
                runOnUiThread { finish() }
                return@thread
            }

            runOnUiThread {
                assets = list
                pager.adapter = PageAdapter()
                pager.setCurrentItem(start, false)
                pager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
                    override fun onPageSelected(position: Int) {
                        stopPlayback() // releases any video playing on the previous page
                        showInfo(assets[position])
                    }
                })
                showInfo(assets[start])
            }
        }
    }

    private fun showInfo(asset: MediaAsset) {
        nameView.text = asset.displayName
        descriptionView.text = ""
        chips.removeAllViews()
        thread {
            val db = AppDb(this)
            val record = db.fileIdFor(asset)?.let { db.enrichmentFor(it) }
            runOnUiThread {
                if (nameView.text != asset.displayName) return@runOnUiThread // already swiped on
                if (record != null) {
                    descriptionView.text = record.description
                    chips.removeAllViews()
                    record.tags.take(10).forEach { tag ->
                        chips.addView(Chip(this).apply { text = tag; isClickable = false })
                    }
                } else {
                    descriptionView.text = getString(R.string.viewer_no_enrichment)
                }
            }
        }
    }

    private fun togglePanel() {
        panelVisible = !panelVisible
        infoPanel.visibility = if (panelVisible) View.VISIBLE else View.GONE
    }

    /** Attaches the shared player to the tapped video page and starts inline playback. */
    private fun startPlayback(playerView: PlayerView, image: ImageView, play: ImageView, asset: MediaAsset) {
        stopPlayback()
        val p = ExoPlayer.Builder(this).build()
        playerView.player = p
        playerView.visibility = View.VISIBLE
        image.visibility = View.GONE
        play.visibility = View.GONE
        p.setMediaItem(MediaItem.fromUri(asset.uri))
        p.prepare()
        p.playWhenReady = true
        player = p
        activePlayerView = playerView
        activeImage = image
        activePlay = play
    }

    private fun stopPlayback() {
        player?.release()
        player = null
        activePlayerView?.let { it.player = null; it.visibility = View.GONE }
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
            val image: ImageView = view.findViewById(R.id.pageImage)
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
            holder.image.visibility = View.VISIBLE
            holder.play.visibility = if (asset.isVideo) View.VISIBLE else View.GONE
            holder.image.setOnClickListener { togglePanel() }
            holder.play.setOnClickListener { startPlayback(holder.playerView, holder.image, holder.play, asset) }

            decoder.execute {
                val bitmap = if (asset.isVideo) {
                    runCatching {
                        contentResolver.loadThumbnail(asset.uri, android.util.Size(1280, 1280), null)
                    }.getOrNull()
                } else {
                    decodeScaled(asset)
                }
                runOnUiThread {
                    if (holder.image.tag == asset.id && bitmap != null) holder.image.setImageBitmap(bitmap)
                }
            }
        }

        private fun decodeScaled(asset: MediaAsset): Bitmap? = runCatching {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            contentResolver.openInputStream(asset.uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            val screenMax = maxOf(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= screenMax) sample *= 2
            contentResolver.openInputStream(asset.uri)?.use { stream ->
                BitmapFactory.decodeStream(stream, null, BitmapFactory.Options().apply { inSampleSize = sample })
            }
        }.getOrNull()
    }
}
