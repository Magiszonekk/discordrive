package com.discordrive.gallery

import android.content.Intent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import kotlin.concurrent.thread

/**
 * Base activity for offline-tolerant, login-optional screens.
 *
 * The gallery runs without a session — local media/previews work fully offline
 * and the app never forces a login screen on launch. Only actions that actually
 * need the server call [requireSession]:
 *  - if a live session exists, the action runs immediately;
 *  - otherwise a silent restore (Keystore refresh token → fresh JWT) is tried in
 *    the background;
 *  - only if that fails (expired/revoked session, or the password is genuinely
 *    needed) is the login screen shown, after which the pending action resumes.
 *
 * [tryRestoreQuietly] is the no-UI periodic auto-login used on launch/resume.
 */
abstract class SessionActivity : AppCompatActivity() {

    private var pendingAction: (() -> Unit)? = null

    private val loginLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val action = pendingAction
            pendingAction = null
            if (result.resultCode == RESULT_OK && SessionManager.isLoggedIn) action?.invoke()
        }

    protected fun requireSession(onReady: () -> Unit) {
        if (SessionManager.isLoggedIn) {
            onReady()
            return
        }
        thread {
            val restored = SessionManager.restore(this)
            runOnUiThread {
                if (restored) {
                    onReady()
                } else {
                    pendingAction = onReady
                    loginLauncher.launch(Intent(this, LoginActivity::class.java))
                }
            }
        }
    }

    /** Background best-effort auto-login; no UI, safe to call repeatedly. */
    protected fun tryRestoreQuietly() {
        if (SessionManager.isLoggedIn) return
        thread { runCatching { SessionManager.restore(this) } }
    }
}
