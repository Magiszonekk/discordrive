package io.github.magiszonekk.discordrive.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ErrorTextTest {
    // What an app that replays rules 2..3 showed on an account with a rules 4 entry (V8 sandbox, with source).
    private val raw = "V8 sandbox: Uncaught UnsupportedRulesVersionError: log entry 539 uses rules version 4; this build supports 2..3. Update the client.\n" +
        "    at x (<anonymous>:1:2345)\n    var SyncCore=(()=>{var L=Object.defineProperty;"

    @Test fun newerRulesMeanUpdate() {
        assertTrue(ErrorText.needsUpdate(raw))
        assertTrue(ErrorText.needsUpdate("QuickJS: log entry 9 uses rules version 5; this build supports 2..4. Update the client."))
        assertTrue(ErrorText.needsUpdate("snapshot needs rules version 5; this build has 4"))
        assertFalse(ErrorText.needsUpdate("Unable to resolve host \"example.com\""))
        assertFalse(ErrorText.needsUpdate(null))
    }

    @Test fun cleanDropsEngineWrappingAndSource() {
        assertEquals("log entry 539 uses rules version 4; this build supports 2..3. Update the client.", ErrorText.clean(raw))
        assertEquals("boom", ErrorText.clean("QuickJS: Uncaught Error: boom\nat line 3"))
        assertEquals("HTTP 500", ErrorText.clean("HTTP 500"))
        assertEquals(300, ErrorText.clean("x".repeat(1000)).length)
    }
}
