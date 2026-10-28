package com.discordrive.gallery

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.format.Formatter
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
    private lateinit var progress: com.google.android.material.progressindicator.LinearProgressIndicator
    private lateinit var go: com.google.android.material.button.MaterialButton
    private var scan: DdnFreeUp.Scan? = null
    /** After a removal: what went (shown above the next check, which finds nothing more to remove). */
    private var removedNote: String? = null

    private val confirm = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
        val n = scan?.ready?.size ?: 0
        if (r.resultCode == Activity.RESULT_OK) {
            removedNote = plq(R.plurals.ddn_free_done, n, n, Formatter.formatShortFileSize(this, scan?.bytes ?: 0))
            Toast.makeText(this, removedNote, Toast.LENGTH_LONG).show()
            removedForTest = true
        }
        check()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        val ui = CobaltUi(this)
        val page = ui.screen(R.string.ddn_free)
        val c = ui.section(page, R.string.ddn_free_h, getString(R.string.ddn_free_note))
        progress = com.google.android.material.progressindicator.LinearProgressIndicator(this).apply { max = 1000 }
        state = ui.text("")
        go = ui.button(R.string.ddn_free_go, CobaltUi.Kind.DANGER, R.drawable.ic_cobalt_trash) { remove() }.apply { isEnabled = false }
        ui.add(c, progress, top = 14)
        ui.add(c, state, top = 10)
        ui.add(c, go, top = 14)
        check()
    }

    private fun check() {
        go.isEnabled = false
        progress.visibility = android.view.View.VISIBLE
        state.text = getString(R.string.ddn_free_checking)
        thread {
            val r = runCatching {
                DdnFreeUp.scan(this) { i, n -> main.post { progress.setProgressCompat(if (n > 0) i * 1000 / n else 0, true); state.text = getString(R.string.ddn_free_checking_n, i, n) } }
            }
            main.post {
                progress.visibility = android.view.View.GONE
                r.onSuccess { sc ->
                    scan = sc
                    state.text = buildString {
                        removedNote?.let { append(it).append("\n\n") }
                        append(if (sc.ready.isEmpty()) getString(if (removedNote != null) R.string.ddn_free_none_more else R.string.ddn_free_none) else plq(R.plurals.ddn_free_ready, sc.ready.size, sc.ready.size, Formatter.formatShortFileSize(this@DdnFreeUpActivity, sc.bytes)))
                        if (sc.notCopied > 0) append("\n").append(plq(R.plurals.ddn_free_not_copied, sc.notCopied, sc.notCopied))
                        if (sc.changed + sc.gone > 0) append("\n").append(plq(R.plurals.ddn_free_kept, sc.changed + sc.gone, sc.changed + sc.gone))
                        if (Build.VERSION.SDK_INT < 30 && sc.ready.isNotEmpty()) append("\n").append(getString(R.string.ddn_free_old_android))
                    }
                    go.isEnabled = sc.ready.isNotEmpty() && Build.VERSION.SDK_INT >= 30
                }.onFailure { state.text = DdnErrors.text(this, it) }
                checkedForTest = true
            }
        }
    }

    private fun remove() {
        val sc = scan ?: return
        val pi = DdnFreeUp.request(this, sc.ready) ?: return
        confirm.launch(IntentSenderRequest.Builder(pi.intentSender).build())
    }

    // ── for the instrumentation test ──
    @Volatile internal var checkedForTest = false
    @Volatile internal var removedForTest = false
    internal fun scanForTest(): DdnFreeUp.Scan? = scan
}
