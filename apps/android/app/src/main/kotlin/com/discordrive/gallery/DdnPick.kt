package com.discordrive.gallery

import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlin.concurrent.thread

/** Pickers shared by the screens that move files (Files, the viewer). */
object DdnPick {
    /** Move to the Drive: a folder of the Drive, browsed from Files (one level at a time; "Here" picks it). */
    fun driveFolder(a: AppCompatActivity, s: DdnSession, at: Pair<String, String> = "root" to a.getString(R.string.ddn_files), onPick: (String) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        thread {
            val kids = runCatching { s.children(at.first).filter { it.isFolder } }.getOrDefault(emptyList())
            main.post {
                if (a.isFinishing) return@post
                MaterialAlertDialogBuilder(a).setTitle(a.getString(R.string.ddn_move_into, at.second))
                    .setItems(kids.map { it.name }.toTypedArray()) { _, i -> driveFolder(a, s, kids[i].id to kids[i].name, onPick) }
                    .setPositiveButton(R.string.ddn_move_here) { _, _ -> onPick(at.first) }
                    .setNegativeButton(R.string.cobalt_cancel, null).show()
            }
        }
    }
}
