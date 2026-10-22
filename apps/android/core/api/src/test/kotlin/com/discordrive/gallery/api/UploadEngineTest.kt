package com.discordrive.gallery.api

import com.discordrive.gallery.crypto.AesGcm
import com.discordrive.gallery.crypto.DdvCrypto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.random.Random

class UploadEngineTest {

    private lateinit var server: MockWebServer
    private lateinit var client: DiscorDriveClient
    private lateinit var engine: UploadEngine
    private val json = Json { ignoreUnknownKeys = true }
    private val filesKey = AesGcm.randomKey()

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = DiscorDriveClient(server.url("/").toString().trimEnd('/'))
        client.graphql.authToken = "jwt-test"
        engine = UploadEngine(client)
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    private fun gql(dataJson: String): MockResponse =
        MockResponse().setHeader("content-type", "application/json").setBody("""{"data":$dataJson}""")

    private fun transportResponse(blobId: String, size: Int): MockResponse =
        MockResponse().setBody(
            """{"blobId":"$blobId","ciphertextSizeBytes":"$size","ciphertextHash":"h","storageKind":"LOCAL","storagePath":"/tmp/$blobId"}""",
        )

    @Test
    fun `uploadFile encrypts chunks, manifest and metadata end-to-end`() {
        val content = Random.nextBytes(100_000)
        val fileId = "file-upl-1"

        server.enqueue(gql("""{"fileByDedupeToken":null}"""))
        server.enqueue(gql("""{"initUpload":{"fileId":"$fileId","status":"uploading"}}"""))
        server.enqueue(transportResponse("$fileId:chunk:0", content.size + 28))
        server.enqueue(transportResponse("$fileId:manifest", 200))
        server.enqueue(gql("""{"commitManifest":{"success":true}}"""))

        val outcome = engine.uploadFile(content, "zdjęcie.jpg", "image/jpeg", "folder-1", filesKey)
        assertEquals(fileId, outcome.fileId)
        assertTrue(!outcome.deduplicated)

        // --- dedupe query ---
        server.takeRequest()

        // --- initUpload: encrypted metadata must decrypt with the wrapped FEK ---
        val initVars = json.parseToJsonElement(server.takeRequest().body.readUtf8())
            .jsonObject.getValue("variables").jsonObject
        val rootFek = DdvCrypto.unwrapRootFek(initVars.getValue("wrappedFEK").jsonPrimitive.content, filesKey)
        assertEquals("zdjęcie.jpg", DdvCrypto.decryptMeta(rootFek, initVars.getValue("encryptedName").jsonPrimitive.content))
        assertEquals("image/jpeg", DdvCrypto.decryptMeta(rootFek, initVars.getValue("encryptedMimeType").jsonPrimitive.content))
        assertEquals("folder-1", initVars.getValue("parentFolderId").jsonPrimitive.content)
        assertEquals(1, initVars.getValue("chunkCount").jsonPrimitive.content.toInt())
        val expectedToken = DdvCrypto.b64encode(DdvCrypto.deriveDedupeToken(filesKey, content))
        assertEquals(expectedToken, initVars.getValue("dedupeTokenB64").jsonPrimitive.content)

        // --- chunk PUT: ciphertext decrypts back to the original content ---
        val chunkRequest = server.takeRequest()
        assertEquals("/api/blob/$fileId:chunk:0", chunkRequest.path)
        assertArrayEquals(content, DdvCrypto.decryptChunk(chunkRequest.body.readByteArray(), rootFek))

        // --- manifest PUT: decrypts to a manifest referencing the chunk ---
        val manifestRequest = server.takeRequest()
        assertEquals("/api/blob/$fileId:manifest", manifestRequest.path)
        val manifest = json.decodeFromString(
            FileChunkManifest.serializer(),
            DdvCrypto.decryptFileManifest(manifestRequest.body.readByteArray(), rootFek),
        )
        assertEquals(1, manifest.chunks.size)
        assertEquals("$fileId:chunk:0", manifest.chunks[0].blobId)
        assertEquals((content.size + 28).toLong(), manifest.chunks[0].ciphertextSizeBytes)

        // --- commit carries both blob transports incl. the manifest ---
        val commitVars = json.parseToJsonElement(server.takeRequest().body.readUtf8())
            .jsonObject.getValue("variables").jsonObject
        val blobIds = commitVars.getValue("blobs").toString()
        assertTrue(blobIds.contains("$fileId:chunk:0") && blobIds.contains("$fileId:manifest"))
        assertEquals("$fileId:manifest", commitVars.getValue("manifestBlobId").jsonPrimitive.content)
    }

