package com.discordrive.gallery

import android.app.Activity
import android.content.res.ColorStateList
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.widget.TextViewCompat
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

/**
 * The building blocks of the screens made in code, in the Cobalt look (Theme.Ddn.Cobalt, the web's tokens):
 * a screen with a top bar (title, back), section cards with a heading and a note, rows with a switch, labelled
 * fields, buttons (primary, tonal, danger) with icons. One implementation for every such screen: no screen
 * styles its own widgets. Strings are never upper-cased.
 */
class CobaltUi(private val a: AppCompatActivity) {
    fun dp(v: Int) = (v * a.resources.displayMetrics.density).toInt()
    private fun color(id: Int) = ContextCompat.getColor(a, id)
    /** The theme's accent (the account's choice overlays colorPrimary). */
    private fun accent(): Int {
        val tv = android.util.TypedValue()
        a.theme.resolveAttribute(androidx.appcompat.R.attr.colorPrimary, tv, true)
        return tv.data
    }

    /**
     * The screen: a top bar with the title and back, then a scrolling column. Returns the column (sections go
     * into it). Insets: the bar takes the status bar, the column the navigation bar.
     */
    fun screen(@StringRes title: Int, back: Boolean = true, scroll: Boolean = true): LinearLayout {
        val bar = MaterialToolbar(a).apply {
            setTitle(title)
            setTitleTextAppearance(a, R.style.TextAppearance_Cobalt_BarTitle)
            if (back) {
                setNavigationIcon(R.drawable.ic_cobalt_back)
                setNavigationContentDescription(R.string.cobalt_back)
                setNavigationOnClickListener { a.onBackPressedDispatcher.onBackPressed() }
            }
            setBackgroundColor(color(R.color.cobalt_paper))
        }
        val column = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(8), dp(16), if (scroll) dp(24) else 0)
        }
        // A list screen (scroll = false): the column fills the screen, its list scrolls by itself.
        val body: View = if (scroll) ScrollView(a).apply { isFillViewport = true; clipToPadding = false; addView(column) } else column
        val root = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(color(R.color.cobalt_paper))
            addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        a.setContentView(root)
        Insets.apply(bar, top = true, bottom = false)
        Insets.apply(body, top = false, bottom = true)
        return column
    }

    /** A section: a card with a heading (accent) and an optional note; returns its body (rows go into it). */
    fun section(parent: ViewGroup, @StringRes heading: Int, note: CharSequence? = null, danger: Boolean = false): LinearLayout {
        val body = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(14), dp(16), dp(16)) }
        body.addView(TextView(a).apply {
            setText(heading)
            TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_SectionHead)
            setTextColor(if (danger) color(R.color.cobalt_error) else accent())
        })
        if (note != null) body.addView(note(note), lp(top = 4))
        val card = MaterialCardView(a, null, com.google.android.material.R.attr.materialCardViewStyle).apply {
            addView(body)
            if (danger) strokeColor = color(R.color.cobalt_error_rule)
        }
        parent.addView(card, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
        return body
    }

    fun text(s: CharSequence) = TextView(a).apply { text = s; TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Body) }
    fun note(s: CharSequence) = TextView(a).apply { text = s; TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Hint) }

    /** Add `v` to `parent` with a top gap. */
    fun add(parent: ViewGroup, v: View, top: Int = 10): View = v.also { parent.addView(it, lp(top)) }

    fun lp(top: Int = 0) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top) }

    enum class Kind { PRIMARY, TONAL, DANGER }

    /** A button (never upper-cased), full width, with an optional icon. */
    fun button(@StringRes label: Int, kind: Kind = Kind.TONAL, @DrawableRes icon: Int? = null, onClick: () -> Unit): MaterialButton =
        button(a.getString(label), kind, icon, onClick)

    fun button(label: CharSequence, kind: Kind = Kind.TONAL, @DrawableRes icon: Int? = null, onClick: () -> Unit): MaterialButton {
        val style = when (kind) {
            Kind.PRIMARY -> com.google.android.material.R.attr.materialButtonStyle
            Kind.TONAL, Kind.DANGER -> com.google.android.material.R.attr.materialButtonOutlinedStyle
        }
        return MaterialButton(a, null, style).apply {
            text = label
            isAllCaps = false
            if (kind == Kind.TONAL) {
                backgroundTintList = ColorStateList.valueOf(color(R.color.cobalt_paper_2))
                strokeWidth = 0
                setTextColor(color(R.color.cobalt_ink))
                iconTint = ColorStateList.valueOf(accent())
            }
            if (kind == Kind.DANGER) {
                strokeColor = ColorStateList.valueOf(color(R.color.cobalt_error_rule))
                setTextColor(color(R.color.cobalt_error))
                iconTint = ColorStateList.valueOf(color(R.color.cobalt_error))
            }
            if (icon != null) setIconResource(icon)
            gravity = Gravity.CENTER
            setOnClickListener { onClick() }
        }
    }

    /** A row added to `parent`: a label (and a note under it) on the left, a Material switch on the right. */
    fun switchRow(parent: ViewGroup, @StringRes label: Int, checked: Boolean, note: CharSequence? = null, onChange: (MaterialSwitch, Boolean) -> Unit): MaterialSwitch {
        val sw = MaterialSwitch(a).apply { isChecked = checked }
        val texts = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(a).apply { setText(label); TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Label) })
            if (note != null) addView(note(note))
        }
        val row = LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(48)
            addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(sw)
            // The whole row toggles (a bigger target than the switch).
            setOnClickListener { sw.toggle() }
        }
        sw.setOnCheckedChangeListener { v, on -> onChange(v as MaterialSwitch, on) }
        parent.addView(row, lp(top = 6))
        return sw
    }

    /** A labelled field (label above, as on the web). */
    fun field(@StringRes label: Int, value: String = "", password: Boolean = false, hint: CharSequence? = null): Pair<View, TextInputEditText> {
        val edit = TextInputEditText(a).apply {
            setText(value)
            TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Body)
            setTextColor(color(R.color.cobalt_ink))
            if (password) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setPadding(dp(12), dp(12), dp(12), dp(12))
            if (hint != null) this.hint = hint
        }
        val box = TextInputLayout(a, null, com.google.android.material.R.attr.textInputStyle).apply {
            if (password) endIconMode = TextInputLayout.END_ICON_PASSWORD_TOGGLE
            addView(edit, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val col = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(a).apply { setText(label); TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Label) })
            addView(box, lp(top = 6))
        }
        return col to edit
    }

    /** A bottom bar of actions (side by side, equal width): added to `parent`, returns it. */
    fun actionBar(parent: ViewGroup, vararg buttons: MaterialButton): LinearLayout {
        val bar = LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(8), 0, dp(12))
            buttons.forEachIndexed { i, b -> addView(b, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { if (i > 0) marginStart = dp(8) }) }
        }
        parent.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return bar
    }

    /**
     * A list row: a leading view (selection box or icon), an icon, a title and a sub line; ripple, 56dp+.
     * Returned with its parts for binding.
     */
    class ListRow(val view: LinearLayout, val icon: android.widget.ImageView, val title: TextView, val sub: TextView)

    fun listRow(leading: View? = null): ListRow {
        val icon = android.widget.ImageView(a).apply {
            setColorFilter(color(R.color.cobalt_muted))
            setBackgroundResource(R.drawable.bg_cobalt_icon)
            setPadding(dp(8), dp(8), dp(8), dp(8))
        }
        val title = TextView(a).apply { TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Label); setTextColor(color(R.color.cobalt_ink)); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE }
        val sub = TextView(a).apply { TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Hint) }
        val texts = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, 0, 0); addView(title); addView(sub) }
        val v = LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(60)
            setPadding(dp(4), dp(6), dp(8), dp(6))
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            isClickable = true
            val tv = android.util.TypedValue()
            a.theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true)
            setBackgroundResource(tv.resourceId)
            if (leading != null) addView(leading)
            addView(icon, LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginStart = dp(4) })
            addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        return ListRow(v, icon, title, sub)
    }

    /** The footer: centered small text (version, technical notes). */
    fun footer(parent: ViewGroup, s: CharSequence): TextView = note(s).apply { gravity = Gravity.CENTER_HORIZONTAL }.also { parent.addView(it, lp(top = 20)) }

    companion object {
        /** Activities that use CobaltUi set this theme before super.onCreate (the manifest may keep another). */
        fun theme(a: Activity) {
            a.setTheme(R.style.Theme_Ddn_Cobalt)
            Settings.accentOverlay(a)?.let { a.theme.applyStyle(it, true) }
        }
    }
}
