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
                others = a.findViewById<android.widget.Button>(R.id.joinYes).visibility != View.VISIBLE && a.findViewById<android.widget.Button>(R.id.joinNo).visibility != View.VISIBLE
                ok.performClick()
            }
            assertTrue("OK shown and enabled", shown)
            assertTrue("no pairing button left next to OK", others)
            // A blocking monitor stops the start (no activity is made): its hit count says it was asked for.
            val until = System.currentTimeMillis() + 5_000
            while (mon.hits == 0 && System.currentTimeMillis() < until) Thread.sleep(100)
            assertTrue("OK opens the files", mon.hits > 0)
        }
    }

    /** "Copy code" next to the pairing code: the clipboard holds exactly the code shown. */
    @Test
    fun copyPutsTheCodeOnTheClipboard() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<JoinActivity>(Intent(ctx, JoinActivity::class.java).putExtra("server", "https://example.com")).use { s ->
            var code: String? = null
            var copied: String? = null
            var buttons = false
            s.onActivity { a ->
                a.findViewById<android.widget.Button>(R.id.joinStart).performClick()
                code = a.codeForTest()
                buttons = a.findViewById<View>(R.id.joinCopy).visibility == View.VISIBLE && a.findViewById<View>(R.id.joinShare).visibility == View.VISIBLE
                copied = a.copyForTest()
            }
            assertTrue("a code is shown", !code.isNullOrEmpty())
            assertTrue("Copy and Share shown with the code", buttons)
            assertTrue("clipboard = the code", copied == code)
        }
    }

    /** The address field: a pasted pairing link, a page or a bare host give the address; run-together text none. */
    @Test
    fun addressFromWhatWasPasted() {
        assertTrue(JoinAddress.normalize("https://example.com/#pair=ddn-pair1:abc") == "https://example.com")
        assertTrue(JoinAddress.normalize("example.com/devices") == "https://example.com")
        assertTrue(JoinAddress.normalize(" https://example.com:8443/ ") == "https://example.com:8443")
        assertTrue(JoinAddress.normalize("http://localhost:3020") == "http://localhost:3020")
        assertTrue(JoinAddress.normalize("https://example.comGoogle Pixel 7") == null)
        assertTrue(JoinAddress.normalize("") == null)
        // Used last: offered again on the next visit.
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        JoinAddress.remember(ctx, "https://example.org")
        ActivityScenario.launch<JoinActivity>(Intent(ctx, JoinActivity::class.java)).use { s ->
            var shown = ""
            s.onActivity { a -> shown = a.findViewById<android.widget.EditText>(R.id.joinServer).text.toString() }
            assertTrue("last address offered: $shown", shown == "https://example.org")
        }
    }
}