    @Test
    fun `uploadFile splits content into 8MiB chunks`() {
        val content = Random.nextBytes(UploadEngine.CHUNK_SIZE_BYTES + 1234)
        val fileId = "file-upl-2"

        server.enqueue(gql("""{"fileByDedupeToken":null}"""))
        server.enqueue(gql("""{"initUpload":{"fileId":"$fileId","status":"uploading"}}"""))
        server.enqueue(transportResponse("$fileId:chunk:0", UploadEngine.CHUNK_SIZE_BYTES + 28))
        server.enqueue(transportResponse("$fileId:chunk:1", 1234 + 28))
        server.enqueue(transportResponse("$fileId:manifest", 300))
        server.enqueue(gql("""{"commitManifest":{"success":true}}"""))

        engine.uploadFile(content, "big.bin", "application/octet-stream", null, filesKey)

        server.takeRequest() // dedupe
        val initVars = json.parseToJsonElement(server.takeRequest().body.readUtf8())
            .jsonObject.getValue("variables").jsonObject
        assertEquals(2, initVars.getValue("chunkCount").jsonPrimitive.content.toInt())

        val rootFek = DdvCrypto.unwrapRootFek(initVars.getValue("wrappedFEK").jsonPrimitive.content, filesKey)
        val chunk0 = DdvCrypto.decryptChunk(server.takeRequest().body.readByteArray(), rootFek)
        val chunk1 = DdvCrypto.decryptChunk(server.takeRequest().body.readByteArray(), rootFek)
        assertEquals(UploadEngine.CHUNK_SIZE_BYTES, chunk0.size)
        assertEquals(1234, chunk1.size)
        assertArrayEquals(content, chunk0 + chunk1)
    }

    @Test
    fun `uploadFile short-circuits on dedupe hit`() {
        server.enqueue(
            gql(
                """{"fileByDedupeToken":{"id":"existing-file","wrappedFEK":"AAA=","status":"READY","totalCiphertextBytes":"100","chunkCount":1,"createdAt":"x","updatedAt":"x"}}""",
            ),
        )

        val outcome = engine.uploadFile(Random.nextBytes(500), "dup.jpg", "image/jpeg", null, filesKey)
        assertEquals("existing-file", outcome.fileId)
        assertTrue(outcome.deduplicated)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `downloadFile reverses uploadFile`() {
        val content = Random.nextBytes(50_000)
        val rootFek = AesGcm.randomKey()
        val wrappedFEK = DdvCrypto.b64encode(DdvCrypto.wrapKeyPacked(rootFek, filesKey))

        val chunkCiphertext = DdvCrypto.encryptChunk(content, rootFek)
        val manifestJson = json.encodeToString(
            FileChunkManifest.serializer(),
            FileChunkManifest(
                chunkSizeBytes = UploadEngine.CHUNK_SIZE_BYTES.toLong(),
                chunks = listOf(FileChunkManifest.ManifestChunk(0, "f:chunk:0", chunkCiphertext.size.toLong())),
            ),
        )
        val manifestCiphertext = DdvCrypto.encryptFileManifest(manifestJson, rootFek)

        server.enqueue(MockResponse().setBody(okio.Buffer().write(manifestCiphertext)))
        server.enqueue(MockResponse().setBody(okio.Buffer().write(chunkCiphertext)))

        val file = FileDto(
            id = "f", wrappedFEK = wrappedFEK, primaryManifestBlobId = "f:manifest",
            status = "READY", totalCiphertextBytes = "0", chunkCount = 1, createdAt = "x", updatedAt = "x",
        )
        assertArrayEquals(content, engine.downloadFile(file, filesKey))
    }
}

class FolderManagerTest {

    private lateinit var server: MockWebServer
    private lateinit var client: DiscorDriveClient
    private lateinit var manager: FolderManager
    private val json = Json { ignoreUnknownKeys = true }
    private val filesKey = AesGcm.randomKey()

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = DiscorDriveClient(server.url("/").toString().trimEnd('/'))
        client.graphql.authToken = "jwt-test"
        manager = FolderManager(client)
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    private fun gql(dataJson: String): MockResponse =
        MockResponse().setHeader("content-type", "application/json").setBody("""{"data":$dataJson}""")

    private fun encryptedFolder(id: String, name: String): String {
        val folderKey = AesGcm.randomKey()
        val body = DdvCrypto.encryptMeta(folderKey, """{"name":"$name"}""")
        val wrapped = DdvCrypto.b64encode(DdvCrypto.wrapKeyPacked(folderKey, filesKey))
        return """{"id":"$id","encryptedBody":"$body","wrappedFolderKey":"$wrapped","itemCount":0,"createdAt":"x","updatedAt":"x"}"""
    }

    @Test
    fun `reuses an existing folder matched by decrypted name`() {
        server.enqueue(gql("""{"folders":[${encryptedFolder("f-cam", "Camera")},${encryptedFolder("f-scr", "Screenshots")}]}"""))
        assertEquals("f-scr", manager.ensureFolder("Screenshots", null, filesKey))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `creates a folder with decryptable encrypted name when missing`() {
        server.enqueue(gql("""{"folders":[]}"""))
        server.enqueue(gql("""{"createFolder":{"id":"f-new"}}"""))

        assertEquals("f-new", manager.ensureFolder("Download", null, filesKey))

        server.takeRequest()
        val vars = json.parseToJsonElement(server.takeRequest().body.readUtf8())
            .jsonObject.getValue("variables").jsonObject
        val folderKey = DdvCrypto.unwrapKeyPacked(
            DdvCrypto.b64decode(vars.getValue("key").jsonPrimitive.content),
            filesKey,
        )
        val body = DdvCrypto.decryptMeta(folderKey, vars.getValue("body").jsonPrimitive.content)
        assertEquals("Download", json.parseToJsonElement(body).jsonObject.getValue("name").jsonPrimitive.content)
    }
}
