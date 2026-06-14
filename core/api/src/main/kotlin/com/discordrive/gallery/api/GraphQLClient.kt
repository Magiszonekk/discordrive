package com.discordrive.gallery.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class GraphQLException(message: String) : Exception(message)

/**
 * Minimal GraphQL-over-HTTP client for the DiscorDrive API.
 * Raw query strings + JsonObject variables keep this dependency-light; typed
 * wrappers live in [DiscorDriveClient].
 */
class GraphQLClient(
    private val baseUrl: String,
    private val http: OkHttpClient = OkHttpClient(),
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val mediaType = "application/json".toMediaType()

    /** Bearer token applied to subsequent requests (JWT or device-session JWT). */
    @Volatile
    var authToken: String? = null

    /**
     * Called when a request fails authentication (expired 1h JWT). Should refresh
     * [authToken] via the stored refresh token and return true to retry once —
     * without it the session silently dies ~1h after the process starts.
     */
    @Volatile
    var onAuthError: (() -> Boolean)? = null

    fun execute(query: String, variables: JsonObject? = null): JsonObject = execute(query, variables, retry = true)

    private fun execute(query: String, variables: JsonObject?, retry: Boolean): JsonObject {
        val body = buildJsonObject {
            put("query", kotlinx.serialization.json.JsonPrimitive(query))
            if (variables != null) put("variables", variables)
        }

        val request = Request.Builder()
            .url("$baseUrl/graphql")
            .post(json.encodeToString(JsonObject.serializer(), body).toRequestBody(mediaType))
            .apply { authToken?.let { header("Authorization", "Bearer $it") } }
            .build()

        http.newCall(request).execute().use { response ->
            val text = response.body?.string() ?: throw GraphQLException("Empty response (HTTP ${response.code})")
            val parsed = json.parseToJsonElement(text).jsonObject

            parsed["errors"]?.let { errors ->
                val messages = errors.jsonArray.joinToString("; ") { err ->
                    err.jsonObject["message"]?.jsonPrimitive?.content ?: err.toString()
                }
                // Expired token → refresh once and retry transparently.
                if (retry && isAuthError(messages) && onAuthError?.invoke() == true) {
                    return execute(query, variables, retry = false)
                }
                throw GraphQLException(messages)
            }

            return parsed["data"]?.jsonObject
                ?: throw GraphQLException("Response has no data (HTTP ${response.code})")
        }
    }

    private fun isAuthError(message: String): Boolean =
        message.contains("authentication", ignoreCase = true) ||
            message.contains("unauthor", ignoreCase = true) ||
            message.contains("token", ignoreCase = true)

    fun field(data: JsonObject, name: String): JsonElement =
        data[name] ?: throw GraphQLException("Missing field '$name' in response")
}
