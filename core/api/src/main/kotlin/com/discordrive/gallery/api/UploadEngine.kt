package com.discordrive.gallery.api

import com.discordrive.gallery.crypto.AesGcm
import com.discordrive.gallery.crypto.DdvCrypto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

/**
 * Encrypted, chunked, deduplicating upload — Kotlin mirror of the web client's
 * upload.ts pipeline:
 *
 *   dedupe check → initUpload → encrypt+PUT chunks → encrypted manifest →
 *   commitManifest(blobs)
 *
 * Chunk format and key derivations are covered by the shared crypto vectors;
 * everything the server stores is ciphertext.
 */
class UploadEngine(private val client: DiscorDriveClient) {

    companion object {
        /** Plaintext chunk size used by the web client (8 MiB). */
        const val CHUNK_SIZE_BYTES = 8 * 1024 * 1024

        /** AES-GCM overhead per chunk: 12 B IV + 16 B tag. */
        const val CHUNK_OVERHEAD_BYTES = 28
    }

    private val json = Json { ignoreUnknownKeys = true }

    data class UploadOutcome(
        val fileId: String,
        /** true when an identical file already existed and no upload happened */
        val deduplicated: Boolean,
    )

    fun uploadFile(
        content: ByteArray,
        fileName: String,
        mimeType: String,
        parentFolderId: String?,
        filesKey: ByteArray,
    ): UploadOutcome {
        require(content.isNotEmpty()) { "Refusing to upload an empty file" }

        val dedupeTokenB64 = DdvCrypto.b64encode(DdvCrypto.deriveDedupeToken(filesKey, content))
        client.fileByDedupeToken(dedupeTokenB64)?.let { existing ->
            return UploadOutcome(fileId = existing.id, deduplicated = true)
        }

        val rootFek = AesGcm.randomKey()
        val wrappedFEK = DdvCrypto.b64encode(DdvCrypto.wrapKeyPacked(rootFek, filesKey))
        val chunkCount = (content.size + CHUNK_SIZE_BYTES - 1) / CHUNK_SIZE_BYTES
        val totalCiphertextBytes = content.size.toLong() + chunkCount.toLong() * CHUNK_OVERHEAD_BYTES

        val fileId = client.initUpload(
            parentFolderId = parentFolderId,
            encryptedName = DdvCrypto.encryptMeta(rootFek, fileName),
            encryptedMimeType = DdvCrypto.encryptMeta(rootFek, mimeType),
            wrappedFEK = wrappedFEK,
            dedupeTokenB64 = dedupeTokenB64,
            totalCiphertextBytes = totalCiphertextBytes.toString(),
            chunkCount = chunkCount,
        )

        val uploadId = UUID.randomUUID().toString()
        val transports = mutableListOf<UploadedBlobTransport>()
        val manifestChunks = mutableListOf<FileChunkManifest.ManifestChunk>()

        for (index in 0 until chunkCount) {
            val from = index * CHUNK_SIZE_BYTES
            val to = minOf(from + CHUNK_SIZE_BYTES, content.size)
            val ciphertext = DdvCrypto.encryptChunk(content.copyOfRange(from, to), rootFek)
            val blobId = "$fileId:chunk:$index"

            val responseBody = client.blobs.upload(blobId, ciphertext, uploadId, index, chunkCount)
            transports += parseTransport(responseBody)
            manifestChunks += FileChunkManifest.ManifestChunk(
                index = index,
                blobId = blobId,
                ciphertextSizeBytes = ciphertext.size.toLong(),
            )
        }

        val manifestJson = json.encodeToString(
            FileChunkManifest.serializer(),
            FileChunkManifest(chunkSizeBytes = CHUNK_SIZE_BYTES.toLong(), chunks = manifestChunks),
        )
        val manifestBlobId = "$fileId:manifest"
        val manifestCiphertext = DdvCrypto.encryptFileManifest(manifestJson, rootFek)
        transports += parseTransport(
            client.blobs.upload(manifestBlobId, manifestCiphertext, uploadId, chunkCount, chunkCount + 1),
        )

        client.commitManifest(
            fileId = fileId,
            manifestBlobId = manifestBlobId,
            totalCiphertextBytes = totalCiphertextBytes.toString(),
            chunkCount = chunkCount,
            blobs = transports,
        )

        return UploadOutcome(fileId = fileId, deduplicated = false)
    }

