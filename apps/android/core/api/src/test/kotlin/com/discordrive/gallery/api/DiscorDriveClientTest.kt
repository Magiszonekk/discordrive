package com.discordrive.gallery.api

import com.discordrive.gallery.crypto.AesGcm
import com.discordrive.gallery.crypto.Argon2Params
import com.discordrive.gallery.crypto.DdvCrypto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse as LegacyMockResponse
import okhttp3.mockwebserver.MockWebServer as LegacyMockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * Exercises the client against a scripted server. The login flow uses real
 * crypto end-to-end: the test wraps a known ARK under the password-derived
 * key, and asserts the client both sends the correct serverAuthProof and
 * recovers the exact ARK bytes.
 */
class DiscorDriveClientTest {

    private lateinit var server: LegacyMockWebServer
    private lateinit var client: DiscorDriveClient
    private val json = Json { ignoreUnknownKeys = true }

    // Fast Argon2 params to keep the test quick
    private val params = Argon2Params(memoryKB = 8192, iterations = 1, parallelism = 1, saltB64 = DdvCrypto.b64encode(ByteArray(16) { it.toByte() }))
    private val password = "test-password-żółw"

    @BeforeEach
    fun setUp() {
        server = LegacyMockWebServer()
        server.start()
        client = DiscorDriveClient(server.url("/").toString().trimEnd('/'))
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    private fun gqlResponse(dataJson: String): LegacyMockResponse =
        LegacyMockResponse().setHeader("content-type", "application/json").setBody("""{"data":$dataJson}""")

    @Test
    fun `login derives proof, sends deviceName and unwraps ARK`() {
        val material = DdvCrypto.deriveLoginMaterial(password, params)
        val ark = AesGcm.randomKey()
        val wrappedArk = DdvCrypto.b64encode(DdvCrypto.wrapKeyPacked(ark, material.arkWrapKey))

        server.enqueue(
            gqlResponse(
                """{"getLoginChallenge":{"argon2Params":{"memoryKB":${params.memoryKB},"iterations":${params.iterations},"parallelism":${params.parallelism},"saltB64":"${params.saltB64}"}}}""",
            ),
        )
        server.enqueue(
            gqlResponse(
                """{"login":{"token":"jwt-123","refreshToken":"rt-456","user":{"id":"u1","email":"a@b.c","username":"magis","crypto":{"wrappedARKByPassword":"$wrappedArk","wrappedARKByRecovery":"$wrappedArk","argon2Params":{"memoryKB":${params.memoryKB},"iterations":${params.iterations},"parallelism":${params.parallelism},"saltB64":"${params.saltB64}"},"lastPasswordChangeAt":"2026-06-11T00:00:00.000Z"}}}}""",
            ),
        )

        val session = client.login("a@b.c", password, deviceName = "Pixel 9")

        assertEquals("jwt-123", session.token)
        assertEquals("rt-456", session.refreshToken)
        assertArrayEquals(ark, session.ark)
        assertArrayEquals(ark, session.filesKey)

        // challenge request
        server.takeRequest()
        // login request carries the HKDF-derived proof and the device name
        val loginRequest = server.takeRequest()
        val variables = json.parseToJsonElement(loginRequest.body.readUtf8())
            .jsonObject.getValue("variables").jsonObject
        assertEquals(DdvCrypto.b64encode(material.serverAuthProof), variables.getValue("proof").jsonPrimitive.content)
        assertEquals("Pixel 9", variables.getValue("deviceName").jsonPrimitive.content)
    }

    @Test
    fun `wrong password produces a different proof`() {
        val good = DdvCrypto.deriveLoginMaterial(password, params)
        val bad = DdvCrypto.deriveLoginMaterial("wrong-password", params)
        assertTrue(!good.serverAuthProof.contentEquals(bad.serverAuthProof))
    }

    @Test
    fun `refreshAccessToken updates the bearer token`() {
        server.enqueue(gqlResponse("""{"refreshSession":{"token":"jwt-fresh"}}"""))
        val token = client.refreshAccessToken("rt-456")
        assertEquals("jwt-fresh", token)
        assertEquals("jwt-fresh", client.graphql.authToken)
    }

    @Test
    fun `galleryDelta parses files, folders and cursor`() {
        server.enqueue(
            gqlResponse(
                """{"galleryDelta":{"cursor":"2026-06-11T10:00:00.000Z","files":[{"id":"f1","wrappedFEK":"AAA=","status":"READY","totalCiphertextBytes":"100","chunkCount":1,"createdAt":"2026-06-11T09:00:00.000Z","updatedAt":"2026-06-11T09:30:00.000Z","deletedAt":null,"previewBlobId":"f1:preview"}],"folders":[{"id":"d1","encryptedBody":"AAE=","wrappedFolderKey":"AAI=","itemCount":3,"createdAt":"2026-06-11T08:00:00.000Z","updatedAt":"2026-06-11T08:00:00.000Z"}]}}""",
            ),
        )
        client.graphql.authToken = "jwt"

        val delta = client.galleryDelta(since = null)
        assertEquals(1, delta.files.size)
        assertEquals("f1", delta.files[0].id)
        assertEquals("f1:preview", delta.files[0].previewBlobId)
        assertEquals("d1", delta.folders[0].id)
        assertEquals("2026-06-11T10:00:00.000Z", delta.cursor)
    }

    @Test
    fun `gallery state round trip and version conflict surfaces as exception`() {
        server.enqueue(
            gqlResponse("""{"setGalleryState":{"key":"bucket-map","valueB64":"AQI=","version":1,"updatedAt":"2026-06-11T10:00:00.000Z"}}"""),
        )
        client.graphql.authToken = "jwt"
        val state = client.setGalleryState("bucket-map", "AQI=", expectedVersion = 0)
        assertEquals(1, state.version)

        server.enqueue(
            LegacyMockResponse().setHeader("content-type", "application/json")
                .setBody("""{"errors":[{"message":"Version conflict on \"bucket-map\": expected version 1"}],"data":null}"""),
        )
        val error = runCatching { client.setGalleryState("bucket-map", "AQM=", expectedVersion = 1) }
        assertTrue(error.exceptionOrNull() is GraphQLException)
        assertTrue(error.exceptionOrNull()!!.message!!.contains("Version conflict"))
    }

    @Test
    fun `blob upload sends auth and chunk headers, download returns bytes`() {
        client.graphql.authToken = "jwt-blob"
        server.enqueue(LegacyMockResponse().setBody("""{"blobId":"f1:chunk:0"}"""))
        server.enqueue(LegacyMockResponse().setBody("payload-bytes"))

        val ciphertext = byteArrayOf(1, 2, 3, 4)
        client.blobs.upload("f1:chunk:0", ciphertext, uploadId = "up-1", chunkIndex = 0, chunkCount = 2)

        val put = server.takeRequest()
        assertEquals("PUT", put.method)
        assertEquals("/api/blob/f1:chunk:0", put.path)
        assertEquals("Bearer jwt-blob", put.getHeader("Authorization"))
        assertEquals("0", put.getHeader("X-Chunk-Index"))
        assertEquals("2", put.getHeader("X-Chunk-Count"))
        assertEquals("up-1", put.getHeader("X-Upload-Id"))
        assertNotNull(put.getHeader("X-Client-Timestamp"))
        assertArrayEquals(ciphertext, put.body.readByteArray())

        val bytes = client.blobs.download("f1:manifest")
        assertArrayEquals("payload-bytes".toByteArray(), bytes)
    }
}
