package com.discordrive.gallery.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * OpenAI-format speech-to-text client (`POST {baseUrl}/v1/audio/transcriptions`,
 * multipart file+model → {"text":…}). Works with OpenAI Whisper, Groq, or a
 * self-hosted faster-whisper server — the user configures URL + key + model.
 * Used to add an audio transcript as extra context to video AI analysis.
 */
class TranscriptionClient(
    private val baseUrl: String,
    private val apiKey: String,
    private val model: String,
    http: OkHttpClient? = null,
) {
    private val http: OkHttpClient = http ?: OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(300, TimeUnit.SECONDS)
        .build()
    private val json = Json { ignoreUnknownKeys = true }

    fun transcribe(audio: File, mimeType: String = "audio/mp4"): String {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", audio.name, audio.asRequestBody(mimeType.toMediaTypeOrNull()))
            .addFormDataPart("model", model.ifBlank { "whisper-1" })
            .addFormDataPart("response_format", "json")
            .build()
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/v1/audio/transcriptions")
            .post(body)
            .header("Authorization", "Bearer $apiKey")
            .build()

        http.newCall(request).execute().use { response ->
            val text = response.body?.string() ?: throw GraphQLException("Empty transcription response")
            if (!response.isSuccessful) throw GraphQLException("Transcription HTTP ${response.code}: ${text.take(200)}")
            return json.parseToJsonElement(text).jsonObject["text"]?.jsonPrimitive?.content?.trim().orEmpty()
        }
    }
}
