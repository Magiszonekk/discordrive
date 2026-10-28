package io.github.magiszonekk.discordrive.core

/**
 * What a raw error message means for the person using the app. Errors from the sync core arrive through the
 * JS engine as "V8 sandbox: Uncaught UnsupportedRulesVersionError: … Update the client." followed by lines of
 * JS source; the screen must never show that.
 */
object ErrorText {
    /** The account's log or snapshot was written by a newer app: this one must be updated to read it. */
    fun needsUpdate(message: String?): Boolean {
        val m = message ?: return false
        return "UnsupportedRulesVersionError" in m ||
            Regex("uses rules version \\d+; this build supports").containsMatchIn(m) ||
            Regex("snapshot needs rules version \\d+").containsMatchIn(m)
    }

    /**
     * The message without the engine's wrapping: no "V8 sandbox: " / "Uncaught Error: " prefix, only the first
     * line (the rest is the script's source and stack), at most 300 characters.
     */
    fun clean(message: String?): String {
        var m = (message ?: "").trim()
        m = m.lineSequence().firstOrNull { it.isNotBlank() }?.trim() ?: ""
        m = m.replace(Regex("^(V8 sandbox|QuickJS)(: )?"), "").trim()
        m = m.replace(Regex("^Uncaught\\s+"), "").replace(Regex("^[A-Za-z]*Error:\\s*"), "").trim()
        return if (m.length > 300) m.take(299) + "…" else m
    }
}