    /** Downloads and decrypts a whole file (verification / small files). */
    fun downloadFile(file: FileDto, filesKey: ByteArray): ByteArray {
        val manifestBlobId = requireNotNull(file.primaryManifestBlobId) { "File has no manifest" }
        val rootFek = DdvCrypto.unwrapRootFek(file.wrappedFEK, filesKey)

        val manifestJson = DdvCrypto.decryptFileManifest(client.blobs.download(manifestBlobId), rootFek)
        val manifest = json.decodeFromString(FileChunkManifest.serializer(), manifestJson)

        val output = java.io.ByteArrayOutputStream()
        for (chunk in manifest.chunks.sortedBy { it.index }) {
            output.write(DdvCrypto.decryptChunk(client.blobs.download(chunk.blobId), rootFek))
        }
        return output.toByteArray()
    }

    private fun parseTransport(responseBody: String): UploadedBlobTransport {
        val obj = json.parseToJsonElement(responseBody).jsonObject
        fun str(name: String): String? =
            obj[name]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
        return UploadedBlobTransport(
            blobId = requireNotNull(str("blobId")) { "Blob response missing blobId" },
            storageKind = requireNotNull(str("storageKind")) { "Blob response missing storageKind" },
            storagePath = requireNotNull(str("storagePath")) { "Blob response missing storagePath" },
            ciphertextSizeBytes = requireNotNull(str("ciphertextSizeBytes")),
            ciphertextHash = str("ciphertextHash"),
            discordMessageId = str("discordMessageId"),
            discordChannelId = str("discordChannelId"),
            webhookId = str("webhookId"),
        )
    }
}

/**
 * Mirrors Android MediaStore buckets (Camera, Screenshots, Download…) as
 * encrypted DiscorDrive folders. Folder names are E2EE — matching an existing
 * folder requires decrypting candidates client-side.
 */
class FolderManager(private val client: DiscorDriveClient) {

    /** folderId of an existing or newly created folder with [name] under [parentFolderId]. */
    fun ensureFolder(name: String, parentFolderId: String?, filesKey: ByteArray): String {
        for (folder in client.folders(parentFolderId)) {
            val decryptedName = runCatching {
                val folderKey = DdvCrypto.unwrapKeyPacked(DdvCrypto.b64decode(folder.wrappedFolderKey), filesKey)
                val bodyJson = DdvCrypto.decryptMeta(folderKey, folder.encryptedBody)
                Json.parseToJsonElement(bodyJson).jsonObject.getValue("name").jsonPrimitive.content
            }.getOrNull()
            if (decryptedName == name) return folder.id
        }

        val folderKey = AesGcm.randomKey()
        val body = buildJsonObject { put("name", JsonPrimitive(name)) }.toString()
        return client.createFolder(
            encryptedBodyB64 = DdvCrypto.encryptMeta(folderKey, body),
            wrappedFolderKeyB64 = DdvCrypto.b64encode(DdvCrypto.wrapKeyPacked(folderKey, filesKey)),
            parentFolderId = parentFolderId,
        )
    }
}

@kotlinx.serialization.Serializable
data class UploadedBlobTransport(
    val blobId: String,
    val storageKind: String,
    val storagePath: String,
    val ciphertextSizeBytes: String,
    val ciphertextHash: String? = null,
    val discordMessageId: String? = null,
    val discordChannelId: String? = null,
    val webhookId: String? = null,
)
