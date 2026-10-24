package com.discordrive.gallery

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
import android.widget.LinearLayout
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
    private lateinit var offerText: EditText
    private var pending: Pairing.Pending? = null
    private var device: Ed25519Key? = null
    private var result: Pairing.Result? = null
    private var polling = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad) }
        val server = EditText(this).apply { hint = getString(R.string.ddn_server); setText(intent.getStringExtra("server") ?: "") ; isSingleLine = true }
        val name = EditText(this).apply { hint = getString(R.string.ddn_device_name); setText("${Build.MANUFACTURER} ${Build.MODEL}".trim()); isSingleLine = true }
        status = TextView(this).apply { setPadding(0, pad, 0, pad) }
        qr = ImageView(this).apply { adjustViewBounds = true; visibility = View.GONE }
        offerText = EditText(this).apply { isFocusable = false; textSize = 11f; visibility = View.GONE }
        val start = Button(this).apply { text = getString(R.string.ddn_join_start) }
        val yes = Button(this).apply { text = getString(R.string.ddn_sas_yes); visibility = View.GONE }
        val no = Button(this).apply { text = getString(R.string.ddn_sas_no); visibility = View.GONE }
        val kit = EditText(this).apply { hint = getString(R.string.ddn_kit_hint); minLines = 2 }
        val kitGo = Button(this).apply { text = getString(R.string.ddn_kit_go) }
        listOf(server, name, start, qr, offerText, status, yes, no, kit, kitGo).forEach(root::addView)
        setContentView(android.widget.ScrollView(this).apply { addView(root) })
        Insets.apply(root)

        DdnAccount.load(this)?.let { status.text = getString(R.string.ddn_already, it.deviceName, it.serverUrl) }

        start.setOnClickListener {
            val url = server.text.toString().trim().trimEnd('/')
            if (!url.startsWith("http")) return@setOnClickListener toast(getString(R.string.ddn_bad_server))
            val d = Ed25519Key.generate()
            val p = Pairing.start(d.publicKey)
            device = d
            pending = p
            offerText.setText(p.offer)
            offerText.visibility = View.VISIBLE
            qr.setImageBitmap(qrBitmap("$url/#pair=${p.offer}"))
            qr.visibility = View.VISIBLE
            status.text = getString(R.string.ddn_join_wait)
            poll(url, name.text.toString().trim(), yes, no)
        }
        yes.setOnClickListener {
            val r = result ?: return@setOnClickListener
            val url = server.text.toString().trim().trimEnd('/')
            yes.isEnabled = false
            thread {
                val out = runCatching {
                    val acct = AccountSync.finishPairing(url, name.text.toString().trim(), device!!, r, InstanceApi(url, null, null, null))
                    DdnAccount.save(this, acct)
                    joinNow(acct)
                }
                main.post {
                    status.text = out.getOrElse { getString(R.string.ddn_error, it.message) }
                    if (out.isSuccess) openAccount()
                }
            }
        }
        no.setOnClickListener {
            result = null
            pending = null
            yes.visibility = View.GONE
            no.visibility = View.GONE
            status.text = getString(R.string.ddn_sas_rejected)
        }
        kitGo.setOnClickListener {
            val url = server.text.toString().trim().trimEnd('/')
            val text = kit.text.toString()
            kit.setText("")
            thread {
                val out = runCatching {
                    val acct = AccountSync.joinWithKit(url, name.text.toString().trim(), text)
                    DdnAccount.save(this, acct)
                    joinNow(acct)
                }
                main.post {
                    status.text = out.getOrElse { getString(R.string.ddn_error, it.message) }
                    if (out.isSuccess) openAccount()
                }
            }
        }
    }

    /** Joined: on to the account's files (a short pause so the summary can be read). */
    private fun openAccount() = main.postDelayed({
        startActivity(android.content.Intent(this, DdnActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }, 1500)

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
                            qr.visibility = View.GONE
                            offerText.visibility = View.GONE
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
    private fun joinNow(acct: AccountState): String {
        val api = InstanceApi(acct.serverUrl, acct.accountId, acct.deviceId, acct.device, acct.instanceId)
        JsEngines.openSyncCore(this).use { core ->
            JsIndexReplica(core.engine).use { ix ->
                val sync = AccountSync(acct, api, Discord(), ix, DdnAccount.vaultRevision(this))
                val j = sync.join()
                DdnAccount.setVaultRevision(this, sync.vaultRevision)
                runCatching { sync.setOwnName(acct.deviceName) }
                val top = ix.children("root")
                return getString(R.string.ddn_joined, core.engine.name, j.headSeq, j.baseHeadSeq, j.ms, top.size, top.take(8).joinToString(", ") { it.name })
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
