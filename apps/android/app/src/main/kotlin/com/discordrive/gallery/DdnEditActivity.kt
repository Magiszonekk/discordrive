package com.discordrive.gallery

import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.RectF
import android.os.Bundle
import android.view.View
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import io.github.magiszonekk.discordrive.core.FileWrite
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

/**
 * Edit a photo of the account: crop (drag the frame), rotate, mirror; "Save a copy" uploads the result into
 * the same folder as "<name> (edycja).jpg", with its thumbnail and preview, so the original stays as it was
 * (every device sees both). The picture is the full file when it is not too big, else the stored preview.
 */
class DdnEditActivity : AppCompatActivity() {
    private lateinit var image: ImageView
    private lateinit var overlay: CropOverlayView
    private lateinit var loading: ProgressBar
    private lateinit var buttons: List<MaterialButton>
    private var original: Bitmap? = null
    private var working: Bitmap? = null
    @Volatile private var saving = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_edit)
        Insets.apply(findViewById(R.id.editRoot))
        findViewById<MaterialToolbar>(R.id.editToolbar).setNavigationOnClickListener { finish() }
        image = findViewById(R.id.editImage)
        overlay = findViewById(R.id.cropOverlay)
        loading = findViewById(R.id.editLoading)
        buttons = listOf(
            findViewById<MaterialButton>(R.id.rotateButton).apply { setOnClickListener { transform { m -> m.postRotate(90f) } } },
            findViewById<MaterialButton>(R.id.flipButton).apply { setOnClickListener { transform { m -> m.postScale(-1f, 1f) } } },
            findViewById<MaterialButton>(R.id.resetButton).apply { setOnClickListener { original?.let { setWorking(it) } } },
            findViewById<MaterialButton>(R.id.saveButton).apply { setText(R.string.ddn_edit_save); setOnClickListener { save() } },
        )
        buttons.forEach { it.isEnabled = false }
        load()
    }

    private fun load() {
        val id = intent.getStringExtra(EXTRA_ID) ?: return finish()
        thread {
            val b = runCatching {
                val s = DdnSession.get(this)!!
                val c = s.node(id)!!
                val ref = c.manifestRef!!
                val size = c.size ?: 0
                if (size in 1..FULL_MAX) DdnThumbs.decode(s.files.range(ref, size, 0, size - 1), MAX_PX) else DdnThumbs.load(s, ref, 'p', MAX_PX)
            }.getOrNull()
            runOnUiThread {
                loading.visibility = View.GONE
                if (b == null) { Toast.makeText(this, R.string.ddn_edit_cannot, Toast.LENGTH_LONG).show(); finish(); return@runOnUiThread }
                original = b
                setWorking(b)
                buttons.forEach { it.isEnabled = true }
                loadedForTest = true
            }
        }
    }

    private fun setWorking(b: Bitmap) {
        working = b
        image.setImageBitmap(b)
        image.post { overlay.setImageRect(shownRect(b)) }
    }

    private fun shownRect(b: Bitmap): RectF {
        val vw = image.width.toFloat(); val vh = image.height.toFloat()
        if (vw <= 0 || vh <= 0) return RectF()
        val sc = minOf(vw / b.width, vh / b.height)
        val w = b.width * sc; val h = b.height * sc
        return RectF((vw - w) / 2, (vh - h) / 2, (vw + w) / 2, (vh + h) / 2)
    }

    private fun commitCrop() {
        val b = working ?: return
        val f = overlay.cropFraction() ?: return
        val x = (f.left * b.width).toInt().coerceIn(0, b.width - 1)
        val y = (f.top * b.height).toInt().coerceIn(0, b.height - 1)
        val w = ((f.right - f.left) * b.width).toInt().coerceIn(1, b.width - x)
        val h = ((f.bottom - f.top) * b.height).toInt().coerceIn(1, b.height - y)
        setWorking(Bitmap.createBitmap(b, x, y, w, h))
    }

    private fun transform(op: (Matrix) -> Unit) {
        commitCrop()
        val b = working ?: return
        setWorking(Bitmap.createBitmap(b, 0, 0, b.width, b.height, Matrix().also(op), true))
    }

    internal fun rotateForTest() = transform { m -> m.postRotate(90f) }

    private fun save() {
        if (saving) return
        commitCrop()
        val b = working ?: return
        saving = true
        buttons.forEach { it.isEnabled = false }
        loading.visibility = View.VISIBLE
        val id = intent.getStringExtra(EXTRA_ID)!!
        thread {
            val r = runCatching {
                val s = DdnSession.get(this)!!
                val c = s.node(id)!!
                val jpeg = ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.JPEG, 92, it) }.toByteArray()
                val name = editedName(c.name)
                s.uploader(parallel = 2).upload({ jpeg.inputStream() }, jpeg.size.toLong(), name, c.parentId ?: "root", pictures(b))
                name
            }
            runOnUiThread {
                saving = false
                loading.visibility = View.GONE
                buttons.forEach { it.isEnabled = true }
                r.onSuccess { Toast.makeText(this, getString(R.string.ddn_edit_saved, it), Toast.LENGTH_LONG).show(); savedForTest = it; finish() }
                    .onFailure { Toast.makeText(this, getString(R.string.ddn_error, it.message), Toast.LENGTH_LONG).show() }
            }
        }
    }

    /** The thumbnail and the preview of the edited picture (the rules of every client: WebP, short side 320 / long 1280). */
    private fun pictures(b: Bitmap): List<FileWrite.Picture> = listOfNotNull(
        DdnPictures.encode(b, 't'),
        DdnPictures.encode(b, 'p'),
    )

    companion object {
        const val EXTRA_ID = "id"
        private const val FULL_MAX = 40L * 1024 * 1024
        private const val MAX_PX = 4096

        /** "IMG_1.jpg" → "IMG_1 (edycja).jpg" (always .jpg: the copy is a JPEG). */
        fun editedName(name: String): String {
            val base = name.substringBeforeLast('.', name)
            return "$base (edycja).jpg"
        }

        @Volatile internal var savedForTest: String? = null
        @Volatile internal var loadedForTest = false
    }
}
