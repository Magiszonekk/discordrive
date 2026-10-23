package com.discordrive.gallery

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.Formatter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import kotlin.concurrent.thread

/**
 * Settings → "Free up space on this phone": checks which photos and videos have a verified copy in the
 * account (DdnFreeUp), shows how many and how much, and on "Remove from the phone" hands them to the system's
 * confirmation (the system trash: they can be restored from the phone's own trash for 30 days). Nothing in the
 * account changes.
 */
class DdnFreeUpActivity : AppCompatActivity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var state: TextView
    private lateinit var progress: ProgressBar
    private lateinit var go: Button
    private var scan: DdnFreeUp.Scan? = null

    private val confirm = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
        val n = scan?.ready?.size ?: 0
        if (r.resultCode == Activity.RESULT_OK) {
            Toast.makeText(this, resources.getQuantityString(R.plurals.ddn_free_done, n, n), Toast.LENGTH_LONG).show()
            removedForTest = true
        }
        check()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = getString(R.string.ddn_free)
        val pad = dp(16)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad); setBackgroundColor(getColor(R.color.bg)) }
        root.addView(TextView(this).apply { text = getString(R.string.ddn_free_note); textSize = 14f; setTextColor(getColor(R.color.text_dim)); setPadding(0, 0, 0, dp(12)) })
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000 }
        state = TextView(this).apply { textSize = 15f; setTextColor(getColor(R.color.text)); setPadding(0, dp(8), 0, dp(8)) }
        go = Button(this).apply { text = getString(R.string.ddn_free_go); isEnabled = false; setOnClickListener { remove() } }
        root.addView(progress)
        root.addView(state)
        root.addView(go)
        setContentView(ScrollView(this).apply { addView(root) })
        Insets.apply(root)
        check()
    }

    private fun check() {
        go.isEnabled = false
        progress.visibility = android.view.View.VISIBLE
        state.text = getString(R.string.ddn_free_checking)
        thread {
            val r = runCatching {
                DdnFreeUp.scan(this) { i, n -> main.post { progress.progress = if (n > 0) i * 1000 / n else 0; state.text = getString(R.string.ddn_free_checking_n, i, n) } }
            }
            main.post {
                progress.visibility = android.view.View.GONE
                r.onSuccess { sc ->
                    scan = sc
                    state.text = buildString {
                        append(if (sc.ready.isEmpty()) getString(R.string.ddn_free_none) else resources.getQuantityString(R.plurals.ddn_free_ready, sc.ready.size, sc.ready.size, Formatter.formatShortFileSize(this@DdnFreeUpActivity, sc.bytes)))
                        if (sc.notCopied > 0) append("\n").append(resources.getQuantityString(R.plurals.ddn_free_not_copied, sc.notCopied, sc.notCopied))
                        if (sc.changed + sc.gone > 0) append("\n").append(getString(R.string.ddn_free_kept, sc.changed + sc.gone))
                        if (Build.VERSION.SDK_INT < 30 && sc.ready.isNotEmpty()) append("\n").append(getString(R.string.ddn_free_old_android))
                    }
                    go.isEnabled = sc.ready.isNotEmpty() && Build.VERSION.SDK_INT >= 30
                }.onFailure { state.text = getString(R.string.ddn_error, it.message) }
                checkedForTest = true
            }
        }
    }

    private fun remove() {
        val sc = scan ?: return
        val pi = DdnFreeUp.request(this, sc.ready) ?: return
        confirm.launch(IntentSenderRequest.Builder(pi.intentSender).build())
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // ── for the instrumentation test ──
    @Volatile internal var checkedForTest = false
    @Volatile internal var removedForTest = false
    internal fun scanForTest(): DdnFreeUp.Scan? = scan
}
