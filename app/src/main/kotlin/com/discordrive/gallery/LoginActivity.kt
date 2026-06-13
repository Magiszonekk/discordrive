package com.discordrive.gallery

import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.progressindicator.LinearProgressIndicator
import kotlin.concurrent.thread

/**
 * On-demand login: shown only when a cloud action needs a session that couldn't
 * be silently restored. Returns RESULT_OK so the caller can resume its action.
 */
class LoginActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)
        Insets.apply(findViewById(R.id.loginRoot))

        val serverInput = findViewById<EditText>(R.id.serverInput)
        val emailInput = findViewById<EditText>(R.id.emailInput)
        val passwordInput = findViewById<EditText>(R.id.passwordInput)
        val loginButton = findViewById<Button>(R.id.loginButton)
        val progress = findViewById<LinearProgressIndicator>(R.id.loginProgress)
        val status = findViewById<TextView>(R.id.loginStatus)

        // Prefill the last-used server/email to speed up re-login.
        val prefs = getSharedPreferences("session", MODE_PRIVATE)
        (SessionManager.serverUrl ?: prefs.getString("serverUrl", null))?.let { serverInput.setText(it) }
        (SessionManager.email ?: prefs.getString("email", null))?.let { emailInput.setText(it) }

        // Try silent session restore first (e.g. session existed but client was cleared).
        progress.visibility = View.VISIBLE
        thread {
            val restored = SessionManager.restore(this)
            runOnUiThread {
                progress.visibility = View.GONE
                if (restored) finishOk()
            }
        }

        loginButton.setOnClickListener {
            val server = serverInput.text.toString().trim().trimEnd('/')
            val email = emailInput.text.toString().trim()
            val password = passwordInput.text.toString()
            if (server.isBlank() || email.isBlank() || password.isBlank()) return@setOnClickListener

            loginButton.isEnabled = false
            progress.visibility = View.VISIBLE
            status.text = getString(R.string.login_progress)

            thread {
                try {
                    SessionManager.login(this, server, email, password)
                    runOnUiThread { finishOk() }
                } catch (e: Exception) {
                    runOnUiThread {
                        status.text = e.message ?: "Błąd logowania"
                        loginButton.isEnabled = true
                        progress.visibility = View.GONE
                    }
                }
            }
        }
    }

    private fun finishOk() {
        setResult(RESULT_OK)
        finish()
    }
}
