package com.discordrive.gallery

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * File logger for field diagnostics. Everything also goes to logcat, but the
 * file survives process death — the crash handler in [App] writes the fatal
 * stacktrace here before the system kills us, and Settings can copy the file
 * to the clipboard or push it (E2EE) to the server.
 *
 * Single rotation app.log → app.log.1, ~384 KB each (well under the 4 MiB
 * gallery-state value cap when sending).
 */
object AppLog {

    private const val MAX_BYTES = 384L * 1024
    private val timeFormat = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)

    private var logFile: File? = null
    private var rotatedFile: File? = null

    fun init(context: Context) {
        logFile = File(context.filesDir, "app.log")
        rotatedFile = File(context.filesDir, "app.log.1")
    }

    fun i(tag: String, message: String) = write("I", tag, message, null)
    fun w(tag: String, message: String, error: Throwable? = null) = write("W", tag, message, error)
    fun e(tag: String, message: String, error: Throwable? = null) = write("E", tag, message, error)

    @Synchronized
    private fun write(level: String, tag: String, message: String, error: Throwable?) {
        android.util.Log.println(
            when (level) { "E" -> android.util.Log.ERROR; "W" -> android.util.Log.WARN; else -> android.util.Log.INFO },
            tag,
            message + (error?.let { "\n" + stackTraceOf(it) } ?: ""),
        )
        val file = logFile ?: return
        runCatching {
            if (file.length() > MAX_BYTES) {
                rotatedFile?.let { file.renameTo(it) }
            }
            val line = buildString {
                append(timeFormat.format(Date())).append(' ').append(level).append('/').append(tag)
                append(": ").append(message).append('\n')
                error?.let { append(stackTraceOf(it)).append('\n') }
            }
            file.appendText(line)
        }
    }

    /** Full log contents (rotated part first), "" when nothing was logged yet. */
    @Synchronized
    fun readAll(): String = buildString {
        rotatedFile?.takeIf { it.exists() }?.let { append(it.readText()) }
        logFile?.takeIf { it.exists() }?.let { append(it.readText()) }
    }

    @Synchronized
    fun sizeBytes(): Long = (logFile?.length() ?: 0) + (rotatedFile?.length() ?: 0)

    /** Wipes the log files so the next "send logs" only carries fresh entries. */
    @Synchronized
    fun clear() {
        runCatching { logFile?.delete() }
        runCatching { rotatedFile?.delete() }
    }

    private fun stackTraceOf(error: Throwable): String =
        StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString().trimEnd()
}
