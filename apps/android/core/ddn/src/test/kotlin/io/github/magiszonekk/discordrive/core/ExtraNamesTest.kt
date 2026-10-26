package io.github.magiszonekk.discordrive.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** Discord drops leading underscores from attachment names; extras are found by a name compared without them. */
class ExtraNamesTest {
    @Test
    fun extraKeyDropsExtensionAndLeadingUnderscores() {
        assertEquals("r90gl-TjaHmjTHFQPSTE3", FileFormat.extraKey("_r90gl-TjaHmjTHFQPSTE3.txt"))
        assertEquals("r90gl-TjaHmjTHFQPSTE3", FileFormat.extraKey("r90gl-TjaHmjTHFQPSTE3.txt"))
        assertEquals("ab", FileFormat.extraKey("__ab"))
        assertEquals("a_b", FileFormat.extraKey("a_b.txt"))
    }

    @Test
    fun previewNameWithUnderscoreFoundUnderDiscordsName() {
        // A file key whose preview name starts with "_" (about one in 32).
        val rnd = java.security.SecureRandom()
        var keys: FileFormat.PreviewKeys
        do {
            val k = ByteArray(32).also { rnd.nextBytes(it) }
            keys = FileFormat.PreviewKeys(k)
        } while (!keys.name('p').startsWith("_"))
        val sent = keys.name('p') + ".txt"
        val back = sent.trimStart('_')
        assertEquals(FileFormat.extraKey(keys.name('p')), FileFormat.extraKey(back))
    }
}
