package com.discordrive.gallery

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.github.magiszonekk.discordrive.core.IndexReplica
import io.github.magiszonekk.discordrive.core.Safe
import kotlin.concurrent.thread

/**
 * The Safe screen: no Safe yet → create (password twice, "a forgotten password opens it for nobody"); closed →
 * the phone's unlock (fingerprint / screen PIN, when turned on) or the password; open → its folders and files
 * (open, upload, new folder, rename, move to Files, delete for good), Close, and the phone-unlock switch.
 */
class DdnSafeActivity : AppCompatActivity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var ui: CobaltUi
    private lateinit var root: LinearLayout
    private lateinit var body: LinearLayout
    private lateinit var loading: View
    private val path = ArrayList<Pair<String, String>>()
    private var items: List<IndexReplica.Child> = emptyList()
    /** Tests: what the screen shows ("new", "closed", "open"). */
    @Volatile internal var stateForTest = ""

    private val pick = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) upload(uris)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        ui = CobaltUi(this)
        root = ui.screen(R.string.safe_title, scroll = false)
        loading = com.google.android.material.progressindicator.LinearProgressIndicator(this).apply { isIndeterminate = true; visibility = View.GONE }
        root.addView(loading, ui.lp(top = 4))
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(body, LinearLayout.LayoutParams(-1, 0, 1f))
        path += "root" to getString(R.string.safe_title)
        DdnSafe.onClosed = { main.post { if (!isFinishing) show() } }
        show()
    }

    override fun onResume() {
        super.onResume()
        DdnSafe.touch()
    }

    override fun onDestroy() {
        if (DdnSafe.onClosed != null) DdnSafe.onClosed = null
        super.onDestroy()
    }

    private fun busy(on: Boolean) { loading.visibility = if (on) View.VISIBLE else View.GONE }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    private fun show() {
        if (DdnSafe.isOpen) return showOpen()
        busy(true)
        thread {
            val exists = runCatching { DdnSafe.exists(this) }
            main.post {
                busy(false)
                exists.onSuccess { if (it) showClosed() else showNew() }.onFailure { body.removeAllViews(); body.addView(ui.note(getString(R.string.ddn_error, it.message))) }
            }
        }
    }

    private fun showNew() {
        stateForTest = "new"
        body.removeAllViews()
        val c = ui.section(body, R.string.safe_new_title, getString(R.string.safe_new_lead))
        ui.add(c, ui.note(getString(R.string.safe_new_warn)), top = 8)
        val (pwBox, pw) = ui.field(R.string.safe_password, password = true)
        val (pw2Box, pw2) = ui.field(R.string.safe_password_repeat, password = true)
        ui.add(c, pwBox); ui.add(c, pw2Box)
        val ack = com.google.android.material.checkbox.MaterialCheckBox(this).apply { setText(R.string.safe_new_ack) }
        ui.add(c, ack)
        ui.add(c, ui.button(R.string.safe_create, CobaltUi.Kind.PRIMARY) {
            val p = pw.text?.toString().orEmpty()
            when {
                p.length < Safe.MIN_PASSWORD -> toast(getString(R.string.safe_err_short, Safe.MIN_PASSWORD))
                p != pw2.text?.toString() -> toast(getString(R.string.safe_err_repeat))
                !ack.isChecked -> toast(getString(R.string.safe_err_ack))
                else -> {
                    busy(true)
                    thread {
                        val r = runCatching { DdnSafe.create(this, p) }
                        main.post { busy(false); r.onSuccess { toast(getString(R.string.safe_created)); showOpen() }.onFailure { toast(getString(R.string.ddn_error, it.message)) } }
                    }
                }
            }
        }, top = 12)
    }

    private fun showClosed() {
        stateForTest = "closed"
        body.removeAllViews()
        val c = ui.section(body, R.string.safe_closed_title, getString(R.string.safe_closed_lead))
        if (DdnSafe.DeviceUnlock.enabled(this)) {
            ui.add(c, ui.button(R.string.safe_unlock_device, CobaltUi.Kind.PRIMARY, R.drawable.ic_lock) { deviceUnlock() })
        }
        val (pwBox, pw) = ui.field(R.string.safe_password, password = true)
        ui.add(c, pwBox)
        ui.add(c, ui.button(R.string.safe_unlock, if (DdnSafe.DeviceUnlock.enabled(this)) CobaltUi.Kind.TONAL else CobaltUi.Kind.PRIMARY) {
            val p = pw.text?.toString().orEmpty()
            pw.setText("")
            busy(true)
            thread {
                val r = runCatching { DdnSafe.unlock(this, p) }
                main.post {
                    busy(false)
                    r.onSuccess { showOpen() }.onFailure { toast(if (it is Safe.BadPasswordException) getString(R.string.safe_err_password) else getString(R.string.ddn_error, it.message)) }
                }
            }
        }, top = 10)
        if (DdnSafe.DeviceUnlock.enabled(this)) deviceUnlock()
    }

    private fun deviceUnlock() {
        DdnSafe.DeviceUnlock.unlock(this) { master ->
            if (master == null) return@unlock
            busy(true)
            thread {
                val r = runCatching { DdnSafe.unlockWithMaster(this, master) }
                main.post { busy(false); r.onSuccess { showOpen() }.onFailure { toast(getString(R.string.ddn_error, it.message)) } }
            }
        }
    }

    private fun showOpen() {
        stateForTest = "open"
        body.removeAllViews()
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        head.addView(ui.note(path.joinToString(" › ") { it.second }), LinearLayout.LayoutParams(0, -2, 1f))
        body.addView(head, ui.lp(top = 4))
        val list = RecyclerView(this).apply { layoutManager = LinearLayoutManager(this@DdnSafeActivity); clipToPadding = false }
        body.addView(list, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = ui.dp(8) })
        val device = com.google.android.material.materialswitch.MaterialSwitch(this).apply {
            setText(R.string.safe_device_switch)
            isChecked = DdnSafe.DeviceUnlock.enabled(this@DdnSafeActivity)
            isEnabled = DdnSafe.DeviceUnlock.available(this@DdnSafeActivity) || isChecked
            setOnCheckedChangeListener { b, on ->
                if (on == DdnSafe.DeviceUnlock.enabled(this@DdnSafeActivity)) return@setOnCheckedChangeListener
                if (on) DdnSafe.DeviceUnlock.enable(this@DdnSafeActivity) { ok -> if (!ok) b.isChecked = false }
                else DdnSafe.DeviceUnlock.disable(this@DdnSafeActivity)
            }
        }
        body.addView(device, ui.lp(top = 4))
        val bar = ui.actionBar(body,
            ui.button(R.string.ddn_upload, CobaltUi.Kind.PRIMARY) { pick.launch(arrayOf("*/*")) },
            ui.button(R.string.ddn_new_folder, CobaltUi.Kind.TONAL) { askName(R.string.ddn_new_folder, "") { n -> op { DdnSafe.mkdir(this, n, path.last().first) } } },
            ui.button(R.string.safe_close, CobaltUi.Kind.TONAL) { DdnSafe.close(this); show() },
        )
        bar.tag = "safe-bar"
        busy(true)
        val folder = path.last().first
        thread {
            val r = runCatching { DdnSafe.children(this, folder) }
            main.post {
                busy(false)
                r.onSuccess { items = it; bind(list) }.onFailure { if (!DdnSafe.isOpen) show() else toast(getString(R.string.ddn_error, it.message)) }
            }
        }
    }

    private fun bind(list: RecyclerView) {
        list.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount() = items.size
            override fun onCreateViewHolder(p: ViewGroup, t: Int): RecyclerView.ViewHolder {
                val r = ui.listRow()
                return object : RecyclerView.ViewHolder(r.view) {}.also { it.itemView.tag = r }
            }
            override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
                val c = items[i]
                val r = h.itemView.tag as CobaltUi.ListRow
                r.title.text = c.name
                r.sub.text = if (c.isFolder) getString(R.string.safe_folder) else android.text.format.Formatter.formatShortFileSize(this@DdnSafeActivity, c.size ?: 0)
                r.icon.setImageResource(ui.typeIcon(c.name, c.isFolder))
                ui.folderTile(r, c.isFolder)
                r.view.setOnClickListener { if (c.isFolder) { path += c.id to c.name; showOpen() } else openFile(c) }
                r.view.setOnLongClickListener { menu(c); true }
            }
        }
        if (items.isEmpty()) body.addView(ui.note(getString(R.string.safe_empty)), 1)
    }

    private fun op(f: () -> Unit) {
        busy(true)
        thread {
            val r = runCatching(f)
            main.post { busy(false); r.onFailure { toast(getString(R.string.ddn_error, it.message)) }; if (DdnSafe.isOpen) showOpen() else show() }
        }
    }

    private fun askName(title: Int, value: String, done: (String) -> Unit) {
        val (box, edit) = ui.field(R.string.safe_name, value)
        box.setPadding(ui.dp(20), ui.dp(8), ui.dp(20), 0)
        MaterialAlertDialogBuilder(this).setTitle(title).setView(box)
            .setPositiveButton(R.string.cobalt_ok) { _, _ -> edit.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let(done) }
            .setNegativeButton(R.string.cobalt_cancel, null).show()
    }

    private fun menu(c: IndexReplica.Child) {
        val acts = ArrayList<Pair<String, () -> Unit>>()
        acts += getString(R.string.ddn_rename) to { askName(R.string.ddn_rename, c.name) { n -> op { DdnSafe.rename(this, c.id, n) } } }
        if (!c.isFolder) acts += getString(R.string.safe_to_files) to {
            MaterialAlertDialogBuilder(this).setTitle(getString(R.string.safe_to_files_ask, c.name)).setMessage(getString(R.string.safe_move_cost, android.text.format.Formatter.formatShortFileSize(this, c.size ?: 0)))
                .setPositiveButton(R.string.safe_to_files) { _, _ -> op { DdnSafe.moveOut(this, c) } }.setNegativeButton(R.string.cobalt_cancel, null).show()
        }
        acts += getString(R.string.safe_delete) to {
            MaterialAlertDialogBuilder(this).setTitle(getString(R.string.safe_delete_ask, c.name)).setMessage(R.string.safe_delete_note)
                .setPositiveButton(R.string.safe_delete) { _, _ -> op { DdnSafe.delete(this, listOf(c.id)) } }.setNegativeButton(R.string.cobalt_cancel, null).show()
        }
        MaterialAlertDialogBuilder(this).setTitle(c.name).setItems(acts.map { it.first }.toTypedArray()) { _, i -> acts[i].second() }.show()
    }

    private fun openFile(c: IndexReplica.Child) {
        busy(true)
        thread {
            val r = runCatching { DdnSafe.fetch(this, c) }
            main.post {
                busy(false)
                r.onSuccess { f ->
                    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
                    val type = contentResolver.getType(uri) ?: android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "*/*"
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)) }
                        .onFailure { toast(getString(R.string.safe_no_viewer)) }
                }.onFailure { toast(getString(R.string.ddn_error, it.message)) }
            }
        }
    }

    private fun upload(uris: List<Uri>) {
        val folder = path.last().first
        op {
            for (u in uris) {
                val (name, size) = contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cur ->
                    if (cur.moveToFirst()) cur.getString(0) to cur.getLong(1) else null
                } ?: ("plik" to -1L)
                DdnSafe.upload(this, { contentResolver.openInputStream(u)!! }, size, name, folder, null)
            }
            main.post { toast(resources.getQuantityString(R.plurals.safe_uploaded, uris.size, uris.size)) }
        }
    }

    companion object {
        fun open(c: Context) = c.startActivity(Intent(c, DdnSafeActivity::class.java))

        /** "Move to the Safe" from Files / the Gallery: the Safe must be open; asks with the cost first. */
        fun moveIn(a: AppCompatActivity, items: List<IndexReplica.Child>, done: () -> Unit) {
            if (!DdnSafe.isOpen) {
                Toast.makeText(a, R.string.safe_need_open, Toast.LENGTH_LONG).show()
                open(a)
                return
            }
            val bytes = items.sumOf { it.size ?: 0 }
            val label = if (items.size == 1) items[0].name else a.resources.getQuantityString(R.plurals.safe_items, items.size, items.size)
            MaterialAlertDialogBuilder(a).setTitle(a.getString(R.string.safe_to_safe_ask, label))
                .setMessage(a.getString(R.string.safe_move_cost, android.text.format.Formatter.formatShortFileSize(a, bytes)) + "\n" + a.getString(R.string.safe_to_safe_note))
                .setPositiveButton(R.string.safe_to_safe) { _, _ ->
                    thread {
                        val r = runCatching { DdnSafe.moveIn(a, items) }
                        Handler(Looper.getMainLooper()).post {
                            r.onSuccess { Toast.makeText(a, a.resources.getQuantityString(R.plurals.safe_moved_in, it, it), Toast.LENGTH_LONG).show() }
                                .onFailure { Toast.makeText(a, a.getString(R.string.ddn_error, it.message), Toast.LENGTH_LONG).show() }
                            done()
                        }
                    }
                }.setNegativeButton(R.string.cobalt_cancel, null).show()
        }
    }
}
