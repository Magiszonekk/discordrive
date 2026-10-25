package com.discordrive.gallery

import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.text.InputType
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
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
    private lateinit var on: SwitchCompat
    @Volatile private var loaded = false
    private lateinit var relang: Button

    private fun paintRelang() {
        thread {
            val n = runCatching { DdnSession.get(this)?.let { DdnAi.otherLang(this, it).size } }.getOrNull() ?: 0
            runOnUiThread { relang.text = plq(R.plurals.ddn_ai_relang, n, n); relang.isEnabled = n > 0 }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = getString(R.string.ddn_ai_title)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad); setBackgroundColor(getColor(R.color.bg)) }
        fun text(s: CharSequence, dim: Boolean = false) = TextView(this).apply { text = s; textSize = if (dim) 13f else 15f; setTextColor(getColor(if (dim) R.color.text_dim else R.color.text)); setPadding(0, pad / 4, 0, pad / 4) }
        // Single line first: setSingleLine resets the input type's transformation (a password field showed the key).
        fun field(hint: Int, type: Int) = EditText(this).apply { this.hint = getString(hint); isSingleLine = true; inputType = type; setTextColor(getColor(R.color.text)); setHintTextColor(getColor(R.color.text_dim)) }
        fun check(s: Int, v: Boolean, f: (Boolean) -> Unit) = CheckBox(this).apply { text = getString(s); isChecked = v; setTextColor(getColor(R.color.text)); setOnCheckedChangeListener { _, x -> f(x) } }

        val s = DdnSession.get(this)
        DdnAi.reloadConfig()
        root.addView(text(getString(R.string.ddn_ai_privacy), dim = true))
        if (s?.acct?.mode == io.github.magiszonekk.discordrive.core.AccountState.MODE_PLAIN) root.addView(text(getString(R.string.ddn_ai_plain_note), dim = true))
        root.addView(text(getString(R.string.ddn_ai_where_vault), dim = true))
        url = field(R.string.ddn_ai_url, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        key = field(R.string.ddn_ai_key, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
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
        root.addView(url); root.addView(key)
        root.addView(CheckBox(this).apply {
            text = getString(R.string.ddn_ai_show_key); setTextColor(getColor(R.color.text))
            setOnCheckedChangeListener { _, x ->
                key.transformationMethod = if (x) null else android.text.method.PasswordTransformationMethod.getInstance()
                key.setSelection(key.text.length)
            }
        })
        root.addView(model)
        root.addView(Button(this).apply { text = getString(R.string.ddn_ai_pick_model); setOnClickListener { pickModel() } })
        root.addView(Button(this).apply { text = getString(R.string.ddn_ai_save_check); setOnClickListener { saveAndCheck() } })
        result = text("", dim = true).apply { tag = "ddn-ai-result" }
        root.addView(result)

        on = SwitchCompat(this).apply {
            text = getString(R.string.ddn_ai_on); isChecked = DdnAi.enabled(this@DdnAiActivity); textSize = 16f; setTextColor(getColor(R.color.text))
            setOnCheckedChangeListener { v, x ->
                if (x && current().let { it.url.isEmpty() || it.model.isEmpty() }) { v.isChecked = false; result.text = getString(R.string.ddn_ai_need_config); return@setOnCheckedChangeListener }
                DdnAi.set(this@DdnAiActivity, on = x)
                if (x) DdnAi.runNow(this@DdnAiActivity)
            }
        }
        root.addView(on)
        root.addView(check(R.string.ddn_backup_wifi, DdnAi.wifiOnly(this)) { DdnAi.set(this, wifi = it) })
        root.addView(check(R.string.ddn_backup_charging, DdnAi.chargingOnly(this)) { DdnAi.set(this, charging = it) })
        root.addView(check(R.string.ddn_ai_private, DdnAi.privateAllowed(this)) { DdnAi.set(this, private = it) })
        root.addView(Button(this).apply {
            text = getString(R.string.ddn_ai_now)
            setOnClickListener {
                if (current().let { it.url.isEmpty() || it.model.isEmpty() }) result.text = getString(R.string.ddn_ai_need_config)
                else { DdnAi.runNow(this@DdnAiActivity); result.text = getString(R.string.ddn_ai_started) }
            }
        })
        progress = text("", dim = true).apply { tag = "ddn-ai-progress" }
        root.addView(progress)

        // The language of new descriptions and tags (the app's by default); files described in another one
        // can be described again (kept on this phone).
        root.addView(text(getString(R.string.ddn_ai_lang_title)))
        val langs = listOf("pl" to R.string.ddn_ai_lang_pl, "en" to R.string.ddn_ai_lang_en)
        val group = android.widget.RadioGroup(this)
        for ((i, l) in langs.withIndex()) group.addView(android.widget.RadioButton(this).apply {
            id = 7100 + i; text = getString(l.second); setTextColor(getColor(R.color.text)); isChecked = DdnAi.lang(this@DdnAiActivity) == l.first
        })
        group.setOnCheckedChangeListener { _, id -> DdnAi.setLang(this, langs[id - 7100].first); paintRelang() }
        root.addView(group)
        relang = Button(this).apply { setOnClickListener {
            if (current().let { it.url.isEmpty() || it.model.isEmpty() }) result.text = getString(R.string.ddn_ai_need_config)
            else { DdnAi.runRelang(this@DdnAiActivity); result.text = getString(R.string.ddn_ai_started) }
        } }
        root.addView(relang)
        root.addView(text(getString(R.string.ddn_ai_relang_note), dim = true))
        paintRelang()

        setContentView(ScrollView(this).apply { addView(root) })
        Insets.apply(root)
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
                    AlertDialog.Builder(this).setTitle(R.string.ddn_ai_model).setItems(list.toTypedArray()) { _, i -> model.setText(list[i]) }.show()
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
