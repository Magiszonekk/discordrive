package com.discordrive.gallery

import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Bundle
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import kotlin.concurrent.thread

/** Full-screen viewer: image + AI description/tags. Videos open externally. */
class ViewerActivity : AppCompatActivity() {

    private var panelVisible = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_viewer)

        val assetId = intent.getLongExtra("assetId", -1)
        val image = findViewById<ImageView>(R.id.fullImage)
        val infoPanel = findViewById<View>(R.id.infoPanel)
        val nameView = findViewById<TextView>(R.id.fileName)
        val descriptionView = findViewById<TextView>(R.id.description)
        val chips = findViewById<ChipGroup>(R.id.tagChips)

        image.setOnClickListener {
            panelVisible = !panelVisible
            infoPanel.visibility = if (panelVisible) View.VISIBLE else View.GONE
        }

        thread {
            val asset = MediaScanner(this).findById(assetId) ?: run { finish(); return@thread }

            if (asset.isVideo) {
                // v1: hand off to the system player
                runOnUiThread {
                    startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(asset.uri, asset.mimeType))
                    finish()
                }
                return@thread
            }

            val bitmap = contentResolver.openInputStream(asset.uri)?.use { stream ->
                BitmapFactory.decodeStream(stream, null, BitmapFactory.Options().apply { inSampleSize = sampleSizeFor(asset) })
            }
            val enrichmentRecord = AppDb(this).fileIdFor(asset)?.let { AppDb(this).enrichmentFor(it) }

            runOnUiThread {
                bitmap?.let(image::setImageBitmap)
                nameView.text = asset.displayName
                if (enrichmentRecord != null) {
                    descriptionView.text = enrichmentRecord.description
                    chips.removeAllViews()
                    enrichmentRecord.tags.take(10).forEach { tag ->
                        chips.addView(Chip(this).apply { text = tag; isClickable = false })
                    }
                } else {
                    descriptionView.text = getString(R.string.viewer_no_enrichment)
                }
            }
        }
    }

    private fun sampleSizeFor(asset: MediaAsset): Int {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        contentResolver.openInputStream(asset.uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        val screenMax = maxOf(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= screenMax) sample *= 2
        return sample
    }
}
