package com.discordrive.gallery

import android.app.WallpaperManager
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.concurrent.thread

/**
 * Set a photo of the account as the wallpaper: the photo fills the screen (centre-crop), the user pans and
 * pinches to frame it, and what the screen shows becomes the wallpaper of the home screen, the lock screen or
 * both. The picture is the full file when it is not too big, else the stored preview.
 */
class DdnWallpaperActivity : AppCompatActivity() {
    private lateinit var crop: ZoomableImageView
    private lateinit var loading: com.google.android.material.progressindicator.CircularProgressIndicator
    private lateinit var buttons: List<com.google.android.material.button.MaterialButton>
    private lateinit var chrome: List<View>
    private var loaded = false
    private var applying = false

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        val ui = CobaltUi(this)
        val onScrim = getColor(R.color.cobalt_on_scrim)
        val root = FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) }
        crop = ZoomableImageView(this).apply { fillViewport = true; onSingleTap = { toggle() } }
        root.addView(crop, FrameLayout.LayoutParams(-1, -1))
        loading = com.google.android.material.progressindicator.CircularProgressIndicator(this).apply { isIndeterminate = true }
        root.addView(loading, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundResource(R.drawable.bg_cobalt_scrim_top)
            addView(ImageView(this@DdnWallpaperActivity).apply {
                setImageResource(R.drawable.ic_cobalt_back); setColorFilter(onScrim); contentDescription = getString(R.string.cobalt_back)
                setPadding(ui.dp(12), ui.dp(12), ui.dp(12), ui.dp(12))
                val tv = android.util.TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true); setBackgroundResource(tv.resourceId)
                setOnClickListener { finish() }
            }, LinearLayout.LayoutParams(ui.dp(48), ui.dp(48)))
            addView(TextView(this@DdnWallpaperActivity).apply {
                setText(R.string.wallpaper_ui_title)
                androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); setTextColor(onScrim)
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = ui.dp(4) })
        }
        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_cobalt_scrim_bottom)
            addView(TextView(this@DdnWallpaperActivity).apply {
                setText(R.string.wallpaper_hint); gravity = Gravity.CENTER
                androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Meta); setTextColor(onScrim); alpha = 0.85f
            }, LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        buttons = listOf(
            ui.button(R.string.wallpaper_home, CobaltUi.Kind.TONAL) { apply(WallpaperManager.FLAG_SYSTEM) },
            ui.button(R.string.wallpaper_lock, CobaltUi.Kind.TONAL) { apply(WallpaperManager.FLAG_LOCK) },
            ui.button(R.string.wallpaper_both, CobaltUi.Kind.PRIMARY) { apply(WallpaperManager.FLAG_SYSTEM or WallpaperManager.FLAG_LOCK) },
        )
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        buttons.forEachIndexed { i, b ->
            b.maxLines = 1
            // Over the photo: the two tonal ones light on a translucent fill (the theme's tonal is for paper).
            if (i < 2) { b.backgroundTintList = android.content.res.ColorStateList.valueOf(0x40FFFFFF); b.setTextColor(onScrim) }
            androidx.core.widget.TextViewCompat.setAutoSizeTextTypeUniformWithConfiguration(b, 10, 14, 1, android.util.TypedValue.COMPLEX_UNIT_SP)
            row.addView(b, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { if (i > 0) marginStart = ui.dp(8) })
        }
        bottom.addView(row, LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = ui.dp(10) })
        root.addView(top, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        root.addView(bottom, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        setContentView(root)
        chrome = listOf(top, bottom)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        WindowCompat.getInsetsController(window, root).apply { isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false }
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, ins ->
            val b = ins.getInsets(WindowInsetsCompat.Type.systemBars())
            top.setPadding(ui.dp(4) + b.left, ui.dp(4) + b.top, ui.dp(4) + b.right, ui.dp(20))
            bottom.setPadding(ui.dp(16) + b.left, ui.dp(28), ui.dp(16) + b.right, ui.dp(16) + b.bottom)
            ins
        }
        buttons.forEach { it.isEnabled = false }
        load()
    }

    private fun load() {
        val id = intent.getStringExtra(EXTRA_ID) ?: return finish()
        val maxPx = (2 * maxOf(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)).coerceAtMost(4096)
        thread {
            val b = runCatching {
                val s = DdnSession.get(this)!!
                val c = s.node(id)!!
                val ref = c.manifestRef!!
                val size = c.size ?: 0
                (if (size in 1..DdnViewerActivity.FULL_IMAGE_MAX) DdnThumbs.decode(s.files.range(ref, size, 0, size - 1), maxPx) else null)
                    ?.let { rotated(it, s.files.range(ref, size, 0, minOf(size, 256L * 1024) - 1)) }
                    ?: DdnThumbs.load(s, ref, 'p', maxPx)
            }.getOrNull()
            runOnUiThread {
                loading.visibility = View.GONE
                if (b == null) { Toast.makeText(this, R.string.wallpaper_load_failed, Toast.LENGTH_LONG).show(); finish(); return@runOnUiThread }
                crop.setImageBitmap(b)
                loaded = true
                buttons.forEach { it.isEnabled = true }
            }
        }
    }

    /** The photo as it is seen (its EXIF orientation applied). */
    private fun rotated(b: android.graphics.Bitmap, head: ByteArray): android.graphics.Bitmap {
        val deg = runCatching { when (android.media.ExifInterface(head.inputStream()).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) { 6 -> 90f; 3 -> 180f; 8 -> 270f; else -> 0f } }.getOrDefault(0f)
        if (deg == 0f) return b
        return android.graphics.Bitmap.createBitmap(b, 0, 0, b.width, b.height, android.graphics.Matrix().apply { postRotate(deg) }, true)
    }

    private fun apply(flags: Int) {
        if (!loaded || applying) return
        val bmp = crop.renderVisible() ?: return
        applying = true
        buttons.forEach { it.isEnabled = false }
        loading.visibility = View.VISIBLE
        thread {
            val r = runCatching { WallpaperManager.getInstance(this).setBitmap(bmp, null, true, flags) }
            runOnUiThread {
                r.onSuccess {
                    // The app's context: the toast stays after this screen closes.
                    Toast.makeText(applicationContext, R.string.wallpaper_done, Toast.LENGTH_SHORT).show()
                    finish()
                }.onFailure {
                    applying = false
                    loading.visibility = View.GONE
                    buttons.forEach { b -> b.isEnabled = true }
                    Toast.makeText(this, DdnErrors.text(this, it), Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun toggle() {
        val on = chrome.first().visibility != View.VISIBLE
        chrome.forEach { it.visibility = if (on) View.VISIBLE else View.GONE }
    }

    internal fun loadedForTest() = loaded

    companion object {
        const val EXTRA_ID = "id"
    }
}
