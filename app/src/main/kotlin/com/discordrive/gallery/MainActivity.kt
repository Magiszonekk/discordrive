package com.discordrive.gallery

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.discordrive.gallery.api.DiscorDriveClient
import kotlin.concurrent.thread

/**
 * v1 shell: login → manual "scan & sync". Programmatic UI keeps the skeleton
 * dependency-free; a real gallery UI lands in Phase 4.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var serverInput: EditText
    private lateinit var userInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var loginButton: Button
    private lateinit var syncButton: Button
    private lateinit var statusView: TextView

    private var client: DiscorDriveClient? = null
    private var filesKey: ByteArray? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
        }

        serverInput = EditText(this).apply {
            hint = "Server URL (http://10.0.2.2:3001)"
            setText("http://10.0.2.2:3001")
        }
        userInput = EditText(this).apply { hint = "Email / username" }
        passwordInput = EditText(this).apply {
            hint = "Password"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        loginButton = Button(this).apply {
            text = "Zaloguj"
            setOnClickListener { doLogin() }
        }
        syncButton = Button(this).apply {
            text = "Skanuj i synchronizuj"
            visibility = View.GONE
            setOnClickListener { doSync() }
        }
        statusView = TextView(this).apply { text = "DiscorDrive Gallery — niezalogowano" }

        root.addView(serverInput)
        root.addView(userInput)
        root.addView(passwordInput)
        root.addView(loginButton)
        root.addView(syncButton)
        root.addView(statusView)
        setContentView(ScrollView(this).apply { addView(root) })

        ensureMediaPermission()
    }

    private fun ensureMediaPermission() {
        val permissions = if (Build.VERSION.SDK_INT >= 33) {
            arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        val missing = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1)
        }
    }

    private fun setStatus(text: String) = runOnUiThread { statusView.text = text }

    private fun doLogin() {
        val server = serverInput.text.toString().trim().trimEnd('/')
        val user = userInput.text.toString().trim()
        val password = passwordInput.text.toString()
        setStatus("Logowanie (Argon2)…")
        loginButton.isEnabled = false

        thread {
            try {
                val newClient = DiscorDriveClient(server)
                val session = newClient.login(user, password, deviceName = "Android Emulator")
                client = newClient
                filesKey = session.filesKey
                setStatus("Zalogowano: ${session.user.email}\nSesja urządzenia: ${session.refreshToken != null}")
                runOnUiThread {
                    syncButton.visibility = View.VISIBLE
                    loginButton.isEnabled = true
                }
            } catch (e: Exception) {
                setStatus("Błąd logowania: ${e.message}")
                runOnUiThread { loginButton.isEnabled = true }
            }
        }
    }

    private fun doSync() {
        val activeClient = client ?: return
        val key = filesKey ?: return
        syncButton.isEnabled = false

        thread {
            try {
                val sync = GallerySync(activeClient, MediaScanner(this), key)
                val result = sync.syncAll { p ->
                    setStatus("Sync ${p.done}/${p.total}: ${p.current}\n↑ ${p.uploaded} nowych, ${p.deduplicated} dedup, ${p.failed} błędów")
                }
                setStatus(
                    "Sync zakończony — ${result.total} plików\n" +
                        "↑ ${result.uploaded} wgranych, ${result.deduplicated} zdedupliko­wanych, ${result.failed} błędów",
                )
            } catch (e: Exception) {
                setStatus("Błąd synca: ${e.message}")
            } finally {
                runOnUiThread { syncButton.isEnabled = true }
            }
        }
    }
}
