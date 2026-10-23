package com.discordrive.gallery

import android.content.ContentValues
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.text.format.Formatter
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.MimeTypeMap
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView
import io.github.magiszonekk.discordrive.core.IndexReplica
import kotlin.concurrent.thread

/**
 * One file of the account: a photo shows its stored preview (low resolution) at once, then the full
 * picture; a video plays with Media3 reading fragments on demand (seeking fetches only the fragment it
 * needs); any file can be saved to the phone's Downloads. ← / → by swiping between the files of the list
 * it was opened from.
 */
class DdnViewerActivity : AppCompatActivity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var box: FrameLayout
    private lateinit var info: TextView
    private lateinit var progress: ProgressBar
    private var player: ExoPlayer? = null
    private var items: List<IndexReplica.Child> = emptyList()
    private var index = 0
    private var seq = 0
    private lateinit var edit: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        items = pending ?: emptyList()
        val id = intent.getStringExtra("id")
        index = items.indexOfFirst { it.id == id }.coerceAtLeast(0)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(0xFF000000.toInt()) }
        box = FrameLayout(this)
        info = TextView(this).apply { setTextColor(0xFFE8E8EC.toInt()); setPadding(dp(16), dp(8), dp(16), dp(4)); textSize = 13f }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { visibility = View.GONE; max = 1000 }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; setPadding(dp(8), 0, dp(8), dp(8)) }
        fun btn(t: Int, f: () -> Unit) = Button(this).apply { text = getString(t); setOnClickListener { f() } }
        bar.addView(btn(R.string.ddn_prev) { go(-1) })
        bar.addView(btn(R.string.ddn_download) { download() })
        edit = btn(R.string.ddn_edit) { items.getOrNull(index)?.let { startActivity(android.content.Intent(this, DdnEditActivity::class.java).putExtra(DdnEditActivity.EXTRA_ID, it.id)) } }
        bar.addView(edit)
        bar.addView(btn(R.string.ddn_next) { go(1) })
        root.addView(box, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(info)
        root.addView(progress, LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(bar)
        setContentView(root)
        Insets.apply(root)
        show()
    }

    private fun go(d: Int) {
        if (items.isEmpty()) return
        index = (index + d).mod(items.size)
        show()
    }

    private fun show() {
        val s = DdnSession.get(this).takeIf { items.isNotEmpty() } ?: return finish()
        val c = items[index]
        val my = ++seq
        releasePlayer()
        box.removeAllViews()
        info.text = "${c.name} · ${Formatter.formatShortFileSize(this, c.size ?: 0)} · ${index + 1}/${items.size}"
        // Photos only (a video or another file has nothing to crop).
        edit.visibility = if (DdnSession.isImage(c.name)) View.VISIBLE else View.GONE
        val ref = c.manifestRef ?: return
        when {
            DdnSession.isVideo(c.name) -> playVideo(s, c, ref)
            DdnSession.isImage(c.name) -> {
                val img = ZoomableImageView(this)
                box.addView(img, FrameLayout.LayoutParams(-1, -1))
                // Low resolution first (stored preview, else the thumbnail), then the whole file if it is not too big.
                DdnThumbs.into(s, ref, img, 1280, 'p') { DdnThumbs.into(s, ref, img, 640, 't') }
                val size = c.size ?: 0
                if (size in 1..FULL_IMAGE_MAX) thread {
                    val b = runCatching { s.files.range(ref, size, 0, size - 1) }.getOrNull()?.let { DdnThumbs.decode(it, 4096) }
                    main.post { if (my == seq && b != null) img.setImageBitmap(b) }
                }
            }
            else -> box.addView(TextView(this).apply { text = getString(R.string.ddn_no_preview); setTextColor(0xFF9C9CA6.toInt()); gravity = Gravity.CENTER }, FrameLayout.LayoutParams(-1, -1))
        }
    }

    private fun playVideo(s: DdnSession, c: IndexReplica.Child, ref: String) {
        val view = PlayerView(this)
        box.addView(view, FrameLayout.LayoutParams(-1, -1))
        val size = c.size ?: 0
        val p = ExoPlayer.Builder(this).build()
        val source = ProgressiveMediaSource.Factory { DdnDataSource(s, ref, size) }.createMediaSource(MediaItem.fromUri(Uri.parse("ddn://file/${c.id}")))
        p.setMediaSource(source)
        p.prepare()
        p.playWhenReady = true
        view.player = p
        player = p
    }

    private fun download() {
        val s = DdnSession.get(this) ?: return
        val c = items.getOrNull(index) ?: return
        val ref = c.manifestRef ?: return
        progress.visibility = View.VISIBLE
        progress.progress = 0
        thread {
            val r = runCatching {
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(c.name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, c.name)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("cannot create the file in Downloads")
                try {
                    contentResolver.openOutputStream(uri)!!.use { out ->
                        s.files.download(ref, c.size ?: 0, c.sha256, out) { done, total -> main.post { progress.progress = if (total > 0) (done * 1000 / total).toInt() else 0 } }
                    }
                    contentResolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                } catch (e: Exception) {
                    contentResolver.delete(uri, null, null)
                    throw e
                }
            }
            main.post {
                progress.visibility = View.GONE
                Toast.makeText(this, r.fold({ getString(R.string.ddn_saved, c.name) }, { getString(R.string.ddn_error, it.message) }), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun releasePlayer() {
        player?.release()
        player = null
    }

    override fun onStop() {
        super.onStop()
        player?.pause()
    }

    override fun onDestroy() {
        releasePlayer()
        super.onDestroy()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    internal fun hasPictureForTest(): Boolean = (box.getChildAt(0) as? android.widget.ImageView)?.drawable is android.graphics.drawable.BitmapDrawable

    companion object {
        /** The list the viewer was opened from (set by the caller just before starting it). */
        @Volatile var pending: List<IndexReplica.Child>? = null
        /** Whole photos up to this size are shown in full; larger ones stay on the preview. */
        const val FULL_IMAGE_MAX = 40L * 1024 * 1024
    }
}

/**
 * Media3 reads a discordrive file: each read takes bytes from the current fragment (fetched and decrypted
 * when needed), so playback and seeking fetch only the fragments they touch. One fragment is kept.
 */
class DdnDataSource(private val s: DdnSession, private val ref: String, private val size: Long) : BaseDataSource(true) {
    private var uri: Uri? = null
    private var pos = 0L
    private var left = 0L
    private var frag: ByteArray? = null
    private var fragIndex = -1
    private var chunkSize = 0L

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        transferInitializing(dataSpec)
        chunkSize = s.files.manifest(ref).second.chunkSize
        pos = dataSpec.position
        left = if (dataSpec.length != C.LENGTH_UNSET.toLong()) dataSpec.length else size - pos
        transferStarted(dataSpec)
        return left
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (left <= 0) return C.RESULT_END_OF_INPUT
        val i = (pos / chunkSize).toInt()
        if (i != fragIndex) {
            frag = s.files.fragmentPlain(ref, i)
            fragIndex = i
        }
        val f = frag!!
        val inFrag = (pos - i * chunkSize).toInt()
        val n = minOf(length.toLong(), left, (f.size - inFrag).toLong()).toInt()
        if (n <= 0) return C.RESULT_END_OF_INPUT
        System.arraycopy(f, inFrag, buffer, offset, n)
        pos += n
        left -= n
        bytesTransferred(n)
        return n
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        if (uri != null) {
            uri = null
            transferEnded()
        }
    }
}
