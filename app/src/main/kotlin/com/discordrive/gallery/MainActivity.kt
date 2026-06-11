package com.discordrive.gallery

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Placeholder entry point. Roadmap (see README):
 *   Phase 3 — sync engine (MediaStore scan, WorkManager, bucket→folder mirror)
 *   Phase 4 — gallery UI (local thumbs, cloud previews, ExoPlayer streaming)
 *   Phase 5 — AI tagging (ML Kit OCR, Gemini Nano / OpenAI-format endpoint)
 */
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply {
            text = "DiscorDrive Gallery — skeleton"
            textAlignment = TextView.TEXT_ALIGNMENT_CENTER
        })
    }
}
