package com.discordrive.gallery

import android.content.Intent
import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * After a join that left a note to act on (the snapshot pointer unavailable), the note stays and OK, enabled
 * and the only button left, opens the files.
 */
@RunWith(AndroidJUnit4::class)
class JoinNoteTest {
    @Test
    fun okAfterTheNoteOpensTheFiles() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val mon = InstrumentationRegistry.getInstrumentation().addMonitor(DdnActivity::class.java.name, null, true)
        ActivityScenario.launch<JoinActivity>(Intent(ctx, JoinActivity::class.java)).use { s ->
            var shown = false
            var others = true
            s.onActivity { a ->
                a.joinedWithNoteForTest()
                val ok = a.okForTest()
                shown = ok.visibility == View.VISIBLE && ok.isEnabled
                // Every other button of the screen hidden or the pairing's start / kit ones (not "Yes, the same").
                others = (0 until (ok.parent as android.view.ViewGroup).childCount).map { (ok.parent as android.view.ViewGroup).getChildAt(it) }
                    .filterIsInstance<android.widget.Button>().none { it !== ok && it.visibility == View.VISIBLE && it.text == ctx.getString(R.string.ddn_sas_yes) }
                ok.performClick()
            }
            assertTrue("OK shown and enabled", shown)
            assertTrue("no pairing button left next to OK", others)
            assertTrue("OK opens the files", InstrumentationRegistry.getInstrumentation().waitForMonitorWithTimeout(mon, 5_000) != null)
        }
    }
}
