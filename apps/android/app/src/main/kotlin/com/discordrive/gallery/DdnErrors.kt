package com.discordrive.gallery

import android.content.Context
import io.github.magiszonekk.discordrive.core.ErrorText

/** "Błąd: …" for a failure, readable: an account written by a newer app asks for an update, no JS source. */
object DdnErrors {
    fun text(c: Context, e: Throwable?): String = text(c, e?.message)

    fun text(c: Context, message: String?): String =
        if (ErrorText.needsUpdate(message)) c.getString(R.string.ddn_err_update) else c.getString(R.string.ddn_error, ErrorText.clean(message))

    /** Without the "Błąd:" prefix (a line that has its own, like "bez połączenia: …"). */
    fun bare(c: Context, message: String?): String =
        if (ErrorText.needsUpdate(message)) c.getString(R.string.ddn_err_update) else ErrorText.clean(message)
}
