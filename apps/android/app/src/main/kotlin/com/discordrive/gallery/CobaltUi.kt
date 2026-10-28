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
            // Cards sit on the page colour (a step darker than a card); a list screen sits on paper.
            setBackgroundColor(color(if (scroll) R.color.cobalt_page else R.color.cobalt_paper))
            titleMarginStart = if (back) dp(8) else dp(16)
            minimumHeight = dp(64)
        }
        val column = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(4), dp(16), if (scroll) dp(32) else 0)
            // The bottom action bar of a list screen reaches the screen's edges (negative margins).
            clipToPadding = scroll
        }
        // A list screen (scroll = false): the column fills the screen, its list scrolls by itself.
        // The insets go on a wrapper, never on the column itself (they would replace its 16dp side padding).
        val body: View = if (scroll) ScrollView(a).apply { isFillViewport = true; clipToPadding = false; addView(column) }
            else android.widget.FrameLayout(a).apply { addView(column, android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)) }
        val root = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(color(if (scroll) R.color.cobalt_page else R.color.cobalt_paper))
            addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(body, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        a.setContentView(root)
        Insets.apply(bar, top = true, bottom = false)
        Insets.apply(body, top = false, bottom = true)
        return column
    }

    /** A section: a card with a heading (accent) and an optional note; returns its body (rows go into it). */
    fun section(parent: ViewGroup, @StringRes heading: Int, note: CharSequence? = null, danger: Boolean = false): LinearLayout =
        sectionText(parent, a.getString(heading), note, danger)

    fun sectionText(parent: ViewGroup, heading: CharSequence, note: CharSequence? = null, danger: Boolean = false): LinearLayout {
        // A filled card a step lighter than the page (Widget.Cobalt.Card.Section), no frame: the danger zone
        // alone gets a faint red frame, so it reads as different before its heading is read.
        val body = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(16), dp(16), dp(16)) }
        body.addView(TextView(a).apply {
            text = heading
            TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_SectionHead)
            setTextColor(if (danger) color(R.color.cobalt_error) else accent())
            isAccessibilityHeading = true
        })
        if (note != null) body.addView(note(note), lp(top = 6))
        val card = MaterialCardView(a, null, com.google.android.material.R.attr.materialCardViewStyle).apply {
            addView(body)
            if (danger) { strokeColor = color(R.color.cobalt_error_rule); strokeWidth = dp(1) }
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
        // All three start from Widget.Cobalt.Button (6dp, 48dp, no caps, no shadow); tonal and danger recolour it.
        // The colour lists are theme-aware selectors (the account's accent; 38% when disabled).
        return MaterialButton(a, null, com.google.android.material.R.attr.materialButtonStyle).apply {
            text = label
            isAllCaps = false
            when (kind) {
                Kind.PRIMARY -> Unit
                Kind.TONAL -> if (icon != null) {
                    // A tonal button with an icon opens something (a screen, a picker, a dialog): it reads as a
                    // menu row: neutral well, accent icon at the start, the label left-aligned, a chevron at the end.
                    backgroundTintList = csl(R.color.cobalt_well)
                    setTextColor(csl(R.color.cobalt_button_tonal_text))
                    iconTint = csl(R.color.cobalt_button_tonal_icon)
                    rippleColor = csl(R.color.cobalt_ripple_accent)
                    iconGravity = MaterialButton.ICON_GRAVITY_START
                    iconPadding = dp(14)
                    setPaddingRelative(dp(16), 0, dp(40), 0)
                    minHeight = dp(52)
                    foreground = chevron()
                } else {
                    // A tonal action (Restore, System defaults): the accent at 12%, ink label, centred.
                    backgroundTintList = csl(R.color.cobalt_button_tonal_bg)
                    setTextColor(csl(R.color.cobalt_button_tonal_text))
                    rippleColor = csl(R.color.cobalt_ripple_accent)
                }
                Kind.DANGER -> {
                    backgroundTintList = csl(R.color.cobalt_button_danger_bg)
                    setTextColor(csl(R.color.cobalt_button_danger_text))
                    iconTint = csl(R.color.cobalt_button_danger_text)
                    rippleColor = csl(R.color.cobalt_ripple_danger)
                }
            }
            if (icon != null) setIconResource(icon)
            val menuLike = kind == Kind.TONAL && icon != null
            gravity = if (menuLike) Gravity.START or Gravity.CENTER_VERTICAL else Gravity.CENTER
            textAlignment = if (menuLike) View.TEXT_ALIGNMENT_VIEW_START else View.TEXT_ALIGNMENT_CENTER
            setOnClickListener { onClick() }
        }
    }

    private fun csl(id: Int): ColorStateList = ContextCompat.getColorStateList(a, id)!!

    /** The chevron at the end of a menu-like button / a navigation row (muted, mirrored in RTL). */
    private fun chevron(): android.graphics.drawable.Drawable {
        val d = ContextCompat.getDrawable(a, R.drawable.ic_cobalt_chevron)!!.mutate().apply { setTint(color(R.color.cobalt_muted)) }
        return android.graphics.drawable.LayerDrawable(arrayOf(d)).apply {
            setLayerGravity(0, Gravity.END or Gravity.CENTER_VERTICAL)
            setLayerSize(0, dp(18), dp(18))
            setLayerInsetEnd(0, dp(14))
        }
    }

    /** A row added to `parent`: a label (and a note under it) on the left, a Material switch on the right. */
    fun switchRow(parent: ViewGroup, @StringRes label: Int, checked: Boolean, note: CharSequence? = null, onChange: (MaterialSwitch, Boolean) -> Unit): MaterialSwitch =
        switchRowText(parent, a.getString(label), checked, note, onChange)

    fun switchRowText(parent: ViewGroup, label: CharSequence, checked: Boolean, note: CharSequence? = null, onChange: (MaterialSwitch, Boolean) -> Unit): MaterialSwitch {
        val sw = MaterialSwitch(a).apply { isChecked = checked }
        val texts = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(a).apply { text = label; TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle) })
            if (note != null) addView(TextView(a).apply { text = note; TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowSub) }, lp(top = 2))
            setPaddingRelative(0, 0, dp(12), 0)
        }
        val row = LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(56)
            setPadding(0, dp(6), 0, dp(6))
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
        // An edit text made in code keeps the platform's underline as its background; the layout draws the
        // outlined box only when that background is gone (as for one inflated inside it from XML).
        edit.background = null
        val box = TextInputLayout(a, null, com.google.android.material.R.attr.textInputStyle).apply {
            boxBackgroundMode = TextInputLayout.BOX_BACKGROUND_OUTLINE
            if (password) endIconMode = TextInputLayout.END_ICON_PASSWORD_TOGGLE
            addView(edit, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val col = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(a).apply { setText(label); TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Label) })
            addView(box, lp(top = 6))
            box.boxBackgroundColor = color(R.color.cobalt_field)
        }
        return col to edit
    }

    /** A bottom bar of actions (side by side, equal width): added to `parent`, returns it. */
    fun actionBar(parent: ViewGroup, vararg buttons: MaterialButton): LinearLayout {
        // A bar on the card colour with a hairline on top, edge to edge (the column pads 16dp: the bar takes it
        // back), the buttons 52dp side by side. At a large font the labels shrink to fit on one line.
        val bar = LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundResource(R.drawable.bg_cobalt_actionbar)
            setPadding(dp(16), dp(12), dp(16), dp(12))
            buttons.forEachIndexed { i, b ->
                b.minHeight = dp(52)
                b.maxLines = 1
                TextViewCompat.setAutoSizeTextTypeUniformWithConfiguration(b, 12, 15, 1, android.util.TypedValue.COMPLEX_UNIT_SP)
                addView(b, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { if (i > 0) marginStart = dp(10) })
            }
        }
        val side = if (parent.paddingStart > 0) parent.paddingStart else 0
        parent.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = -side; marginEnd = -side; topMargin = dp(4) })
        return bar
    }

    /**
     * A list row: a leading view (selection box or icon), an icon, a title and a sub line; ripple, 56dp+.
     * Returned with its parts for binding.
     */
    class ListRow(val view: LinearLayout, val icon: android.widget.ImageView, val title: TextView, val sub: TextView)

    fun listRow(leading: View? = null): ListRow {
        // The icon tile: 44dp, rounded 10dp, the type icon 22dp in it (muted); a thumbnail set into it fills
        // the tile and keeps the corners (clipToOutline).
        val icon = android.widget.ImageView(a).apply {
            setColorFilter(color(R.color.cobalt_muted))
            setBackgroundResource(R.drawable.bg_cobalt_icon)
            setPadding(dp(11), dp(11), dp(11), dp(11))
            clipToOutline = true
        }
        val title = TextView(a).apply { TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowTitle); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.MIDDLE }
        val sub = TextView(a).apply { TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_RowSub); maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END }
        val texts = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPaddingRelative(dp(14), 0, 0, 0); addView(title); addView(sub, lp(top = 2)) }
        val v = LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(68)
            setPaddingRelative(dp(4), dp(8), dp(8), dp(8))
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            isClickable = true
            val tv = android.util.TypedValue()
            a.theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true)
            setBackgroundResource(tv.resourceId)
            if (leading != null) addView(leading)
            addView(icon, LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginStart = if (leading != null) dp(8) else dp(4) })
            addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        return ListRow(v, icon, title, sub)
    }

    /** The footer: centered small text (version, technical notes). */
    fun footer(parent: ViewGroup, s: CharSequence): TextView = TextView(a).apply {
        text = s
        TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_Meta)
        gravity = Gravity.CENTER_HORIZONTAL
    }.also { parent.addView(it, lp(top = 24)) }

    // ── Additions for the next screens (Files, Albums, Viewer); nothing above depends on them. ──

    /** The app's name for a main bar: "discor" in ink, "drive" in the accent (like "DiscorDrive Gallery"). */
    fun brand(): CharSequence = android.text.SpannableString("discordrive").apply {
        setSpan(android.text.style.ForegroundColorSpan(accent()), 6, 11, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }

    /** A Lucide type icon for a file row's tile by its name (folder, image, video, audio, document, archive, other). */
    @DrawableRes fun typeIcon(name: String, folder: Boolean): Int = typeIconOf(name, folder)

    /** A folder row's tile: the accent at 12% with the icon in the accent (files keep the neutral tile). */
    fun folderTile(row: ListRow, folder: Boolean) {
        row.icon.backgroundTintList = if (folder) csl(R.color.cobalt_tile_accent) else null
        row.icon.setColorFilter(if (folder) accent() else color(R.color.cobalt_muted))
    }

    /** A thumbnail into a row's tile: fills it, keeps the rounded corners; `null` puts the type icon back. */
    fun thumb(row: ListRow, bmp: android.graphics.Bitmap?, @DrawableRes fallback: Int) {
        if (bmp != null) {
            row.icon.setPadding(0, 0, 0, 0); row.icon.clearColorFilter(); row.icon.scaleType = android.widget.ImageView.ScaleType.CENTER_CROP; row.icon.setImageBitmap(bmp)
        } else {
            row.icon.setPadding(dp(11), dp(11), dp(11), dp(11)); row.icon.setColorFilter(color(R.color.cobalt_muted)); row.icon.scaleType = android.widget.ImageView.ScaleType.FIT_CENTER; row.icon.setImageResource(fallback)
        }
    }

    /**
     * A navigation row in a section (Auto-backup, AI search, Trash, Free up space): an accent icon tile, the label
     * and a note, a chevron; the whole row is the target. Added to `parent`, returned.
     */
    fun navRow(parent: ViewGroup, @StringRes label: Int, @DrawableRes icon: Int, note: CharSequence? = null, onClick: () -> Unit): View {
        val r = listRow()
        r.icon.setImageResource(icon)
        folderTile(r, true)
        r.title.setText(label)
        r.title.ellipsize = android.text.TextUtils.TruncateAt.END
        if (note != null) r.sub.text = note else r.sub.visibility = View.GONE
        r.view.addView(android.widget.ImageView(a).apply { setImageDrawable(ContextCompat.getDrawable(a, R.drawable.ic_cobalt_chevron)); setColorFilter(color(R.color.cobalt_muted)) }, LinearLayout.LayoutParams(dp(18), dp(18)))
        r.view.setPaddingRelative(0, dp(6), 0, dp(6))
        (r.icon.layoutParams as LinearLayout.LayoutParams).marginStart = 0
        r.view.setOnClickListener { onClick() }
        parent.addView(r.view, lp(top = 2))
        return r.view
    }

    /**
     * The viewer's bottom bar: actions as an icon over a label (Share, Download, Edit, Info, Trash), white on a
     * scrim over the photo, the trash in the error colour. Returns the bar (the caller places it at the bottom).
     */
    fun viewerActions(vararg actions: Triple<Int, Int, () -> Unit>, dangerLast: Boolean = true): LinearLayout =
        LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundResource(R.drawable.bg_cobalt_scrim_bottom)
            setPadding(dp(8), dp(28), dp(8), dp(10))
            actions.forEachIndexed { i, (label, icon, onClick) ->
                val danger = dangerLast && i == actions.lastIndex
                val tint = if (danger) 0xFFFF8A85.toInt() else color(R.color.cobalt_on_scrim)
                addView(LinearLayout(a).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER
                    minimumHeight = dp(56)
                    isClickable = true
                    val tv = android.util.TypedValue()
                    a.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, tv, true)
                    setBackgroundResource(tv.resourceId)
                    contentDescription = a.getString(label)
                    addView(android.widget.ImageView(a).apply { setImageResource(icon); setColorFilter(tint) }, LinearLayout.LayoutParams(dp(24), dp(24)))
                    addView(TextView(a).apply {
                        setText(label); TextViewCompat.setTextAppearance(this, R.style.TextAppearance_Cobalt_ActionLabel); setTextColor(tint)
                        maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                    }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
                    setOnClickListener { onClick() }
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            }
        }

    companion object {
        /** The same as [typeIcon], without an activity (grids of other screens). */
        @DrawableRes fun typeIconOf(name: String, folder: Boolean): Int {
            if (folder) return R.drawable.ic_cobalt_folder
            return when (name.substringAfterLast('.', "").lowercase()) {
                "jpg", "jpeg", "png", "webp", "heic", "heif", "gif", "avif", "bmp", "dng" -> R.drawable.ic_cobalt_image
                "mp4", "mov", "mkv", "webm", "avi", "3gp", "m4v" -> R.drawable.ic_cobalt_film
                "mp3", "m4a", "flac", "wav", "ogg", "opus", "aac" -> R.drawable.ic_cobalt_music
                "pdf", "txt", "md", "doc", "docx", "odt", "rtf", "xls", "xlsx", "csv", "ppt", "pptx" -> R.drawable.ic_cobalt_doc
                "zip", "7z", "rar", "tar", "gz", "xz", "zst", "apk" -> R.drawable.ic_cobalt_archive
                else -> R.drawable.ic_cobalt_file
            }
        }

        /** Activities that use CobaltUi set this theme before super.onCreate (the manifest may keep another). */
        fun theme(a: Activity) {
            a.setTheme(R.style.Theme_Ddn_Cobalt)
            Settings.accentOverlay(a)?.let { a.theme.applyStyle(it, true) }
        }
    }
}
