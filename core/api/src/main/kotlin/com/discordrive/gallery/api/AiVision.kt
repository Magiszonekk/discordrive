package com.discordrive.gallery.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * OpenAI-format vision client for media enrichment. Works with any
 * /v1/chat/completions endpoint (self-hosted Ollama/vLLM, OpenRouter-style
 * gateways, …) — the user explicitly opts in by configuring URL + key.
 *
 * Privacy note: this sends (downscaled) image bytes to the configured
 * endpoint. That is a deliberate, per-user trust decision — the resulting
 * tags/description are stored E2EE like everything else.
 */
class AiVisionClient(
    private val baseUrl: String,
    private val apiKey: String,
    private val model: String,
    http: OkHttpClient? = null,
) {
    private val http: OkHttpClient = http ?: OkHttpClient.Builder()
        .readTimeout(120, TimeUnit.SECONDS)
        .build()
    private val json = Json { ignoreUnknownKeys = true }
    private val mediaType = "application/json".toMediaType()

    @Serializable
    data class VisionResult(val description: String, val tags: List<String>)

    private val prompt =
        "Przeanalizuj obraz. Odpowiedz TYLKO czystym JSON bez markdown, w formacie: " +
            """{"description":"jedno-dwa zdania po polsku co przedstawia obraz","tags":["6-10 tagów po polsku, krótkie, małymi literami"]}""" +
            " Jeśli na obrazie jest tekst, uwzględnij go w opisie i tagach."

    fun analyzeImage(imageBytes: ByteArray, mimeType: String): VisionResult {
        val dataUrl = "data:$mimeType;base64,${Base64.getEncoder().encodeToString(imageBytes)}"

        val body = buildJsonObject {
            put("model", model)
            put("max_tokens", 400)
            put(
                "messages",
                buildJsonArray {
                    add(
                        buildJsonObject {
                            put("role", "user")
                            put(
                                "content",
                                buildJsonArray {
                                    add(buildJsonObject { put("type", "text"); put("text", prompt) })
                                    add(
                                        buildJsonObject {
                                            put("type", "image_url")
                                            put("image_url", buildJsonObject { put("url", dataUrl) })
                                        },
                                    )
                                },
                            )
                        },
                    )
                },
            )
        }

        val request = Request.Builder()
            .url("$baseUrl/v1/chat/completions")
            .post(json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), body).toRequestBody(mediaType))
            .header("Authorization", "Bearer $apiKey")
            .build()

        http.newCall(request).execute().use { response ->
            val text = response.body?.string() ?: throw GraphQLException("Empty AI response")
            if (!response.isSuccessful) throw GraphQLException("AI endpoint HTTP ${response.code}: ${text.take(300)}")

            val content = json.parseToJsonElement(text).jsonObject
                .getValue("choices").jsonArray[0].jsonObject
                .getValue("message").jsonObject
                .getValue("content").jsonPrimitive.content

            return parseVisionJson(content)
        }
    }

    /** Tolerates markdown fences and stray prose around the JSON object. */
    internal fun parseVisionJson(content: String): VisionResult {
        val start = content.indexOf('{')
        val end = content.lastIndexOf('}')
        require(start >= 0 && end > start) { "AI response contains no JSON object: ${content.take(200)}" }
        val obj = json.parseToJsonElement(content.substring(start, end + 1)).jsonObject
        return VisionResult(
            description = obj["description"]?.jsonPrimitive?.content ?: "",
            tags = obj["tags"]?.jsonArray?.mapNotNull { (it as? JsonPrimitive)?.content?.lowercase() } ?: emptyList(),
        )
    }
}
