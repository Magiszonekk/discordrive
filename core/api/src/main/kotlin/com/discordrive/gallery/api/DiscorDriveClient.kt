package com.discordrive.gallery.api

import com.discordrive.gallery.crypto.Argon2Params
import com.discordrive.gallery.crypto.DdvCrypto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient

/**
 * Typed client for the DiscorDrive API (core + gallery plugin).
 *
 * Auth model: [login] with a deviceName creates a revocable device session —
 * the refresh token must be persisted securely (Android Keystore-encrypted);
 * the short-lived access JWT is refreshed via [refreshAccessToken].
 */
class DiscorDriveClient(
    baseUrl: String,
    http: OkHttpClient = OkHttpClient(),
) {
    val graphql = GraphQLClient(baseUrl, http)
    val blobs = BlobClient(baseUrl, http) { graphql.authToken }
    private val json = Json { ignoreUnknownKeys = true }

    data class Session(
        val token: String,
        val refreshToken: String?,
        val user: UserDto,
        /** Unwrapped Account Root Key — keep only in memory / Keystore-wrapped. */
        val ark: ByteArray,
        /** Files-domain key. Currently equals ARK (domain keys not yet wired in core). */
        val filesKey: ByteArray,
    )

    fun fetchLoginChallenge(emailOrUsername: String): Argon2Params {
        val data = graphql.execute(
            """
            query Challenge(${'$'}id: String!) {
              getLoginChallenge(emailOrUsername: ${'$'}id) {
                argon2Params { memoryKB iterations parallelism saltB64 }
              }
            }
            """.trimIndent(),
            buildJsonObject { put("id", JsonPrimitive(emailOrUsername)) },
        )
        val challenge = data["getLoginChallenge"]
        if (challenge == null || challenge is JsonNull) throw GraphQLException("Invalid credentials")
        val params = json.decodeFromJsonElement(
            Argon2ParamsDto.serializer(),
            challenge.jsonObject.getValue("argon2Params"),
        )
        return Argon2Params(params.memoryKB, params.iterations, params.parallelism, params.saltB64)
    }

    /**
     * Full login: challenge → Argon2 → serverAuthProof → JWT (+ device session
     * when [deviceName] is given) → ARK unwrap. The password never leaves the
     * device; a wrong password fails server-side (proof mismatch).
     */
    fun login(emailOrUsername: String, password: String, deviceName: String? = null): Session {
        val params = fetchLoginChallenge(emailOrUsername)
        val material = DdvCrypto.deriveLoginMaterial(password, params)

        val data = graphql.execute(
            """
            mutation Login(${'$'}id: String!, ${'$'}proof: String!, ${'$'}deviceName: String) {
              login(emailOrUsername: ${'$'}id, serverAuthProof: ${'$'}proof, deviceName: ${'$'}deviceName) {
                token
                refreshToken
                user {
                  id email username
                  crypto {
                    wrappedARKByPassword wrappedARKByRecovery
                    argon2Params { memoryKB iterations parallelism saltB64 }
                    lastPasswordChangeAt
                  }
                }
              }
            }
            """.trimIndent(),
            buildJsonObject {
                put("id", JsonPrimitive(emailOrUsername))
                put("proof", JsonPrimitive(DdvCrypto.b64encode(material.serverAuthProof)))
                put("deviceName", deviceName?.let { JsonPrimitive(it) } ?: JsonNull)
            },
        )

        val loginObj = data.getValue("login").jsonObject
        val token = loginObj.getValue("token").jsonPrimitive.content
        val refreshToken = loginObj["refreshToken"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
        val user = json.decodeFromJsonElement(UserDto.serializer(), loginObj.getValue("user"))

        val ark = DdvCrypto.unwrapArkWithPassword(user.crypto.wrappedARKByPassword, material.arkWrapKey)

        graphql.authToken = token
        return Session(token = token, refreshToken = refreshToken, user = user, ark = ark, filesKey = ark)
    }

    /** Mints a fresh access JWT from a device-session refresh token. */
    fun refreshAccessToken(refreshToken: String): String {
        val data = graphql.execute(
            """
            mutation Refresh(${'$'}rt: String!) {
              refreshSession(refreshToken: ${'$'}rt) { token }
            }
            """.trimIndent(),
            buildJsonObject { put("rt", JsonPrimitive(refreshToken)) },
        )
        val token = data.getValue("refreshSession").jsonObject.getValue("token").jsonPrimitive.content
        graphql.authToken = token
        return token
    }

    // === Gallery plugin ===

    fun galleryDelta(since: String? = null): GalleryDeltaDto {
        val data = graphql.execute(
            """
            query Delta(${'$'}since: DateTime) {
              galleryDelta(since: ${'$'}since) {
                cursor
                files {
                  id parentFolderId encryptedName encryptedMimeType
                  primaryManifestBlobId previewBlobId
                  wrappedFEK wrappedFEKPreview dedupeTokenB64
                  status totalCiphertextBytes chunkCount
                  createdAt updatedAt deletedAt
                }
                folders {
                  id parentFolderId encryptedBody wrappedFolderKey itemCount createdAt updatedAt
                }
              }
            }
            """.trimIndent(),
            buildJsonObject { put("since", since?.let { JsonPrimitive(it) } ?: JsonNull) },
        )
        return json.decodeFromJsonElement(GalleryDeltaDto.serializer(), data.getValue("galleryDelta"))
    }

    fun getGalleryState(key: String): GalleryStateDto? {
        val data = graphql.execute(
            """
            query State(${'$'}key: String!) {
              galleryState(key: ${'$'}key) { key valueB64 version updatedAt }
            }
            """.trimIndent(),
            buildJsonObject { put("key", JsonPrimitive(key)) },
        )
        val state = data["galleryState"]
        if (state == null || state is JsonNull) return null
        return json.decodeFromJsonElement(GalleryStateDto.serializer(), state)
    }

    fun setGalleryState(key: String, valueB64: String, expectedVersion: Int? = null): GalleryStateDto {
        val data = graphql.execute(
            """
            mutation SetState(${'$'}key: String!, ${'$'}value: String!, ${'$'}version: Int) {
              setGalleryState(key: ${'$'}key, valueB64: ${'$'}value, expectedVersion: ${'$'}version) {
                key valueB64 version updatedAt
              }
            }
            """.trimIndent(),
            buildJsonObject {
                put("key", JsonPrimitive(key))
                put("value", JsonPrimitive(valueB64))
                put("version", expectedVersion?.let { JsonPrimitive(it) } ?: JsonNull)
            },
        )
        return json.decodeFromJsonElement(GalleryStateDto.serializer(), data.getValue("setGalleryState"))
    }

    // === Files & folders ===

    fun fileByDedupeToken(dedupeTokenB64: String): FileDto? {
        val data = graphql.execute(
            """
            query Dedupe(${'$'}token: String!) {
              fileByDedupeToken(dedupeTokenB64: ${'$'}token) {
                id parentFolderId encryptedName encryptedMimeType primaryManifestBlobId previewBlobId
                wrappedFEK wrappedFEKPreview dedupeTokenB64 status totalCiphertextBytes chunkCount
                createdAt updatedAt deletedAt
              }
            }
            """.trimIndent(),
            buildJsonObject { put("token", JsonPrimitive(dedupeTokenB64)) },
        )
        val file = data["fileByDedupeToken"]
        if (file == null || file is JsonNull) return null
        return json.decodeFromJsonElement(FileDto.serializer(), file)
    }

    fun initUpload(
        parentFolderId: String?,
        encryptedName: String,
        encryptedMimeType: String,
        wrappedFEK: String,
        dedupeTokenB64: String?,
        totalCiphertextBytes: String,
        chunkCount: Int,
    ): String {
        val data = graphql.execute(
            """
            mutation Init(
              ${'$'}parentFolderId: ID, ${'$'}encryptedName: String, ${'$'}encryptedMimeType: String,
              ${'$'}wrappedFEK: String!, ${'$'}dedupeTokenB64: String,
              ${'$'}totalCiphertextBytes: String!, ${'$'}chunkCount: Int!
            ) {
              initUpload(
                parentFolderId: ${'$'}parentFolderId, encryptedName: ${'$'}encryptedName,
                encryptedMimeType: ${'$'}encryptedMimeType, wrappedFEK: ${'$'}wrappedFEK,
                dedupeTokenB64: ${'$'}dedupeTokenB64,
                totalCiphertextBytes: ${'$'}totalCiphertextBytes, chunkCount: ${'$'}chunkCount
              ) { fileId status }
            }
            """.trimIndent(),
            buildJsonObject {
                put("parentFolderId", parentFolderId?.let { JsonPrimitive(it) } ?: JsonNull)
                put("encryptedName", JsonPrimitive(encryptedName))
                put("encryptedMimeType", JsonPrimitive(encryptedMimeType))
                put("wrappedFEK", JsonPrimitive(wrappedFEK))
                put("dedupeTokenB64", dedupeTokenB64?.let { JsonPrimitive(it) } ?: JsonNull)
                put("totalCiphertextBytes", JsonPrimitive(totalCiphertextBytes))
                put("chunkCount", JsonPrimitive(chunkCount))
            },
        )
        return data.getValue("initUpload").jsonObject.getValue("fileId").jsonPrimitive.content
    }

    fun commitManifest(
        fileId: String,
        manifestBlobId: String,
        totalCiphertextBytes: String,
        chunkCount: Int,
        blobs: List<UploadedBlobTransport>,
    ) {
        val blobsJson = json.encodeToJsonElement(
            kotlinx.serialization.builtins.ListSerializer(UploadedBlobTransport.serializer()),
            blobs,
        )
        graphql.execute(
            """
            mutation Commit(
              ${'$'}fileId: ID!, ${'$'}manifestBlobId: String!,
              ${'$'}totalCiphertextBytes: String!, ${'$'}chunkCount: Int!,
              ${'$'}blobs: [UploadedBlobTransportInput!]!
            ) {
              commitManifest(
                fileId: ${'$'}fileId, manifestBlobId: ${'$'}manifestBlobId,
                totalCiphertextBytes: ${'$'}totalCiphertextBytes, chunkCount: ${'$'}chunkCount, blobs: ${'$'}blobs
              ) { success }
            }
            """.trimIndent(),
            buildJsonObject {
                put("fileId", JsonPrimitive(fileId))
                put("manifestBlobId", JsonPrimitive(manifestBlobId))
                put("totalCiphertextBytes", JsonPrimitive(totalCiphertextBytes))
                put("chunkCount", JsonPrimitive(chunkCount))
                put("blobs", blobsJson)
            },
        )
    }

    fun folders(parentFolderId: String?): List<FolderDto> {
        val data = graphql.execute(
            """
            query Folders(${'$'}parentFolderId: ID) {
              folders(parentFolderId: ${'$'}parentFolderId) {
                id parentFolderId encryptedBody wrappedFolderKey itemCount createdAt updatedAt
              }
            }
            """.trimIndent(),
            buildJsonObject { put("parentFolderId", parentFolderId?.let { JsonPrimitive(it) } ?: JsonNull) },
        )
        return json.decodeFromJsonElement(
            kotlinx.serialization.builtins.ListSerializer(FolderDto.serializer()),
            data.getValue("folders"),
        )
    }

    fun createFolder(encryptedBodyB64: String, wrappedFolderKeyB64: String, parentFolderId: String?): String {
        val data = graphql.execute(
            """
            mutation CreateFolder(${'$'}body: String!, ${'$'}key: String!, ${'$'}parentFolderId: ID) {
              createFolder(encryptedBodyB64: ${'$'}body, wrappedFolderKeyB64: ${'$'}key, parentFolderId: ${'$'}parentFolderId) { id }
            }
            """.trimIndent(),
            buildJsonObject {
                put("body", JsonPrimitive(encryptedBodyB64))
                put("key", JsonPrimitive(wrappedFolderKeyB64))
                put("parentFolderId", parentFolderId?.let { JsonPrimitive(it) } ?: JsonNull)
            },
        )
        return data.getValue("createFolder").jsonObject.getValue("id").jsonPrimitive.content
    }

    // === File management (trash model: deletes are soft, purge is explicit) ===

    fun deleteFile(fileId: String): Boolean = boolMutation("deleteFile", fileId)

    fun restoreFile(fileId: String): Boolean = boolMutation("restoreFile", fileId)

    fun purgeFile(fileId: String): Boolean = boolMutation("purgeFile", fileId)

    private fun boolMutation(name: String, fileId: String): Boolean {
        val data = graphql.execute(
            "mutation M(${'$'}fileId: ID!) { $name(fileId: ${'$'}fileId) }",
            buildJsonObject { put("fileId", JsonPrimitive(fileId)) },
        )
        return data.getValue(name).jsonPrimitive.content.toBoolean()
    }

    fun emptyTrash(): Int {
        val data = graphql.execute("mutation { emptyTrash }")
        return data.getValue("emptyTrash").jsonPrimitive.content.toInt()
    }

    fun trashedFiles(): List<FileDto> {
        val data = graphql.execute(
            """
            query {
              trashedFiles {
                id parentFolderId encryptedName encryptedMimeType primaryManifestBlobId previewBlobId
                wrappedFEK wrappedFEKPreview dedupeTokenB64 status totalCiphertextBytes chunkCount
                createdAt updatedAt deletedAt
              }
            }
            """.trimIndent(),
        )
        return json.decodeFromJsonElement(
            kotlinx.serialization.builtins.ListSerializer(FileDto.serializer()),
            data.getValue("trashedFiles"),
        )
    }

    fun moveFile(fileId: String, parentFolderId: String?): Boolean {
        val data = graphql.execute(
            """mutation Move(${'$'}fileId: ID!, ${'$'}parentFolderId: ID) {
              moveFile(fileId: ${'$'}fileId, parentFolderId: ${'$'}parentFolderId)
            }""",
            buildJsonObject {
                put("fileId", JsonPrimitive(fileId))
                put("parentFolderId", parentFolderId?.let { JsonPrimitive(it) } ?: JsonNull)
            },
        )
        return data.getValue("moveFile").jsonPrimitive.content.toBoolean()
    }

    // === Upload/resume ===

    fun uploadStatus(fileId: String): UploadStatusDto {
        val data = graphql.execute(
            """
            query Status(${'$'}fileId: ID!) {
              uploadStatus(fileId: ${'$'}fileId) {
                fileId status chunkCount uploadedChunkIndices hasManifest
              }
            }
            """.trimIndent(),
            buildJsonObject { put("fileId", JsonPrimitive(fileId)) },
        )
        return json.decodeFromJsonElement(UploadStatusDto.serializer(), data.getValue("uploadStatus"))
    }
}
