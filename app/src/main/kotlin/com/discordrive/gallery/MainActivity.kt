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
import com.discordrive.gallery.api.AiVisionClient
import com.discordrive.gallery.api.DiscorDriveClient
import com.discordrive.gallery.api.EnrichmentEngine
import com.discordrive.gallery.api.EnrichmentRecord
import com.discordrive.gallery.crypto.DdvCrypto
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
    private lateinit var aiUrlInput: EditText
    private lateinit var aiKeyInput: EditText
    private lateinit var aiModelInput: EditText
    private lateinit var aiScanButton: Button
    private lateinit var searchInput: EditText
    private lateinit var searchButton: Button
    private lateinit var statusView: TextView

    private var client: DiscorDriveClient? = null
    private var filesKey: ByteArray? = null
    private val enrichmentCache = mutableMapOf<String, EnrichmentRecord?>()

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
        aiUrlInput = EditText(this).apply {
            hint = "AI endpoint URL"
            setText("http://10.0.2.2:8317")
            visibility = View.GONE
        }
        aiKeyInput = EditText(this).apply {
            hint = "AI API key"
            visibility = View.GONE
        }
        aiModelInput = EditText(this).apply {
            hint = "Model"
            setText("nex-agi/nex-n2-pro:free")
            visibility = View.GONE
        }
        aiScanButton = Button(this).apply {
            text = "Analiza AI (tagi + opisy)"
            visibility = View.GONE
            setOnClickListener { doAiScan() }
        }
        searchInput = EditText(this).apply {
            hint = "Szukaj w tagach i opisach…"
            visibility = View.GONE
        }
        searchButton = Button(this).apply {
            text = "Szukaj"
            visibility = View.GONE
            setOnClickListener { doSearch() }
        }
        statusView = TextView(this).apply { text = "DiscorDrive Gallery — niezalogowano" }

        root.addView(serverInput)
        root.addView(userInput)
        root.addView(passwordInput)
        root.addView(loginButton)
        root.addView(syncButton)
        root.addView(aiUrlInput)
        root.addView(aiKeyInput)
        root.addView(aiModelInput)
        root.addView(aiScanButton)
        root.addView(searchInput)
        root.addView(searchButton)
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
                    for (v in listOf(syncButton, aiUrlInput, aiKeyInput, aiModelInput, aiScanButton, searchInput, searchButton)) {
                        v.visibility = View.VISIBLE
                    }
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

    /**
     * Tags every synced-but-unanalyzed asset: local bytes → dedupe token →
     * remote fileId → downscaled image → AI → encrypted enrichment blob.
     * Local originals never leave the device at full resolution.
     */
    private fun doAiScan() {
        val activeClient = client ?: return
        val key = filesKey ?: return
        val ai = AiVisionClient(
            baseUrl = aiUrlInput.text.toString().trim().trimEnd('/'),
            apiKey = aiKeyInput.text.toString().trim(),
            model = aiModelInput.text.toString().trim(),
        )
        val engine = EnrichmentEngine(activeClient)
        aiScanButton.isEnabled = false

        thread {
            try {
                val scanner = MediaScanner(this)
                val assets = scanner.scanAll()
                var analyzed = 0
                var skipped = 0
                var failed = 0

                assets.forEachIndexed { index, asset ->
                    setStatus("AI ${index + 1}/${assets.size}: ${asset.displayName}\n$analyzed przeanalizowanych, $skipped pominiętych, $failed błędów")
                    try {
                        val content = scanner.readBytes(asset)
                        val token = DdvCrypto.b64encode(DdvCrypto.deriveDedupeToken(key, content))
                        val file = activeClient.fileByDedupeToken(token)
                        if (file == null || engine.hasEnrichment(file.id)) {
                            skipped++
                            return@forEachIndexed
                        }
                        val vision = ai.analyzeImage(AiImagePreparer.prepare(this, asset), "image/jpeg")
                        val record = engine.buildRecord(vision, aiModelInput.text.toString().trim())
                        engine.saveEnrichment(file.id, file.wrappedFEK, key, record)
                        enrichmentCache[file.id] = record
                        analyzed++
                    } catch (e: Exception) {
                        failed++
                        android.util.Log.w("AiScan", "Failed for ${asset.displayName}", e)
                    }
                }
                setStatus("Analiza AI zakończona — ${assets.size} plików\n$analyzed przeanalizowanych, $skipped pominiętych, $failed błędów")
            } catch (e: Exception) {
                setStatus("Błąd analizy AI: ${e.message}")
            } finally {
                runOnUiThread { aiScanButton.isEnabled = true }
            }
        }
    }

    /** Client-side search over decrypted enrichments (server sees nothing). */
    private fun doSearch() {
        val activeClient = client ?: return
        val key = filesKey ?: return
        val query = searchInput.text.toString()
        if (query.isBlank()) return
        val engine = EnrichmentEngine(activeClient)
        searchButton.isEnabled = false

        thread {
            try {
                setStatus("Szukam „$query”…")
                val files = activeClient.galleryDelta(null).files
                    .filter { it.status == "READY" && it.deletedAt == null }

                val results = StringBuilder()
                var hits = 0
                for (file in files) {
                    val record = enrichmentCache.getOrPut(file.id) { engine.loadEnrichment(file, key) } ?: continue
                    if (engine.matches(record, query)) {
                        hits++
                        val name = runCatching {
                            val rootFek = DdvCrypto.unwrapRootFek(file.wrappedFEK, key)
                            file.encryptedName?.let { DdvCrypto.decryptMeta(rootFek, it) }
                        }.getOrNull() ?: file.id
                        results.append("• $name\n  ${record.description}\n  [${record.tags.joinToString(", ")}]\n\n")
                    }
                }
                setStatus(if (hits == 0) "Brak wyników dla „$query”" else "Wyniki dla „$query” ($hits):\n\n$results")
            } catch (e: Exception) {
                setStatus("Błąd wyszukiwania: ${e.message}")
            } finally {
                runOnUiThread { searchButton.isEnabled = true }
            }
        }
    }
}
