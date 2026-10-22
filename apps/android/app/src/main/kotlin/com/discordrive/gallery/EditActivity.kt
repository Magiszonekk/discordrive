package com.discordrive.gallery

import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.RectF
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.Toast
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.google.android.material.snackbar.Snackbar
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

/**
 * Simple photo editor: crop (draggable frame with corner handles), rotate 90°,
 * horizontal flip, reset. Non-destructive — "Zapisz kopię" writes the result
 * as a NEW image to Pictures/DiscorDrive via MediaStore (the original stays;
 * the copy is picked up by sync like any other photo).
 */
class EditActivity : SessionActivity() {

    private lateinit var image: ImageView
    private lateinit var overlay: CropOverlayView
    private lateinit var loading: ProgressBar
    private lateinit var buttons: List<MaterialButton>

    private var original: Bitmap? = null
    private var working: Bitmap? = null
    private var saving = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_edit)
        Insets.apply(findViewById(R.id.editRoot))

        val toolbar = findViewById<MaterialToolbar>(R.id.editToolbar)
        toolbar.setNavigationOnClickListener { finish() }
        image = findViewById(R.id.editImage)
        overlay = findViewById(R.id.cropOverlay)
        loading = findViewById(R.id.editLoading)

        buttons = listOf(
            findViewById<MaterialButton>(R.id.rotateButton).apply { setOnClickListener { transform { m -> m.postRotate(90f) } } },
            findViewById<MaterialButton>(R.id.flipButton).apply { setOnClickListener { transform { m -> m.postScale(-1f, 1f) } } },
            findViewById<MaterialButton>(R.id.resetButton).apply { setOnClickListener { resetAll() } },
            findViewById<MaterialButton>(R.id.saveButton).apply { setOnClickListener { saveCopy() } },
        )
        setButtonsEnabled(false)

        loadPhoto(intent.getLongExtra("assetId", -1))
    }

    private fun loadPhoto(assetId: Long) {
        thread {
            val asset = MediaScanner(this).findById(assetId)
            val bitmap = asset?.let {
                runCatching { PhotoLoader.decodeAsset(this, it, PhotoLoader.screenMaxDim(this)) }.getOrNull()
            }
            runOnUiThread {
                loading.visibility = View.GONE
                if (bitmap == null) {
                    Toast.makeText(this, R.string.wallpaper_load_failed, Toast.LENGTH_LONG).show()
                    finish()
                    return@runOnUiThread
                }
                original = bitmap
                setWorking(bitmap)
                setButtonsEnabled(true)
            }
        }
    }

    /** Swaps in a new working bitmap and re-fits the crop frame to it. */
    private fun setWorking(bitmap: Bitmap) {
        working = bitmap
        image.setImageBitmap(bitmap)
        image.post { overlay.setImageRect(displayedImageRect(bitmap)) }
    }

    /** On-screen bounds of the fit-centered bitmap, in overlay coordinates. */
    private fun displayedImageRect(bitmap: Bitmap): RectF {
        val vw = image.width.toFloat()
        val vh = image.height.toFloat()
        val bw = bitmap.width.toFloat()
        val bh = bitmap.height.toFloat()
        if (vw <= 0 || vh <= 0 || bw <= 0 || bh <= 0) return RectF()
        val scale = minOf(vw / bw, vh / bh)
        val w = bw * scale
        val h = bh * scale
        val left = (vw - w) / 2f
        val top = (vh - h) / 2f
        return RectF(left, top, left + w, top + h)
    }

    /** Commits a pending crop frame into the working bitmap (no-op when full). */
    private fun commitCrop() {
        val bmp = working ?: return
        val f = overlay.cropFraction() ?: return
        val x = (f.left * bmp.width).toInt().coerceIn(0, bmp.width - 1)
        val y = (f.top * bmp.height).toInt().coerceIn(0, bmp.height - 1)
        val w = ((f.right - f.left) * bmp.width).toInt().coerceIn(1, bmp.width - x)
        val h = ((f.bottom - f.top) * bmp.height).toInt().coerceIn(1, bmp.height - y)
        setWorking(Bitmap.createBitmap(bmp, x, y, w, h))
    }

    /** Applies a matrix op (rotate/flip); a pending crop is committed first. */
    private fun transform(op: (Matrix) -> Unit) {
        commitCrop()
        val bmp = working ?: return
        val m = Matrix().also(op)
        setWorking(Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true))
    }

    private fun resetAll() {
        original?.let { setWorking(it) }
    }

    /** Renders the current edit (crop + transforms) into a new MediaStore image. */
    private fun saveCopy() {
        if (saving) return
        commitCrop()
        val bmp = working ?: return
        saving = true
        setButtonsEnabled(false)
        loading.visibility = View.VISIBLE
        thread {
            try {
                val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, "edit-$stamp.jpg")
                    put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/DiscorDrive")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    ?: error("MediaStore insert failed")
                contentResolver.openOutputStream(uri)?.use { out ->
                    if (!bmp.compress(Bitmap.CompressFormat.JPEG, 95, out)) error("compress failed")
                } ?: error("cannot open output")
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)
                runOnUiThread {
                    Toast.makeText(this, R.string.edit_saved, Toast.LENGTH_LONG).show()
                    finish()
                }
            } catch (e: Exception) {
                AppLog.w("Edit", "save edited copy failed", e)
                runOnUiThread {
                    saving = false
                    loading.visibility = View.GONE
                    setButtonsEnabled(true)
                    Snackbar.make(findViewById(R.id.editRoot), "Błąd: ${e.message}", Snackbar.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun setButtonsEnabled(enabled: Boolean) {
        buttons.forEach { it.isEnabled = enabled }
    }
}
