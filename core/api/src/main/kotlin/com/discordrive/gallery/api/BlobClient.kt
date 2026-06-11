package com.discordrive.gallery.api

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.time.Instant

class BlobUploadException(message: String, val statusCode: Int) : Exception(message)

/**
 * Raw ciphertext transport: PUT/GET /api/blob/{blobId}.
 * All payloads are encrypted client-side before they reach this layer.
 */
class BlobClient(
    private val baseUrl: String,
    private val http: OkHttpClient = OkHttpClient(),
    private val tokenProvider: () -> String?,
) {
    private val octetStream = "application/octet-stream".toMediaType()

    fun upload(
        blobId: String,
        ciphertext: ByteArray,
        uploadId: String,
        chunkIndex: Int,
        chunkCount: Int,
    ): String {
        val request = Request.Builder()
            .url("$baseUrl/api/blob/$blobId")
            .put(ciphertext.toRequestBody(octetStream))
            .header("Authorization", "Bearer ${requireToken()}")
            .header("X-Upload-Id", uploadId)
            .header("X-Chunk-Index", chunkIndex.toString())
            .header("X-Chunk-Count", chunkCount.toString())
            .header("X-Client-Timestamp", Instant.now().toString())
            .build()

        http.newCall(request).execute().use { response ->
            val body = response.body?.string() ?: ""
            if (!response.isSuccessful) {
                throw BlobUploadException("Blob upload failed (HTTP ${response.code}): $body", response.code)
            }
            return body
        }
    }

    fun download(blobId: String): ByteArray {
        val request = Request.Builder()
            .url("$baseUrl/api/blob/$blobId")
            .header("Authorization", "Bearer ${requireToken()}")
            .build()

        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw BlobUploadException("Blob download failed (HTTP ${response.code})", response.code)
            }
            return response.body?.bytes() ?: throw BlobUploadException("Empty blob body", response.code)
        }
    }

    /** True when the blob's transport record exists (HEAD-like check via metadata). */
    fun exists(blobId: String): Boolean {
        val request = Request.Builder()
            .url("$baseUrl/api/blob/$blobId/meta")
            .header("Authorization", "Bearer ${requireToken()}")
            .build()
        http.newCall(request).execute().use { response -> return response.isSuccessful }
    }

    /** Like [download] but returns null on 404 instead of throwing. */
    fun downloadOrNull(blobId: String): ByteArray? {
        val request = Request.Builder()
            .url("$baseUrl/api/blob/$blobId")
            .header("Authorization", "Bearer ${requireToken()}")
            .build()
        http.newCall(request).execute().use { response ->
            if (response.code == 404) return null
            if (!response.isSuccessful) {
                throw BlobUploadException("Blob download failed (HTTP ${response.code})", response.code)
            }
            return response.body?.bytes()
        }
    }

    private fun requireToken(): String =
        tokenProvider() ?: throw IllegalStateException("Not authenticated — login first")
}
