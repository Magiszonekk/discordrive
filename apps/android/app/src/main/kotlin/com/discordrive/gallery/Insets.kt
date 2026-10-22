package com.discordrive.gallery

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** Edge-to-edge helper: pad the root view by system bars + keyboard. */
object Insets {
    fun apply(root: View, top: Boolean = true, bottom: Boolean = true) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, if (top) bars.top else 0, bars.right, if (bottom) bars.bottom else 0)
            insets
        }
    }
}
