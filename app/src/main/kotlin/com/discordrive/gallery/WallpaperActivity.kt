package com.discordrive.gallery

import android.app.WallpaperManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Bundle
import android.view.View
import android.widget.ProgressBar
import android.widget.Toast
import com.discordrive.gallery.api.UploadEngine
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.google.android.material.snackbar.Snackbar
import kotlin.concurrent.thread

/**
 * Full-screen wallpaper cropper: the photo center-crop fills the viewport and
 * the user pans/pinches to frame it — what the screen shows is exactly what
 * becomes the wallpaper (WYSIWYG). The bottom panel picks the target screen
 * (home / lock / both). A tap toggles the chrome, like in the viewer.
 */
class WallpaperActivity : SessionActivity() {

    private lateinit var cropImage: ZoomableImageView
    private lateinit var loading: ProgressBar
    private lateinit var toolbar: MaterialToolbar
    private lateinit var panel: View
    private lateinit var buttons: List<MaterialButton>
    private var chromeVisible = true
    private var loaded = false
    private var applying = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_wallpaper)

        cropImage = findViewById(R.id.cropImage)
        cropImage.fillViewport = true
        cropImage.onSingleTap = { toggleChrome() }
        loading = findViewById(R.id.loading)
        toolbar = findViewById(R.id.wallpaperToolbar)
        Insets.apply(toolbar, bottom = false)
        toolbar.setNavigationOnClickListener { finish() }
        panel = findViewById(R.id.targetPanel)
        Insets.apply(panel, top = false)

        buttons = listOf(
            findViewById<MaterialButton>(R.id.setHomeButton).apply {
                setOnClickListener { apply(WallpaperManager.FLAG_SYSTEM) }
            },
            findViewById<MaterialButton>(R.id.setLockButton).apply {
                setOnClickListener { apply(WallpaperManager.FLAG_LOCK) }
            },
            findViewById<MaterialButton>(R.id.setBothButton).apply {
                setOnClickListener { apply(WallpaperManager.FLAG_SYSTEM or WallpaperManager.FLAG_LOCK) }
            },
        )
        setButtonsEnabled(false)

        val assetId = intent.getLongExtra("assetId", -1)
        loadPhoto(assetId)
    }

    /** Decodes the photo (downloading cloud-only bytes first) into the cropper. */
    private fun loadPhoto(assetId: Long) {
        thread {
            val asset = MediaScanner(this).findById(assetId)
            val bitmap = asset?.let { runCatching { decodeAsset(it) }.getOrNull() }
            runOnUiThread {
                loading.visibility = View.GONE
                if (bitmap == null) {
                    Toast.makeText(this, R.string.wallpaper_load_failed, Toast.LENGTH_LONG).show()
                    finish()
                    return@runOnUiThread
                }
                cropImage.setImageBitmap(bitmap)
                loaded = true
                setButtonsEnabled(true)
            }
        }
    }

    private fun decodeAsset(asset: MediaAsset): Bitmap? {
        val maxDim = (2 * maxOf(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels))
            .coerceAtMost(4096)
        return if (asset.cloudFileId != null) {
            val client = SessionManager.client ?: error(getString(R.string.viewer_needs_session))
            val filesKey = SessionManager.filesKey ?: error(getString(R.string.viewer_needs_session))
            val file = client.file(asset.cloudFileId) ?: error("plik zniknął z chmury")
            val bytes = UploadEngine(client).downloadFile(file, filesKey)
            decodeLimited(maxDim) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, it) }
        } else {
            decodeLimited(maxDim) { opts ->
                contentResolver.openInputStream(asset.uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
            }
        }
    }

    /** Two-pass decode (bounds, then sampled) keeping the longer edge under [maxDim]. */
    private fun decodeLimited(maxDim: Int, decode: (BitmapFactory.Options) -> Bitmap?): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        decode(bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxDim) sample *= 2
        return decode(BitmapFactory.Options().apply { inSampleSize = sample })
    }

    /** Sets the currently visible crop as the wallpaper for the chosen screen(s). */
    private fun apply(flags: Int) {
        if (!loaded || applying) return
        val crop = cropImage.renderVisible() ?: return
        applying = true
        setButtonsEnabled(false)
        loading.visibility = View.VISIBLE
        thread {
            try {
                WallpaperManager.getInstance(this).setBitmap(crop, null, true, flags)
                runOnUiThread {
                    // Toast outlives the activity, unlike a snackbar
                    Toast.makeText(this, R.string.wallpaper_done, Toast.LENGTH_SHORT).show()
                    finish()
                }
            } catch (e: Exception) {
                AppLog.w("Wallpaper", "set wallpaper failed", e)
                runOnUiThread {
                    applying = false
                    loading.visibility = View.GONE
                    setButtonsEnabled(true)
                    Snackbar.make(findViewById(R.id.wallpaperRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun setButtonsEnabled(enabled: Boolean) {
        buttons.forEach { it.isEnabled = enabled }
    }

    private fun toggleChrome() {
        chromeVisible = !chromeVisible
        val v = if (chromeVisible) View.VISIBLE else View.GONE
        toolbar.visibility = v
        panel.visibility = v
    }
}
