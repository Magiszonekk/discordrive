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
import android.view.ViewGroup
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

    private lateinit var sendButton: com.google.android.material.button.MaterialButton

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        val uri = intent.data ?: return finish()
        // The type: the intent's, else the provider's (MediaStore answers getType), else from the name.
        val type = intent.type?.takeIf { it != "*/*" } ?: runCatching { contentResolver.getType(uri) }.getOrNull() ?: ""
        // The photo fills the screen; the name on a scrim at the top (with back), "Send to discordrive" as the
        // primary button at the bottom.
        val root = FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) }
        box = FrameLayout(this)
        root.addView(box, FrameLayout.LayoutParams(-1, -1))
        val name = DdnUploads.displayName(this, uri, type)
        val onScrim = getColor(R.color.cobalt_on_scrim)
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundResource(R.drawable.bg_cobalt_scrim_top)
            setPadding(dp(4), dp(4), dp(16), dp(20))
            addView(android.widget.ImageView(this@DdnOpenActivity).apply {
                setImageResource(R.drawable.ic_cobalt_back); setColorFilter(onScrim); contentDescription = getString(R.string.cobalt_back)
                setPadding(dp(12), dp(12), dp(12), dp(12))
                val tv = android.util.TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true); setBackgroundResource(tv.resourceId)
                setOnClickListener { finish() }
            }, LinearLayout.LayoutParams(dp(48), dp(48)))
            addView(TextView(this@DdnOpenActivity).apply {
                text = name; androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); setTextColor(onScrim)
                maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(4) })
        }
        sendButton = CobaltUi(this).button(R.string.ddn_open_send, CobaltUi.Kind.PRIMARY, R.drawable.ic_cobalt_upload) { send(uri) }
        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_cobalt_scrim_bottom)
            setPadding(dp(16), dp(28), dp(16), dp(16))
            addView(sendButton, LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        root.addView(top, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        root.addView(bottom, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        setContentView(root)
        androidx.core.view.WindowCompat.getInsetsController(window, root).apply { isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false }
        Insets.apply(top, top = true, bottom = false)
        Insets.apply(bottom, top = false, bottom = true)
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
                else box.addView(TextView(this).apply { text = getString(R.string.ddn_no_preview); androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Body); setTextColor(0xFFC4C7CF.toInt()); gravity = Gravity.CENTER; setPadding(dp(32), 0, dp(32), 0) }, FrameLayout.LayoutParams(-1, -1))
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
            com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setMessage(getString(R.string.ddn_open_again, name))
                .setPositiveButton(R.string.ddn_open_send) { _, _ -> queue(uri) }
                .setNegativeButton(R.string.cobalt_cancel, null).show()
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
    internal fun sendButtonForTest(): com.google.android.material.button.MaterialButton = sendButton
}
