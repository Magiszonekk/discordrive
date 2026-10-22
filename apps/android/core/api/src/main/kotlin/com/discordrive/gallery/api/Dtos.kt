package com.discordrive.gallery.api

import kotlinx.serialization.Serializable

@Serializable
data class Argon2ParamsDto(
    val memoryKB: Int,
    val iterations: Int,
    val parallelism: Int,
    val saltB64: String,
)

@Serializable
data class UserCryptoDto(
    val wrappedARKByPassword: String,
    val wrappedARKByRecovery: String,
    val argon2Params: Argon2ParamsDto,
    val lastPasswordChangeAt: String,
)

@Serializable
data class UserDto(
    val id: String,
    val email: String,
    val username: String? = null,
    val crypto: UserCryptoDto,
)

@Serializable
data class FileDto(
    val id: String,
    val parentFolderId: String? = null,
    val encryptedName: String? = null,
    val encryptedMimeType: String? = null,
    val primaryManifestBlobId: String? = null,
    val previewBlobId: String? = null,
    val wrappedFEK: String,
    val wrappedFEKPreview: String? = null,
    val dedupeTokenB64: String? = null,
    val status: String,
    val totalCiphertextBytes: String,
    val chunkCount: Int,
    val createdAt: String,
    val updatedAt: String,
    val deletedAt: String? = null,
)

@Serializable
data class FolderDto(
    val id: String,
    val parentFolderId: String? = null,
    val encryptedBody: String,
    val wrappedFolderKey: String,
    val itemCount: Int,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class GalleryDeltaDto(
    val files: List<FileDto>,
    val folders: List<FolderDto>,
    val cursor: String,
)

@Serializable
data class GalleryStateDto(
    val key: String,
    val valueB64: String,
    val version: Int,
    val updatedAt: String,
)

@Serializable
data class UploadStatusDto(
    val fileId: String,
    val status: String,
    val chunkCount: Int,
    val uploadedChunkIndices: List<Int>,
    val hasManifest: Boolean,
)

@Serializable
data class FileChunkManifest(
    val chunkSizeBytes: Long,
    val chunks: List<ManifestChunk>,
) {
    @Serializable
    data class ManifestChunk(
        val index: Int,
        val blobId: String,
        val ciphertextSizeBytes: Long,
    )
}
