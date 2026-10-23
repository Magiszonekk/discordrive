package com.discordrive.gallery

import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlin.concurrent.thread

/**
 * "Open with → discordrive" for a photo or a video of another app (a file manager, a messenger, the camera's
 * thumbnail): shows it (pinch zoom / the player) with "Send to discordrive" (into the upload queue, folder
 * "Z telefonu"). Registered for VIEW of images and videos, so the system can offer it as the default gallery.
 */
class DdnOpenActivity : AppCompatActivity() {
    private val main = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null
    private lateinit var box: FrameLayout
    @Volatile private var shown = false
    private var name = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent.data ?: return finish()
        // The type: the intent's, else the provider's (MediaStore answers getType), else from the name.
        val type = intent.type?.takeIf { it != "*/*" } ?: runCatching { contentResolver.getType(uri) }.getOrNull() ?: ""
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(0xFF000000.toInt()) }
        box = FrameLayout(this)
        val name = DdnUploads.displayName(this, uri, type)
        val info = TextView(this).apply { text = name; setTextColor(0xFFE8E8EC.toInt()); setPadding(dp(16), dp(8), dp(16), dp(4)); textSize = 13f }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; setPadding(dp(8), 0, dp(8), dp(8)) }
        bar.addView(Button(this).apply { text = getString(R.string.ddn_open_send); setOnClickListener { send(uri) } })
        root.addView(box, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(info)
        root.addView(bar)
        setContentView(root)
        Insets.apply(root)
        if (type.startsWith("video/") || (!type.startsWith("image/") && DdnSession.isVideo(name))) playVideo(uri) else showImage(uri)
        this.name = name
    }

    private fun showImage(uri: Uri) {
        val img = ZoomableImageView(this)
        box.addView(img, FrameLayout.LayoutParams(-1, -1))
        thread {
            val bmp = runCatching {
                if (Build.VERSION.SDK_INT >= 28) ImageDecoder.decodeBitmap(ImageDecoder.createSource(contentResolver, uri)) { d, i, _ ->
                    // At most 4096 px on the longer side (a 200 MP photo would not fit in memory).
                    val big = maxOf(i.size.width, i.size.height)
                    if (big > 4096) d.setTargetSampleSize((big + 4095) / 4096)
                    d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                } else contentResolver.openInputStream(uri)!!.use { BitmapFactory.decodeStream(it) }
            }.getOrNull()
            main.post {
                if (bmp != null) { img.setImageBitmap(bmp); shown = true }
                else box.addView(TextView(this).apply { text = getString(R.string.ddn_no_preview); setTextColor(0xFF9C9CA6.toInt()); gravity = Gravity.CENTER }, FrameLayout.LayoutParams(-1, -1))
            }
        }
    }

    private fun playVideo(uri: Uri) {
        val view = PlayerView(this)
        box.addView(view, FrameLayout.LayoutParams(-1, -1))
        val p = ExoPlayer.Builder(this).build()
        p.setMediaItem(MediaItem.fromUri(uri))
        p.prepare()
        p.playWhenReady = true
        view.player = p
        player = p
        shown = true
    }

    private fun send(uri: Uri) {
        if (DdnAccount.load(this) == null) {
            Toast.makeText(this, R.string.ddn_up_no_account, Toast.LENGTH_LONG).show()
            startActivity(Intent(this, JoinActivity::class.java))
            return
        }
        // Sent from here before (this session or earlier): ask, a second copy would be "name (2)".
        if (DdnUploads.sentBefore(this, uri, name)) {
            androidx.appcompat.app.AlertDialog.Builder(this).setMessage(getString(R.string.ddn_open_again, name))
                .setPositiveButton(R.string.ddn_open_send) { _, _ -> queue(uri) }
                .setNegativeButton(android.R.string.cancel, null).show()
            return
        }
        queue(uri)
    }

    private fun queue(uri: Uri) {
        thread {
            val r = runCatching { DdnUploads.queue(this, listOf(uri), null).also { DdnUploads.markSent(this, uri, name) } }
            main.post {
                r.onSuccess { Toast.makeText(this, plq(R.plurals.ddn_up_queued, it, it), Toast.LENGTH_LONG).show() }
                    .onFailure { Toast.makeText(this, getString(R.string.ddn_error, it.message), Toast.LENGTH_LONG).show() }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        player?.pause()
    }

    override fun onDestroy() {
        player?.release()
        player = null
        super.onDestroy()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    internal fun shownForTest(): Boolean = shown
    internal fun nameForTest(): String = name
}
