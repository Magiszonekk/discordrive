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
    ): UploadOutcome = uploadStream(
        open = { java.io.ByteArrayInputStream(content) },
        fileName = fileName,
        mimeType = mimeType,
        parentFolderId = parentFolderId,
        filesKey = filesKey,
    )

    /**
     * Streaming upload — never holds more than one 8 MiB chunk in memory, so
     * arbitrarily large videos upload without OOM. Two passes over the source:
     * pass 1 hashes for the dedupe token (and measures the real size — the
     * caller's metadata may be stale), pass 2 encrypts and uploads chunks.
     * [open] must return a fresh stream over the same content each call.
     * [onBytes] reports plaintext bytes as each chunk lands (live speed).
     * [checkpoint] runs before each chunk upload — it may block (pause) or
     * throw (cancel), so a long file reacts mid-transfer, not at the end.
     */
    fun uploadStream(
        open: () -> java.io.InputStream,
        fileName: String,
        mimeType: String,
        parentFolderId: String?,
        filesKey: ByteArray,
        onBytes: ((Long) -> Unit)? = null,
        checkpoint: (() -> Unit)? = null,
    ): UploadOutcome {
        val sha = java.security.MessageDigest.getInstance("SHA-256")
        var totalBytes = 0L
        open().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                sha.update(buffer, 0, read)
                totalBytes += read
            }
        }
        require(totalBytes > 0) { "Refusing to upload an empty file" }

        val dedupeTokenB64 = DdvCrypto.b64encode(DdvCrypto.deriveDedupeTokenFromDigest(filesKey, sha.digest()))
        client.fileByDedupeToken(dedupeTokenB64)?.let { existing ->
            return UploadOutcome(fileId = existing.id, deduplicated = true)
        }

        val rootFek = AesGcm.randomKey()
        val wrappedFEK = DdvCrypto.b64encode(DdvCrypto.wrapKeyPacked(rootFek, filesKey))
        val chunkCount = ((totalBytes + CHUNK_SIZE_BYTES - 1) / CHUNK_SIZE_BYTES).toInt()
        val totalCiphertextBytes = totalBytes + chunkCount.toLong() * CHUNK_OVERHEAD_BYTES

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

        open().use { input ->
            val buffer = ByteArray(CHUNK_SIZE_BYTES)
            var streamedBytes = 0L
            for (index in 0 until chunkCount) {
                checkpoint?.invoke()
                val plainSize = readFully(input, buffer)
                streamedBytes += plainSize
                check(plainSize > 0) { "Source ended early — file changed during upload" }
                val ciphertext = DdvCrypto.encryptChunk(
                    if (plainSize == buffer.size) buffer else buffer.copyOf(plainSize),
                    rootFek,
                )
                val blobId = "$fileId:chunk:$index"

                val responseBody = client.blobs.upload(blobId, ciphertext, uploadId, index, chunkCount)
                transports += parseTransport(responseBody)
                manifestChunks += FileChunkManifest.ManifestChunk(
                    index = index,
                    blobId = blobId,
                    ciphertextSizeBytes = ciphertext.size.toLong(),
                )
                onBytes?.invoke(plainSize.toLong())
            }
            check(streamedBytes == totalBytes && input.read() < 0) {
                "Source size changed during upload ($totalBytes → ≥$streamedBytes bytes)"
            }
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

    /**
     * Generates an E2EE preview for an already-committed file: the preview bytes
     * (a small JPEG produced by the caller) get their own random FEK, are
     * encrypted as a single chunk, uploaded as the `<fileId>:preview` blob, and
     * attached via setFilePreview. The preview FEK is wrapped with [filesKey] so
     * any device with the account can decrypt it. Best-effort — callers ignore
     * failures so a preview hiccup never fails the file upload.
     */
    fun uploadPreview(fileId: String, previewBytes: ByteArray, filesKey: ByteArray) {
        val previewFek = AesGcm.randomKey()
        val ciphertext = DdvCrypto.encryptChunk(previewBytes, previewFek)
        val blobId = "$fileId:preview"
        client.blobs.upload(blobId, ciphertext, UUID.randomUUID().toString(), 0, 1)
        val wrappedFEKPreview = DdvCrypto.b64encode(DdvCrypto.wrapKeyPacked(previewFek, filesKey))
        client.setFilePreview(fileId, blobId, wrappedFEKPreview)
    }

    /** Decrypts a file's preview blob to JPEG bytes, or null if it has none. */
    fun downloadPreview(file: FileDto, filesKey: ByteArray): ByteArray? {
        val blobId = file.previewBlobId ?: return null
        val wrapped = file.wrappedFEKPreview ?: return null
        val previewFek = DdvCrypto.unwrapKeyPacked(DdvCrypto.b64decode(wrapped), filesKey)
        val ciphertext = client.blobs.downloadOrNull(blobId) ?: return null
        return DdvCrypto.decryptChunk(ciphertext, previewFek)
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

    /**
     * Streams a file's decrypted bytes to [out], one 8 MiB chunk at a time — never
     * holds the whole file in memory, so large videos download without OOM.
     * Returns the number of plaintext bytes written.
     */
    fun downloadToStream(file: FileDto, filesKey: ByteArray, out: java.io.OutputStream): Long {
        val manifestBlobId = requireNotNull(file.primaryManifestBlobId) { "File has no manifest" }
        val rootFek = DdvCrypto.unwrapRootFek(file.wrappedFEK, filesKey)
        val manifestJson = DdvCrypto.decryptFileManifest(client.blobs.download(manifestBlobId), rootFek)
        val manifest = json.decodeFromString(FileChunkManifest.serializer(), manifestJson)

        var written = 0L
        for (chunk in manifest.chunks.sortedBy { it.index }) {
            val plain = DdvCrypto.decryptChunk(client.blobs.download(chunk.blobId), rootFek)
            out.write(plain)
            written += plain.size
        }
        out.flush()
        return written
    }

    /** Fills [buffer] as far as the stream allows; returns bytes read (0 at EOF). */
    private fun readFully(input: java.io.InputStream, buffer: ByteArray): Int {
        var offset = 0
        while (offset < buffer.size) {
            val read = input.read(buffer, offset, buffer.size - offset)
            if (read < 0) break
            offset += read
        }
        return offset
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
