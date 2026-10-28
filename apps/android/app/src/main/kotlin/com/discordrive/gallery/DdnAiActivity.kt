package com.discordrive.gallery

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.text.InputType
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import io.github.magiszonekk.discordrive.core.AiDescriber
import io.github.magiszonekk.discordrive.core.Describe
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

/** Settings → AI search: the endpoint, a connection check, when to describe, progress. */
class DdnAiActivity : AppCompatActivity() {
    private lateinit var url: EditText
    private lateinit var key: EditText
    private lateinit var model: EditText
    private lateinit var result: TextView
    private lateinit var progress: TextView
    private lateinit var on: com.google.android.material.materialswitch.MaterialSwitch
    @Volatile private var loaded = false
    private lateinit var relang: com.google.android.material.button.MaterialButton

    private fun paintRelang() {
        thread {
            val n = runCatching { DdnSession.get(this)?.let { DdnAi.otherLang(this, it).size } }.getOrNull() ?: 0
            runOnUiThread { relang.text = plq(R.plurals.ddn_ai_relang, n, n); relang.isEnabled = n > 0 }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        CobaltUi.theme(this)
        super.onCreate(savedInstanceState)
        val ui = CobaltUi(this)
        val page = ui.screen(R.string.ddn_ai_title)
        val s = DdnSession.get(this)
        DdnAi.reloadConfig()

        // The endpoint: what is sent where (the note), address, key (masked, the eye shows it), model.
        val note = buildString {
            append(getString(R.string.ddn_ai_privacy))
            if (s?.acct?.mode == io.github.magiszonekk.discordrive.core.AccountState.MODE_PLAIN) append("\n\n").append(getString(R.string.ddn_ai_plain_note))
            append("\n\n").append(getString(R.string.ddn_ai_where_vault))
        }
        val endpoint = ui.section(page, R.string.ddn_ai_h_endpoint, note)
        // Single line first: setSingleLine resets the input type's transformation (a password field showed the key).
        fun field(label: Int, type: Int, password: Boolean = false): EditText {
            val (box, edit) = ui.field(label, password = password)
            edit.isSingleLine = true
            edit.inputType = type
            ui.add(endpoint, box, top = 14)
            return edit
        }
        url = field(R.string.ddn_ai_url, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        key = field(R.string.ddn_ai_key, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD, password = true)
        model = field(R.string.ddn_ai_model, InputType.TYPE_CLASS_TEXT)
        // The account's settings come from the server (off the main thread); fields the user typed meanwhile stay.
        thread {
            val cfg = runCatching { DdnAi.config(this, s) }.getOrNull()
            runOnUiThread {
                if (cfg != null) {
                    if (url.text.isEmpty()) url.setText(cfg.url)
                    if (key.text.isEmpty()) key.setText(cfg.key)
                    if (model.text.isEmpty()) model.setText(cfg.model)
                }
                loaded = true
            }
        }
        ui.add(endpoint, ui.button(R.string.ddn_ai_pick_model, CobaltUi.Kind.TONAL, R.drawable.ic_cobalt_sparkles) { pickModel() }, top = 14)
        ui.add(endpoint, ui.button(R.string.ddn_ai_save_check, CobaltUi.Kind.PRIMARY) { saveAndCheck() }, top = 10)
        result = ui.note("").apply { tag = "ddn-ai-result" }
        ui.add(endpoint, result, top = 10)

        // When: in the background (with the auto-copy's conditions), private albums, Describe now, progress.
        val whenBox = ui.section(page, R.string.ddn_ai_h_when)
        on = ui.switchRow(whenBox, R.string.ddn_ai_on, DdnAi.enabled(this)) { v, x ->
            if (x && current().let { it.url.isEmpty() || it.model.isEmpty() }) { v.isChecked = false; result.text = getString(R.string.ddn_ai_need_config); return@switchRow }
            DdnAi.set(this@DdnAiActivity, on = x)
            if (x) DdnAi.runNow(this@DdnAiActivity)
        }
        ui.switchRow(whenBox, R.string.ddn_backup_wifi, DdnAi.wifiOnly(this)) { _, x -> DdnAi.set(this, wifi = x) }
        ui.switchRow(whenBox, R.string.ddn_backup_charging, DdnAi.chargingOnly(this)) { _, x -> DdnAi.set(this, charging = x) }
        ui.switchRow(whenBox, R.string.ddn_ai_private, DdnAi.privateAllowed(this)) { _, x -> DdnAi.set(this, private = x) }
        ui.add(whenBox, ui.button(R.string.ddn_ai_now, CobaltUi.Kind.TONAL) {
            if (current().let { it.url.isEmpty() || it.model.isEmpty() }) result.text = getString(R.string.ddn_ai_need_config)
            else { DdnAi.runNow(this@DdnAiActivity); result.text = getString(R.string.ddn_ai_started) }
        }, top = 12)
        progress = ui.note("").apply { tag = "ddn-ai-progress" }
        ui.add(whenBox, progress, top = 10)

        // The language of new descriptions and tags (the app's by default); files described in another one
        // can be described again (kept on this phone).
        val langBox = ui.section(page, R.string.ddn_ai_h_lang, getString(R.string.ddn_ai_lang_title))
        val langs = listOf("pl" to R.string.ddn_ai_lang_pl, "en" to R.string.ddn_ai_lang_en)
        val group = android.widget.RadioGroup(this)
        for ((i, l) in langs.withIndex()) group.addView(com.google.android.material.radiobutton.MaterialRadioButton(this).apply {
            id = 7100 + i; text = getString(l.second); isChecked = DdnAi.lang(this@DdnAiActivity) == l.first
            androidx.core.widget.TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); minHeight = ui.dp(48)
        })
        group.setOnCheckedChangeListener { _, id -> DdnAi.setLang(this, langs[id - 7100].first); paintRelang() }
        ui.add(langBox, group, top = 6)
        relang = ui.button("", CobaltUi.Kind.TONAL) {
            if (current().let { it.url.isEmpty() || it.model.isEmpty() }) result.text = getString(R.string.ddn_ai_need_config)
            else { DdnAi.runRelang(this@DdnAiActivity); result.text = getString(R.string.ddn_ai_started) }
        }
        ui.add(langBox, relang, top = 10)
        ui.add(langBox, ui.note(getString(R.string.ddn_ai_relang_note)), top = 8)
        paintRelang()
    }

    private val tick = object : Runnable {
        override fun run() {
            DdnAi.live?.let { (n, total) -> progress.text = getString(R.string.ddn_ai_described, minOf(n, total), total) } ?: showProgress()
            progress.postDelayed(this, 2000)
        }
    }

    override fun onResume() {
        super.onResume()
        showProgress()
        progress.postDelayed(tick, 2000)
    }

    override fun onPause() {
        super.onPause()
        progress.removeCallbacks(tick)
    }

    private fun showProgress() {
        val c = this
        thread {
            val s = DdnSession.get(c) ?: return@thread
            val acct = s.acct.accountId
            val total = runCatching { DdnAi.candidates(c, s).size }.getOrDefault(0)
            val n = DdnAi.Db(c).count(acct, "ok")
            val st = DdnAi.status(c)
            runOnUiThread {
                progress.text = getString(R.string.ddn_ai_described, minOf(n, total), total) +
                    (st?.gone?.takeIf { it > 0 }?.let { "\n" + plq(R.plurals.ddn_ai_gone, it, it) } ?: "") +
                    (st?.error?.let { "\n" + getString(R.string.ddn_ai_last_error, it) } ?: "")
            }
        }
    }

    private fun current() = Describe.AiConfig(url.text.toString().trim(), key.text.toString().trim(), model.text.toString().trim())

    private fun pickModel() {
        val c = current()
        if (c.url.isEmpty()) { result.text = getString(R.string.ddn_ai_need_url); return }
        result.text = getString(R.string.ddn_ai_fetching)
        thread {
            val r = runCatching { AiDescriber(c.url, c.key, "").models() }
            runOnUiThread {
                r.onSuccess { list ->
                    if (list.isEmpty()) { result.text = getString(R.string.ddn_ai_no_models); return@onSuccess }
                    result.text = ""
                    com.google.android.material.dialog.MaterialAlertDialogBuilder(this).setTitle(R.string.ddn_ai_model).setItems(list.toTypedArray()) { _, i -> model.setText(list[i]) }.show()
                }.onFailure { result.text = getString(R.string.ddn_ai_models_failed, DdnAi.reason(this, it)) }
            }
        }
    }

    /** Store the settings, then one test picture → a description (the user sees what the model answers). */
    private fun saveAndCheck() {
        val c = current()
        if (c.url.isEmpty() || c.model.isEmpty()) { result.text = getString(R.string.ddn_ai_need_config); return }
        result.text = getString(R.string.ddn_ai_checking)
        thread {
            val r = runCatching {
                DdnAi.saveConfig(this, DdnSession.get(this), c)
                AiDescriber(c.url, c.key, c.model).describe(testPicture(), DdnAi.lang(this))
            }
            runOnUiThread {
                r.onSuccess { rec -> result.text = getString(R.string.ddn_ai_check_ok, rec.description, rec.tags.joinToString(", "), rec.text ?: "—") }
                    .onFailure { result.text = getString(R.string.ddn_ai_check_failed, DdnAi.reason(this, it)) }
            }
        }
    }

    /** A picture with a known text (the check shows whether the model reads it). */
    private fun testPicture(): ByteArray {
        val b = Bitmap.createBitmap(640, 360, Bitmap.Config.ARGB_8888)
        val cv = Canvas(b)
        cv.drawColor(Color.rgb(250, 240, 200))
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(200, 40, 40) }
        cv.drawCircle(160f, 180f, 110f, p)
        p.color = Color.BLACK; p.textSize = 56f; p.isFakeBoldText = true
        cv.drawText("DISCORDRIVE 42", 290f, 200f, p)
        return ByteArrayOutputStream().use { o -> b.compress(Bitmap.CompressFormat.JPEG, 85, o); o.toByteArray() }
    }

    internal fun resultForTest(): String = result.text.toString()
    internal fun loadedForTest(): Boolean = loaded
    internal fun fieldsForTest(): Triple<String, String, String> = Triple(url.text.toString(), key.text.toString(), model.text.toString())
    internal fun progressForTest(): String = progress.text.toString()
    internal fun fillForTest(u: String, k: String, m: String) { url.setText(u); key.setText(k); model.setText(m) }
    internal fun checkForTest() = saveAndCheck()
    internal fun keyMaskedForTest(): Boolean = key.transformationMethod is android.text.method.PasswordTransformationMethod
}
