package com.discordrive.gallery.api

import com.discordrive.gallery.crypto.AesGcm
import com.discordrive.gallery.crypto.DdvCrypto
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class AiVisionParseTest {

    private val client = AiVisionClient("http://localhost", "k", "m")

    @Test
    fun `parses clean JSON`() {
        val result = client.parseVisionJson("""{"description":"Kot na kanapie","tags":["kot","kanapa"]}""")
        assertEquals("Kot na kanapie", result.description)
        assertEquals(listOf("kot", "kanapa"), result.tags)
    }

    @Test
    fun `parses markdown-fenced JSON with surrounding prose`() {
        val content = "Oto wynik:\n```json\n{\"description\":\"Zrzut ekranu\",\"tags\":[\"SCREENSHOT\",\"Tekst\"]}\n```\nMiłego dnia!"
        val result = client.parseVisionJson(content)
        assertEquals("Zrzut ekranu", result.description)
        assertEquals(listOf("screenshot", "tekst"), result.tags) // lowercased
    }
}

class EnrichmentEngineTest {

    private lateinit var server: MockWebServer
    private lateinit var client: DiscorDriveClient
    private lateinit var engine: EnrichmentEngine
    private val filesKey = AesGcm.randomKey()

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = DiscorDriveClient(server.url("/").toString().trimEnd('/'))
        client.graphql.authToken = "jwt"
        engine = EnrichmentEngine(client)
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `saveEnrichment uploads ciphertext that loadEnrichment decrypts`() {
        val rootFek = AesGcm.randomKey()
        val wrappedFEK = DdvCrypto.b64encode(DdvCrypto.wrapKeyPacked(rootFek, filesKey))
        val record = EnrichmentRecord(
            tags = listOf("gradient", "kamera"),
            description = "Gradient z napisem Camera 1",
            model = "test-model",
            analyzedAt = "2026-06-11T14:00:00Z",
        )

        server.enqueue(MockResponse().setBody("""{"blobId":"f1:enrichment"}"""))
        engine.saveEnrichment("f1", wrappedFEK, filesKey, record)

        val put = server.takeRequest()
        assertEquals("/api/blob/f1:enrichment", put.path)
        val ciphertext = put.body.readByteArray()
        // server sees only ciphertext
        assertFalse(String(ciphertext, Charsets.ISO_8859_1).contains("Gradient"))

        // round trip through download
        server.enqueue(MockResponse().setBody(Buffer().write(ciphertext)))
        val file = FileDto(
            id = "f1", wrappedFEK = wrappedFEK, status = "READY",
            totalCiphertextBytes = "0", chunkCount = 1, createdAt = "x", updatedAt = "x",
        )
        val loaded = engine.loadEnrichment(file, filesKey)
        assertEquals(record, loaded)
    }

    @Test
    fun `loadEnrichment returns null when blob is missing`() {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Blob not found"}"""))
        val file = FileDto(
            id = "f2", wrappedFEK = DdvCrypto.b64encode(DdvCrypto.wrapKeyPacked(AesGcm.randomKey(), filesKey)),
            status = "READY", totalCiphertextBytes = "0", chunkCount = 1, createdAt = "x", updatedAt = "x",
        )
        assertNull(engine.loadEnrichment(file, filesKey))
    }

    @Test
    fun `matches searches tags and description case-insensitively`() {
        val record = EnrichmentRecord(
            tags = listOf("kot", "mem"),
            description = "Śmieszny kot siedzi na klawiaturze",
            model = "m", analyzedAt = "t",
        )
        assertTrue(engine.matches(record, "KOT"))
        assertTrue(engine.matches(record, "klawiatur"))
        assertTrue(engine.matches(record, "mem"))
        assertFalse(engine.matches(record, "pies"))
        assertFalse(engine.matches(record, "  "))
    }
}
