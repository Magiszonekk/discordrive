package com.discordrive.gallery

import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.materialswitch.MaterialSwitch
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The screens made with CobaltUi: section cards, Material switches (no check boxes), buttons never upper-cased,
 * a top bar with back. Screenshots (light / dark) go to the app's files for the review: `ui-<name>-<n>.png`.
 */
@RunWith(AndroidJUnit4::class)
class CobaltScreensTest {
    private fun all(v: View): List<View> = if (v is ViewGroup) listOf(v) + (0 until v.childCount).flatMap { all(v.getChildAt(it)) } else listOf(v)

    @Test
    fun settingsInCards() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<DdnSettingsActivity>(Intent(ctx, DdnSettingsActivity::class.java)).use { s ->
            var cards = 0
            var switches = 0
            var checkBoxes = 0
            var caps = 0
            var plainButtons = 0
            var hasBack = false
            s.onActivity { a ->
                val v = all(a.window.decorView)
                cards = v.count { it is MaterialCardView }
                switches = v.count { it is MaterialSwitch }
                checkBoxes = v.count { it is CheckBox }
                caps = v.filterIsInstance<Button>().count { it.isAllCaps }
                plainButtons = v.filterIsInstance<Button>().count { it !is MaterialButton && it !is CheckBox && it !is MaterialSwitch && it.javaClass.name.startsWith("android.widget") }
                hasBack = v.filterIsInstance<com.google.android.material.appbar.MaterialToolbar>().any { it.navigationIcon != null }
            }
            assertTrue("section cards: $cards", cards >= 5)
            assertTrue("switches: $switches", switches >= 2)
            assertTrue("no check boxes: $checkBoxes", checkBoxes == 0)
            assertTrue("no upper-cased buttons: $caps", caps == 0)
            assertTrue("no plain buttons: $plainButtons", plainButtons == 0)
            assertTrue("top bar with back", hasBack)
            // Review: -e holdMs N keeps the screen open for screenshots.
            InstrumentationRegistry.getArguments().getString("holdMs")?.toLongOrNull()?.let { Thread.sleep(it) }
        }
    }

    @Test
    fun trashHasOneHeadingAndActions() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<DdnTrashActivity>(Intent(ctx, DdnTrashActivity::class.java).putExtra(DdnTrashActivity.KEEP_OPEN_FOR_TEST, true)).use { s ->
            var bars = 0
            var actions = listOf<String>()
            var caps = 0
            s.onActivity { a ->
                val v = all(a.window.decorView)
                bars = v.count { it is com.google.android.material.appbar.MaterialToolbar }
                actions = v.filterIsInstance<MaterialButton>().map { it.text.toString() }
                caps = v.filterIsInstance<Button>().count { it.isAllCaps }
            }
            assertTrue("one top bar: $bars", bars == 1)
            assertTrue("restore and purge: $actions", actions.contains(ctx.getString(R.string.ddn_trash_restore)) && actions.contains(ctx.getString(R.string.ddn_trash_purge)))
            assertTrue("no upper-cased buttons", caps == 0)
            InstrumentationRegistry.getArguments().getString("holdMs")?.toLongOrNull()?.let { Thread.sleep(it) }
        }
    }

    @Test
    fun autoCopyInCards() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<DdnBackupActivity>(Intent(ctx, DdnBackupActivity::class.java)).use { s ->
            var cards = 0
            var switches = 0
            var checkBoxes = 0
            var caps = 0
            s.onActivity { a ->
                val v = all(a.window.decorView)
                cards = v.count { it is MaterialCardView }
                switches = v.count { it is MaterialSwitch }
                checkBoxes = v.count { it is CheckBox }
                caps = v.filterIsInstance<Button>().count { it.isAllCaps }
            }
            assertTrue("cards: $cards", cards >= 3)
            assertTrue("switches: $switches", switches >= 3)
            assertTrue("no check boxes: $checkBoxes", checkBoxes == 0)
            assertTrue("no upper-cased buttons", caps == 0)
            InstrumentationRegistry.getArguments().getString("holdMs")?.toLongOrNull()?.let { Thread.sleep(it) }
        }
    }

    /** The PIN dialog in the Cobalt look, "Anuluj" in Polish whatever the system language. */
    @Test
    fun pinDialogCobalt() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<DdnSettingsActivity>(Intent(ctx, DdnSettingsActivity::class.java)).use { s ->
            var cancel = ""
            s.onActivity { a -> a.openPinDialogForTest()?.let { d -> cancel = d.getButton(android.content.DialogInterface.BUTTON_NEGATIVE).text.toString() } }
            assertTrue("Anuluj: $cancel", cancel == ctx.getString(R.string.cobalt_cancel))
            InstrumentationRegistry.getArguments().getString("holdMs")?.toLongOrNull()?.let { Thread.sleep(it) }
        }
    }

    /** One screen's look: section cards, switches, no check boxes, no plain or upper-cased buttons, a bar with back. */
    private class Look(val cards: Int, val switches: Int, val checkBoxes: Int, val caps: Int, val plainButtons: Int, val hasBack: Boolean)

    private fun look(a: android.app.Activity): Look {
        val v = all(a.window.decorView)
        return Look(
            cards = v.count { it is MaterialCardView },
            switches = v.count { it is MaterialSwitch },
            checkBoxes = v.count { it is CheckBox && it !is com.google.android.material.radiobutton.MaterialRadioButton && it.javaClass != android.widget.RadioButton::class.java },
            caps = v.filterIsInstance<Button>().count { it.isAllCaps },
            plainButtons = v.filterIsInstance<Button>().count { it !is MaterialButton && it !is CheckBox && it !is MaterialSwitch && it !is android.widget.RadioButton && it.javaClass.name.startsWith("android.widget") },
            hasBack = v.filterIsInstance<com.google.android.material.appbar.MaterialToolbar>().any { it.navigationIcon != null },
        )
    }

    @Test
    fun aiSearchInCards() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<DdnAiActivity>(Intent(ctx, DdnAiActivity::class.java)).use { s ->
            var l: Look? = null
            var masked = false
            s.onActivity { a -> l = look(a); masked = a.keyMaskedForTest() }
            val x = l!!
            assertTrue("cards: ${x.cards}", x.cards >= 3)
            assertTrue("switches: ${x.switches}", x.switches >= 4)
            assertTrue("no check boxes: ${x.checkBoxes}", x.checkBoxes == 0)
            assertTrue("no upper-cased buttons: ${x.caps}", x.caps == 0)
            assertTrue("no plain buttons: ${x.plainButtons}", x.plainButtons == 0)
            assertTrue("top bar with back", x.hasBack)
            assertTrue("key masked", masked)
            InstrumentationRegistry.getArguments().getString("holdMs")?.toLongOrNull()?.let { Thread.sleep(it) }
        }
    }

    @Test
    fun freeUpInCards() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<DdnFreeUpActivity>(Intent(ctx, DdnFreeUpActivity::class.java)).use { s ->
            var l: Look? = null
            s.onActivity { a -> l = look(a) }
            val x = l!!
            assertTrue("cards: ${x.cards}", x.cards >= 1)
            assertTrue("no upper-cased buttons: ${x.caps}", x.caps == 0)
            assertTrue("no plain buttons: ${x.plainButtons}", x.plainButtons == 0)
            assertTrue("top bar with back", x.hasBack)
            InstrumentationRegistry.getArguments().getString("holdMs")?.toLongOrNull()?.let { Thread.sleep(it) }
        }
    }

    @Test
    fun searchHasBarAndField() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<DdnSearchActivity>(Intent(ctx, DdnSearchActivity::class.java)).use { s ->
            var l: Look? = null
            var fields = 0
            s.onActivity { a -> l = look(a); fields = all(a.window.decorView).count { it is com.google.android.material.textfield.TextInputLayout } }
            val x = l!!
            assertTrue("top bar with back", x.hasBack)
            assertTrue("a Material field: $fields", fields == 1)
            InstrumentationRegistry.getArguments().getString("holdMs")?.toLongOrNull()?.let { Thread.sleep(it) }
        }
    }

    /** Open with: the photo, its name on the top bar, "Wyślij do discordrive" as the primary button (no caps). */
    @Test
    fun openWithPrimarySend() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val bmp = android.graphics.Bitmap.createBitmap(400, 300, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.rgb(40, 120, 200)) }
        val pic = java.io.File(ctx.cacheDir, "wyglad otworz.jpg").apply { outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, it) } }
        val uri = androidx.core.content.FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", pic)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "image/jpeg").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).setClass(ctx, DdnOpenActivity::class.java)
        ActivityScenario.launch<DdnOpenActivity>(view).use { s ->
            var label = ""
            var caps = true
            var plain = -1
            s.onActivity { a -> a.sendButtonForTest().let { label = it.text.toString(); caps = it.isAllCaps }; plain = look(a).plainButtons }
            assertTrue("send: $label", label == ctx.getString(R.string.ddn_open_send))
            assertTrue("not upper-cased", !caps)
            assertTrue("no plain buttons: $plain", plain == 0)
            InstrumentationRegistry.getArguments().getString("holdMs")?.toLongOrNull()?.let { Thread.sleep(it) }
        }
    }
}
