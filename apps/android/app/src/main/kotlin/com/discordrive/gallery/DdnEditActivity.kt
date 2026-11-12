package com.discordrive.gallery

import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.RectF
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.widget.TextViewCompat
import io.github.magiszonekk.discordrive.core.FileWrite
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

/**
 * Edit a photo of the account: crop (drag the frame), rotate, mirror; "Save a copy" uploads the result into
 * the same folder as "<name> (edycja).jpg", with its thumbnail and preview, so the original stays as it was
 * (every device sees both). The picture is the full file when it is not too big, else the stored preview.
 * The copy keeps the original's EXIF (date taken, camera, exposure, GPS position; orientation reset, the
 * pixels are already turned as shown) and its date taken, so it sits next to the original in the Gallery.
 * A file too big to hold in memory without a stored preview is downloaded to the cache and decoded from there,
 * scaled down.
 */
class DdnEditActivity : AppCompatActivity() {
    private lateinit var image: ImageView
    private lateinit var overlay: CropOverlayView
    private lateinit var loading: ProgressBar
    private lateinit var buttons: List<View>
    private var original: Bitmap? = null
    private var working: Bitmap? = null
    @Volatile private var saving = false
    /**
     * The original's EXIF and date taken (read with the picture). AndroidX's reader: the system one does not
     * know some tags (the lens make and model), so it would neither read nor write them.
     */
    @Volatile private var sourceExif: androidx.exifinterface.media.ExifInterface? = null
    @Volatile private var sourceTaken: Long? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        val ui = CobaltUi(this)
        // As the viewer: the photo on black, a bar with back at the top, the tools and "Save a copy" at the bottom.
        val onScrim = getColor(R.color.cobalt_on_scrim)
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundResource(R.drawable.bg_cobalt_scrim_top)
            setPadding(ui.dp(4), ui.dp(4), ui.dp(4), ui.dp(8))
            addView(ImageView(this@DdnEditActivity).apply {
                setImageResource(R.drawable.ic_cobalt_back); setColorFilter(onScrim); contentDescription = getString(R.string.cobalt_back)
                setPadding(ui.dp(12), ui.dp(12), ui.dp(12), ui.dp(12))
                val tv = android.util.TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true); setBackgroundResource(tv.resourceId)
                setOnClickListener { finish() }
            }, LinearLayout.LayoutParams(ui.dp(48), ui.dp(48)))
            addView(TextView(this@DdnEditActivity).apply {
                setText(R.string.edit_title); TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); setTextColor(onScrim)
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = ui.dp(4) })
        }
        // Generous side margins: the crop handles stay clear of the system back-gesture zones at the edges.
        val stage = FrameLayout(this)
        image = ImageView(this).apply { scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = getString(R.string.edit_title) }
        overlay = CropOverlayView(this)
        loading = ProgressBar(this)
        stage.addView(image, FrameLayout.LayoutParams(-1, -1))
        stage.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        stage.addView(loading, FrameLayout.LayoutParams(ui.dp(48), ui.dp(48), Gravity.CENTER))
        // The tools as the viewer's actions (icon over label), then the main button.
        val tools = ui.viewerActions(
            Triple(R.string.edit_rotate, R.drawable.ic_cobalt_rotate) { transform { m -> m.postRotate(90f) } },
            Triple(R.string.edit_flip, R.drawable.ic_cobalt_flip) { transform { m -> m.postScale(-1f, 1f) } },
            Triple(R.string.edit_reset, R.drawable.ic_cobalt_restore) { original?.let { setWorking(it) } },
            dangerLast = false,
        ).apply { background = null; setPadding(ui.dp(8), ui.dp(4), ui.dp(8), ui.dp(4)) }
        val save = ui.button(R.string.ddn_edit_save, CobaltUi.Kind.PRIMARY, R.drawable.ic_cobalt_upload) { save() }.apply { id = R.id.saveButton }
        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_cobalt_scrim_bottom)
            setPadding(ui.dp(16), ui.dp(16), ui.dp(16), ui.dp(12))
            addView(tools, ui.lp())
            addView(save, ui.lp(top = 8))
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.BLACK)
            addView(top, LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(stage, LinearLayout.LayoutParams(-1, 0, 1f).apply { setMargins(ui.dp(28), ui.dp(12), ui.dp(28), ui.dp(12)) })
            addView(bottom, LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        setContentView(root)
        // Light icons on black in both themes.
        window.statusBarColor = android.graphics.Color.BLACK
        window.navigationBarColor = android.graphics.Color.BLACK
        WindowCompat.getInsetsController(window, window.decorView).apply { isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false }
        Insets.apply(root)
        // The tool cells (clickable, enabled with the picture) and the main button.
        buttons = (0 until tools.childCount).map { tools.getChildAt(it) } + save
        enable(false)
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
                val full = if (size in 1..FULL_MAX) s.files.range(ref, size, 0, size - 1) else null
                // EXIF sits at the start of the file: a big one is read only that far.
                val head = full ?: runCatching { if (size > 0) s.files.range(ref, size, 0, minOf(size, EXIF_HEAD) - 1) else null }.getOrNull()
                val sysExif = head?.let { h -> runCatching { android.media.ExifInterface(h.inputStream()) }.getOrNull() }
                sourceExif = head?.let { h -> runCatching { androidx.exifinterface.media.ExifInterface(h.inputStream()) }.getOrNull() }
                sourceTaken = sysExif?.let(DdnPictures::takenAt) ?: runCatching { s.files.manifest(ref).second.takenAt }.getOrNull()
                // The stored preview is already upright; the file is turned here by its orientation tag.
                if (full != null) DdnThumbs.decode(full, MAX_PX)?.let { DdnThumbs.upright(it, sysExif) }
                else DdnThumbs.load(s, ref, 'p', MAX_PX) ?: if (size in 1..BIG_MAX) bigFile(s, ref, size, c.sha256) else null
            }.getOrNull()
            runOnUiThread {
                loading.visibility = View.GONE
                if (b == null) { Toast.makeText(this, R.string.ddn_edit_cannot, Toast.LENGTH_LONG).show(); if (!intent.getBooleanExtra(KEEP_OPEN_FOR_TEST, false)) finish(); return@runOnUiThread }
                original = b
                setWorking(b)
                enable(true)
                loadedForTest = true
            }
        }
    }

    /**
     * A big file without a stored preview (sent by a client that could not make one): the whole file into the
     * cache, decoded from there scaled down to the editor's size, so only the decoded picture sits in memory.
     */
    private fun bigFile(s: DdnSession, ref: String, size: Long, sha256: String?): Bitmap? {
        val f = java.io.File.createTempFile("edit-big-", ".jpg", cacheDir)
        try {
            f.outputStream().buffered().use { out -> s.files.download(ref, size, sha256, out) }
            return decodeFileUpright(f, MAX_PX)
        } finally {
            f.delete()
        }
    }

    /** The tools and Save work once the picture is there (and not while saving); dimmed when they do not. */
    private fun enable(on: Boolean) = buttons.forEach { it.isEnabled = on; it.alpha = if (on) 1f else 0.38f }

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
    internal fun toolsEnabledForTest(): Boolean = buttons.all { it.isEnabled }

    private fun save() {
        if (saving) return
        commitCrop()
        val b = working ?: return
        saving = true
        enable(false)
        loading.visibility = View.VISIBLE
        val id = intent.getStringExtra(EXTRA_ID)!!
        thread {
            val takenLocal = sourceTaken
            val r = runCatching {
                val s = DdnSession.get(this)!!
                val c = s.node(id)!!
                val plain = ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.JPEG, 92, it) }.toByteArray()
                val jpeg = sourceExif?.let { e -> runCatching { withExif(plain, e, cacheDir) }.getOrNull() } ?: plain
                val name = editedName(c.name)
                val res = s.uploader(parallel = 2).upload({ jpeg.inputStream() }, jpeg.size.toLong(), name, c.parentId ?: "root", pictures(b), takenAt = takenLocal)
                if (takenLocal != null) DdnTaken.put(this, s.acct.accountId, res.manifestRef, takenLocal)
                name
            }
            runOnUiThread {
                saving = false
                loading.visibility = View.GONE
                enable(true)
                // The app's context: the toast stays after this screen closes.
                r.onSuccess { Toast.makeText(applicationContext, getString(R.string.ddn_edit_saved, it), Toast.LENGTH_LONG).show(); savedForTest = it; finish() }
                    .onFailure { Toast.makeText(this, DdnErrors.text(this, it), Toast.LENGTH_LONG).show() }
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
        /** Tests of the look: without an account the screen stays open (no picture) instead of closing. */
        internal const val KEEP_OPEN_FOR_TEST = "keepOpenForTest"
        private const val FULL_MAX = 40L * 1024 * 1024
        private const val MAX_PX = 4096
        private const val EXIF_HEAD = 256L * 1024
        /** The largest file without a preview the editor downloads whole to decode it (beyond: "cannot load"). */
        private const val BIG_MAX = 300L * 1024 * 1024

        /** A photo file on disk decoded to at most `maxPx` (sampled while decoding) and turned by its orientation. */
        internal fun decodeFileUpright(f: java.io.File, maxPx: Int): Bitmap? {
            val o = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeFile(f.path, o)
            if (o.outWidth <= 0 || o.outHeight <= 0) return null
            // Strictly within maxPx (a 9000 px photo decoded at 4500 and turned would need two ~54 MB bitmaps).
            var sample = 1
            while (maxOf(o.outWidth, o.outHeight) / sample > maxPx) sample *= 2
            val b = android.graphics.BitmapFactory.decodeFile(f.path, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
            val up = DdnThumbs.upright(b, runCatching { android.media.ExifInterface(f.path) }.getOrNull())
            if (up !== b) b.recycle()
            return up
        }

        /**
         * What the copy takes over from the original's EXIF: when and with what it was made, and where. Not the
         * size, the orientation or the embedded thumbnail (the copy's own pixels decide those).
         */
        private val KEPT_TAGS = listOf(
            android.media.ExifInterface.TAG_DATETIME_ORIGINAL, android.media.ExifInterface.TAG_DATETIME_DIGITIZED, android.media.ExifInterface.TAG_DATETIME,
            "OffsetTimeOriginal", "OffsetTimeDigitized", "OffsetTime", "SubSecTimeOriginal", "SubSecTimeDigitized", "SubSecTime",
            android.media.ExifInterface.TAG_MAKE, android.media.ExifInterface.TAG_MODEL, "LensMake", "LensModel", "LensSpecification", "Software", "Artist", "Copyright",
            android.media.ExifInterface.TAG_F_NUMBER, android.media.ExifInterface.TAG_APERTURE_VALUE, android.media.ExifInterface.TAG_EXPOSURE_TIME,
            android.media.ExifInterface.TAG_SHUTTER_SPEED_VALUE, android.media.ExifInterface.TAG_EXPOSURE_BIAS_VALUE, android.media.ExifInterface.TAG_EXPOSURE_PROGRAM,
            android.media.ExifInterface.TAG_ISO_SPEED_RATINGS, android.media.ExifInterface.TAG_FOCAL_LENGTH, android.media.ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM,
            android.media.ExifInterface.TAG_FLASH, android.media.ExifInterface.TAG_WHITE_BALANCE, android.media.ExifInterface.TAG_METERING_MODE,
            android.media.ExifInterface.TAG_GPS_LATITUDE, android.media.ExifInterface.TAG_GPS_LATITUDE_REF,
            android.media.ExifInterface.TAG_GPS_LONGITUDE, android.media.ExifInterface.TAG_GPS_LONGITUDE_REF,
            android.media.ExifInterface.TAG_GPS_ALTITUDE, android.media.ExifInterface.TAG_GPS_ALTITUDE_REF,
            android.media.ExifInterface.TAG_GPS_TIMESTAMP, android.media.ExifInterface.TAG_GPS_DATESTAMP,
            android.media.ExifInterface.TAG_GPS_IMG_DIRECTION, android.media.ExifInterface.TAG_GPS_IMG_DIRECTION_REF,
            android.media.ExifInterface.TAG_GPS_PROCESSING_METHOD,
        )

        /** `jpeg` with the original's kept EXIF and orientation 1 (normal): through a file, as ExifInterface saves. */
        internal fun withExif(jpeg: ByteArray, from: androidx.exifinterface.media.ExifInterface, tmpDir: java.io.File): ByteArray {
            val f = java.io.File.createTempFile("edit-", ".jpg", tmpDir)
            try {
                f.writeBytes(jpeg)
                val to = androidx.exifinterface.media.ExifInterface(f.path)
                var any = false
                for (t in KEPT_TAGS) from.getAttribute(t)?.let { to.setAttribute(t, it); any = true }
                if (!any) return jpeg
                to.setAttribute(androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION, androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL.toString())
                to.saveAttributes()
                return f.readBytes()
            } finally {
                f.delete()
            }
        }

        /** "IMG_1.jpg" → "IMG_1 (edycja).jpg" (always .jpg: the copy is a JPEG). */
        fun editedName(name: String): String {
            val base = name.substringBeforeLast('.', name)
            return "$base (edycja).jpg"
        }

        @Volatile internal var savedForTest: String? = null
        @Volatile internal var loadedForTest = false
    }
}
