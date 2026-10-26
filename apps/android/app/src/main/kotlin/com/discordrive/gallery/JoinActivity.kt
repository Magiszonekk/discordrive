package com.discordrive.gallery

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import io.github.magiszonekk.discordrive.core.AccountState
import io.github.magiszonekk.discordrive.core.AccountSync
import io.github.magiszonekk.discordrive.core.Discord
import io.github.magiszonekk.discordrive.core.Ed25519Key
import io.github.magiszonekk.discordrive.core.InstanceApi
import io.github.magiszonekk.discordrive.core.Pairing
import io.github.magiszonekk.discordrive.syncjs.JsEngines
import io.github.magiszonekk.discordrive.syncjs.JsIndexReplica
import kotlin.concurrent.thread

/**
 * Join this phone to a discordrive account (any storage mode: metadata only, e2ee, plain), as in the web app's "Join this device":
 * the phone shows a QR code (and the text); on a signed-in device: Devices → scan / paste → Pair; both show
 * a 6-digit code; the user confirms they match. Or: paste a rescue kit. Then the phone joins (vault,
 * snapshot, log tail) and shows the account's top folders.
 */
class JoinActivity : AppCompatActivity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var qr: ImageView
    private lateinit var codeText: TextView
    private lateinit var codeCard: View
    private lateinit var ttl: TextView
    private lateinit var sas: TextView
    private var link: String? = null
    private var shownAt = 0L
    private var pending: Pairing.Pending? = null
    private var device: Ed25519Key? = null
    private var result: Pairing.Result? = null
    private var polling = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_join)
        Insets.apply(findViewById(R.id.joinRoot))
        val server = findViewById<EditText>(R.id.joinServer)
        val name = findViewById<EditText>(R.id.joinName)
        status = findViewById(R.id.joinStatus)
        qr = findViewById(R.id.joinQr)
        codeText = findViewById(R.id.joinCode)
        codeCard = findViewById(R.id.joinCodeCard)
        ttl = findViewById(R.id.joinTtl)
        sas = findViewById(R.id.joinSas)
        val start = findViewById<Button>(R.id.joinStart)
        val yes = findViewById<Button>(R.id.joinYes)
        val no = findViewById<Button>(R.id.joinNo)
        val kit = findViewById<EditText>(R.id.joinKit)
        val kitGo = findViewById<Button>(R.id.joinKitGo)
        ok = findViewById<Button>(R.id.joinOk).apply { setOnClickListener { openAccount(0) } }
        // The address: from the link that opened this screen, else the one used last time.
        server.setText(intent.getStringExtra("server")?.let { JoinAddress.normalize(it) } ?: JoinAddress.last(this))
        // A pasted pairing link or a page of the instance: only its address stays (https://host[:port]).
        server.setOnFocusChangeListener { _, has -> if (!has) JoinAddress.normalize(server.text.toString())?.let { if (it != server.text.toString()) server.setText(it) } }
        name.setText("${Build.MANUFACTURER} ${Build.MODEL}".trim())
        findViewById<Button>(R.id.joinCopy).setOnClickListener { copyCode() }
        findViewById<Button>(R.id.joinShare).setOnClickListener { shareCode() }
        findViewById<Button>(R.id.joinKitToggle).setOnClickListener {
            val box = findViewById<View>(R.id.joinKitBox)
            box.visibility = if (box.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }

        DdnAccount.load(this)?.let {
            findViewById<TextView>(R.id.joinAlready).apply { text = getString(R.string.ddn_already, it.deviceName, it.serverUrl); visibility = View.VISIBLE }
        }

        start.setOnClickListener {
            val url = JoinAddress.normalize(server.text.toString()) ?: return@setOnClickListener toast(getString(R.string.ddn_bad_server))
            server.setText(url)
            JoinAddress.remember(this, url)
            val d = Ed25519Key.generate()
            val p = Pairing.start(d.publicKey)
            device = d
            pending = p
            link = "$url/#pair=${p.offer}"
            codeText.text = p.offer
            qr.setImageBitmap(qrBitmap(link!!))
            codeCard.visibility = View.VISIBLE
            start.text = getString(R.string.ddn_join_again)
            status.text = ""
            shownAt = System.currentTimeMillis()
            tick()
            poll(url, name.text.toString().trim(), yes, no)
        }
        yes.setOnClickListener {
            val r = result ?: return@setOnClickListener
            val url = JoinAddress.normalize(server.text.toString()) ?: return@setOnClickListener toast(getString(R.string.ddn_bad_server))
            yes.isEnabled = false
            thread {
                val out = runCatching {
                    val acct = AccountSync.finishPairing(url, name.text.toString().trim(), device!!, r, InstanceApi(url, null, null, null))
                    DdnAccount.save(this, acct)
                    joinNow(acct)
                }
                main.post { joined(out, listOf(yes, no)) }
            }
        }
        no.setOnClickListener {
            result = null
            pending = null
            yes.visibility = View.GONE
            no.visibility = View.GONE
            sas.visibility = View.GONE
            status.text = getString(R.string.ddn_sas_rejected)
        }
        kitGo.setOnClickListener {
            val url = JoinAddress.normalize(server.text.toString()) ?: return@setOnClickListener toast(getString(R.string.ddn_bad_server))
            JoinAddress.remember(this, url)
            val text = kit.text.toString()
            kit.setText("")
            thread {
                val out = runCatching {
                    val acct = AccountSync.joinWithKit(url, name.text.toString().trim(), text)
                    DdnAccount.save(this, acct)
                    joinNow(acct)
                }
                main.post { joined(out, listOf(kitGo)) }
            }
        }
    }

    /**
     * After a join: the summary, then on to the files. A note the user must act on (the snapshot pointer was
     * unavailable: fix it on another device) stays until they tap OK instead of disappearing with the screen.
     */
    private fun joined(out: Result<Pair<String, Boolean>>, hide: List<Button>) {
        status.text = out.fold({ it.first }, { getString(R.string.ddn_error, it.message) })
        val (_, note) = out.getOrNull() ?: return
        if (!note) { openAccount(); return }
        // The pairing's buttons are done with: only OK, which opens the files.
        for (b in hide) b.visibility = View.GONE
        ok.visibility = View.VISIBLE
    }

    /** Shown after a join with a note to read (OK opens the files). */
    internal lateinit var ok: Button

    /** Tests: the screen after a join that left a note (the snapshot pointer unavailable). */
    internal fun joinedWithNoteForTest() = joined(Result.success("joined\n\n" + getString(R.string.ddn_join_snapshot_skipped) to true), emptyList())
    internal fun okForTest(): Button = ok

    /** Joined: on to the account's files (a short pause so the summary can be read). */
    private fun openAccount(delayMs: Long = 1500) = main.postDelayed({
        startActivity(android.content.Intent(this, DdnActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }, delayMs)

    /** The pairing code (the offer, as text) to the clipboard: to paste it on the computer. */
    private fun copyCode() {
        val p = pending ?: return
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(getString(R.string.ddn_copy_code), p.offer))
        // Android 13+ shows its own confirmation of a copy.
        if (Build.VERSION.SDK_INT < 33) toast(getString(R.string.ddn_copied))
    }

    /** The pairing link through the system's Share (send it to yourself, open it on the computer). */
    private fun shareCode() {
        val l = link ?: return
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, l).putExtra(Intent.EXTRA_SUBJECT, getString(R.string.ddn_join_title))
        startActivity(Intent.createChooser(send, getString(R.string.ddn_share_code)))
    }

    /** Time left of the code, every second while it is shown and nobody answered. */
    private fun tick() {
        if (pending == null || result != null || codeCard.visibility != View.VISIBLE) return
        val left = (Pairing.TTL_MS - (System.currentTimeMillis() - shownAt)).coerceAtLeast(0) / 1000
        ttl.text = if (left > 0) getString(R.string.ddn_code_ttl, left / 60, left % 60) else getString(R.string.ddn_code_expired)
        if (left > 0) main.postDelayed({ tick() }, 1000)
    }


    /** Tests: the code shown and what Copy put on the clipboard. */
    internal fun codeForTest(): String? = pending?.offer
    internal fun copyForTest(): String? {
        copyCode()
        return (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.text?.toString()
    }

    /** Every 2 s until the other device answered (10 minutes at most). */
    private fun poll(url: String, deviceName: String, yes: Button, no: Button) {
        if (polling) return
        polling = true
        val t0 = System.currentTimeMillis()
        val api = InstanceApi(url, null, null, null)
        thread {
            while (polling && pending != null && System.currentTimeMillis() - t0 < Pairing.TTL_MS) {
                val p = pending ?: break
                val got = runCatching { api.pairingTake(p.pairingId) }.getOrNull()
                if (got != null) {
                    val r = runCatching { p.complete(got) }
                    main.post {
                        r.onSuccess {
                            result = it
                            codeCard.visibility = View.GONE
                            // The 6 digits large (compared at a glance with the other screen).
                            sas.text = it.sas
                            sas.visibility = View.VISIBLE
                            status.text = getString(R.string.ddn_sas, it.sas, it.fromDevice)
                            yes.visibility = View.VISIBLE
                            no.visibility = View.VISIBLE
                        }.onFailure { status.text = getString(R.string.ddn_error, it.message) }
                    }
                    break
                }
                Thread.sleep(2000)
            }
            polling = false
        }
    }

    /** Join (vault, snapshot, log) in this phone's JS engine and describe what is there. Off the main thread. */
    private fun joinNow(acct: AccountState): Pair<String, Boolean> {
        val api = InstanceApi(acct.serverUrl, acct.accountId, acct.deviceId, acct.device, acct.instanceId)
        JsEngines.openSyncCore(this).use { core ->
            JsIndexReplica(core.engine).use { ix ->
                val sync = AccountSync(acct, api, Discord(), ix, DdnAccount.vaultRevision(this))
                val j = sync.join()
                DdnAccount.setVaultRevision(this, sync.vaultRevision)
                runCatching { sync.setOwnName(acct.deviceName) }
                val top = ix.children("root")
                val done = getString(R.string.ddn_joined, core.engine.name, j.headSeq, j.baseHeadSeq, j.ms, top.size, top.take(8).joinToString(", ") { it.name })
                return if (j.snapshotSkipped != null) (done + "\n\n" + getString(R.string.ddn_join_snapshot_skipped)) to true else done to false
            }
        }
    }

    private fun qrBitmap(text: String): Bitmap {
        val size = 720
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.L, EncodeHintType.MARGIN to 2))
        val px = IntArray(size * size) { if (m.get(it % size, it / size)) Color.BLACK else Color.WHITE }
        return Bitmap.createBitmap(px, size, size, Bitmap.Config.ARGB_8888)
    }

    private fun toast(s: String) = android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_SHORT).show()

    override fun onDestroy() {
        polling = false
        super.onDestroy()
    }
}
