package com.discordrive.gallery.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
class AiRateLimitException(val retryAfterSeconds: Long) :
    Exception("AI rate limit hit, retry after ${retryAfterSeconds}s")

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

    private fun albumPrefix(albumHint: String?): String =
        if (!albumHint.isNullOrBlank()) "Kontekst albumu (podpowiedź użytkownika): ${albumHint.trim()}\n" else ""

    /**
     * @param albumHint optional user-provided context for the album this image
     *   belongs to (e.g. "zapisane z Pinteresta, najczęściej memy") — prepended
     *   to the prompt so tags/description reflect it.
     */
    fun analyzeImage(imageBytes: ByteArray, mimeType: String, albumHint: String? = null): VisionResult =
        postAndParse(buildBody(albumPrefix(albumHint) + prompt, listOf(dataUrl(imageBytes, mimeType))))

    /**
     * Analyzes a video from several sampled frames (chronological). To stay
     * within model limits, frames are sent in batches of [framesPerRequest];
     * when there is more than one batch each subsequent request carries the
     * running description forward as context, and the final batch synthesizes
     * the whole clip. [interBatchDelayMs] spaces requests for rate-limited
     * gateways (set by the caller). Tags are merged + de-duplicated.
     */
    fun analyzeVideo(
        frames: List<ByteArray>,
        albumHint: String? = null,
        framesPerRequest: Int = FRAMES_PER_REQUEST,
        interBatchDelayMs: Long = 0L,
    ): VisionResult {
        if (frames.isEmpty()) throw GraphQLException("No video frames to analyze")
        val batches = frames.chunked(framesPerRequest.coerceAtLeast(1))
        val tags = LinkedHashSet<String>()
        var carried: String? = null
        var description = ""
        batches.forEachIndexed { index, batch ->
            if (index > 0 && interBatchDelayMs > 0) Thread.sleep(interBatchDelayMs)
            val result = postAndParse(buildBody(videoPrompt(index, batches.size, albumHint, carried), batch.map { dataUrl(it) }))
            if (result.description.isNotBlank()) description = result.description
            carried = description
            tags.addAll(result.tags)
        }
        return VisionResult(description, tags.toList())
    }

    private fun videoPrompt(partIndex: Int, partCount: Int, albumHint: String?, carried: String?): String = buildString {
        append(albumPrefix(albumHint))
        append("To są klatki z jednego filmu w kolejności chronologicznej")
        if (partCount > 1) append(" (część ${partIndex + 1} z $partCount)")
        append(". ")
        if (!carried.isNullOrBlank()) append("Dotychczasowy opis filmu: ${carried.trim()}\n")
        append("Opisz CAŁY film na podstawie tych oraz wcześniejszych klatek. ")
        append("Odpowiedz TYLKO czystym JSON bez markdown, w formacie: ")
        append("""{"description":"jedno-dwa zdania po polsku co dzieje się na filmie","tags":["6-10 tagów po polsku, krótkie, małymi literami"]}""")
        append(" Jeśli na klatkach jest tekst, uwzględnij go w opisie i tagach.")
    }

    private fun dataUrl(bytes: ByteArray, mime: String = "image/jpeg"): String =
        "data:$mime;base64,${Base64.getEncoder().encodeToString(bytes)}"

    private fun buildBody(promptText: String, imageDataUrls: List<String>): JsonObject = buildJsonObject {
        put("model", model)
        put("max_tokens", 1024)
        put(
            "messages",
            buildJsonArray {
                add(
                    buildJsonObject {
                        put("role", "user")
                        put(
                            "content",
                            buildJsonArray {
                                add(buildJsonObject { put("type", "text"); put("text", promptText) })
                                imageDataUrls.forEach { url ->
                                    add(
                                        buildJsonObject {
                                            put("type", "image_url")
                                            put("image_url", buildJsonObject { put("url", url) })
                                        },
                                    )
                                }
                            },
                        )
                    },
                )
            },
        )
    }

    private fun postAndParse(body: JsonObject): VisionResult {
        val request = Request.Builder()
            .url("$baseUrl/v1/chat/completions")
            .post(json.encodeToString(JsonObject.serializer(), body).toRequestBody(mediaType))
            .header("Authorization", "Bearer $apiKey")
            .build()

        http.newCall(request).execute().use { response ->
            val text = response.body?.string() ?: throw GraphQLException("Empty AI response")
            if (response.code == 429) {
                val retryAfter = response.header("Retry-After")?.toLongOrNull() ?: 30L
                throw AiRateLimitException(retryAfter)
            }
            if (!response.isSuccessful) throw GraphQLException("AI endpoint HTTP ${response.code}: ${text.take(300)}")

            val content = json.parseToJsonElement(text).jsonObject
                .getValue("choices").jsonArray[0].jsonObject
                .getValue("message").jsonObject
                .getValue("content").jsonPrimitive.content

            return parseVisionJson(content)
        }
    }

    companion object {
        const val FRAMES_PER_REQUEST = 4
    }

    /**
     * Tolerates markdown fences/prose AND truncated responses: a verbose model
     * can hit max_tokens mid-JSON (no closing brace), so we fall back to pulling
     * the description + any complete tags out of the partial text instead of
     * failing the whole analysis.
     */
    internal fun parseVisionJson(content: String): VisionResult {
        // 1) happy path — a complete {...} object
        val start = content.indexOf('{')
        if (start >= 0) {
            val end = content.lastIndexOf('}')
            if (end > start) {
                runCatching {
                    val obj = json.parseToJsonElement(content.substring(start, end + 1)).jsonObject
                    return VisionResult(
                        description = obj["description"]?.jsonPrimitive?.content ?: "",
                        tags = obj["tags"]?.jsonArray?.mapNotNull { (it as? JsonPrimitive)?.content?.lowercase() } ?: emptyList(),
                    )
                }
            }
        }

        // 2) salvage a truncated / malformed response
        val description = Regex("\"description\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)")
            .find(content)?.groupValues?.get(1)
            ?.replace("\\\"", "\"")?.replace("\\n", " ")?.trim()
            .orEmpty()
        val tagsBlock = content.substringAfter("\"tags\"", "").substringAfter('[', "").substringBefore(']')
        val tags = Regex("\"((?:[^\"\\\\]|\\\\.)+)\"").findAll(tagsBlock)
            .map { it.groupValues[1].lowercase() }.toList()

        require(description.isNotBlank() || tags.isNotEmpty()) {
            "AI response contains no JSON object: ${content.take(200)}"
        }
        return VisionResult(description, tags)
    }
}
