package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class DescribeTest {
    private val fileKey = randomBytes(32)
    private val rec = Describe.Record("Paragon ze sklepu", listOf("paragon", "zakupy"), text = "RAZEM 42,50 PLN", model = "m", at = 1_700_000_000_000)

    @Test
    fun sealsAndOpens() {
        val sealed = Describe.seal(fileKey, rec)
        assertEquals(rec, Describe.open(fileKey, sealed))
        // The plaintext is not visible in what is stored.
        assertFalse(String(sealed, Charsets.ISO_8859_1).contains("Paragon"))
    }

    @Test
    fun otherFileKeyOrBitFlipRefused() {
        val sealed = Describe.seal(fileKey, rec)
        assertThrows(Exception::class.java) { Describe.open(randomBytes(32), sealed) }
        sealed[sealed.size - 1] = (sealed[sealed.size - 1].toInt() xor 1).toByte()
        assertThrows(Exception::class.java) { Describe.open(fileKey, sealed) }
    }

    @Test
    fun nameIsPerFileAndNotAPreviewName() {
        val n = Describe.name(fileKey)
        assertEquals(22, n.length)
        assertEquals(n, Describe.name(fileKey.copyOf()))
        assertNotEquals(n, Describe.name(randomBytes(32)))
        val pk = FileFormat.PreviewKeys(fileKey)
        assertNotEquals(n, pk.name('t')); assertNotEquals(n, pk.name('p'))
        // A valid "x<name>" blob index on the instance (8..40 url-safe characters).
        assertTrue(Regex("^[A-Za-z0-9_-]{8,40}$").matches(n))
    }

    @Test
    fun searchMatchesEveryField() {
        assertTrue(rec.matches("paragon")); assertTrue(rec.matches("ZAKUPY")); assertTrue(rec.matches("42,50"))
        assertFalse(rec.matches("kot")); assertFalse(rec.matches("  "))
        assertTrue(rec.copy(transcript = "dzień dobry wszystkim").matches("dobry"))
    }

    @Test
    fun configInTheVaultKeepsTheRest() {
        val v = Vault.withWebhook(Vault.empty(), kotlinx.serialization.json.buildJsonObject {
            put("id", kotlinx.serialization.json.JsonPrimitive("1")); put("url", kotlinx.serialization.json.JsonPrimitive("https://example.com/h")); put("addedAt", kotlinx.serialization.json.JsonPrimitive(1))
        })
        val c = Describe.AiConfig("http://localhost:8080/v1", "sekret", "vision-1")
        val v2 = Describe.withConfig(v, c)
        assertEquals(c, Describe.configOf(v2))
        assertEquals(1, Vault.webhooks(v2).size)
        assertFalse(c.toString().contains("sekret"))
        val v3 = Describe.withConfig(v2, null)
        assertNull(Describe.configOf(v3)); assertEquals(1, Vault.webhooks(v3).size)
    }

    @Test
    fun addsToAMessageKeepingItsAttachments() {
        MockWebServer().use { srv ->
            val msg = """{"id":"55","channel_id":"9","attachments":[{"id":"a1","filename":"m.txt","size":10,"url":"x"},{"id":"a2","filename":"t.txt","size":5,"url":"y"}]}"""
            srv.enqueue(MockResponse().setBody(msg))
            srv.enqueue(MockResponse().setResponseCode(429).setBody("""{"retry_after":0.2}"""))
            srv.enqueue(MockResponse().setBody("""{"id":"55","attachments":[{"id":"a1"},{"id":"a2"},{"id":"a3"}]}"""))
            val hook = srv.url("/api/webhooks/1/tok").toString()
            val ok = ExtraWriter().addToMessage(Discord(), hook, "55", "descName0123", Describe.seal(fileKey, rec))
            assertTrue(ok)
            srv.takeRequest()
            srv.takeRequest()
            val patch = srv.takeRequest()
            assertEquals("PATCH", patch.method)
            val body = patch.body.readUtf8()
            val payload = Regex("\\{\"attachments\".*?\\]\\}").find(body)!!.value
            val ids = (json.parseToJsonElement(payload) as JsonObject).getValue("attachments").jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content }
            assertEquals(listOf("a1", "a2", "0"), ids)
            assertTrue(body.contains("filename=\"descName0123.txt\""))
        }
    }

    @Test
    fun secondDeviceDoesNotAddAgain() {
        MockWebServer().use { srv ->
            srv.enqueue(MockResponse().setBody("""{"id":"55","attachments":[{"id":"a1","filename":"m.txt","size":10,"url":"x"},{"id":"a9","filename":"descName0123.txt","size":50,"url":"z"}]}"""))
            assertFalse(ExtraWriter().addToMessage(Discord(), srv.url("/api/webhooks/1/tok").toString(), "55", "descName0123", ByteArray(40)))
            assertEquals(1, srv.requestCount)
        }
    }
}

class AiDescriberTest {
    @Test
    fun parsesCleanFencedAndCutAnswers() {
        val a = AiDescriber.parse("""{"description":"Kot na kanapie","tags":["Kot","kanapa"],"text":""}""", "m")
        assertEquals("Kot na kanapie", a.description); assertEquals(listOf("kot", "kanapa"), a.tags); assertNull(a.text)
        val b = AiDescriber.parse("Oto:\n```json\n{\"description\":\"Paragon\",\"tags\":[\"paragon\"],\"text\":\"RAZEM 12 PLN\"}\n```", "m")
        assertEquals("RAZEM 12 PLN", b.text)
        val c = AiDescriber.parse("""{"description":"Zrzut ekranu z czatem","tags":["czat","zrzu""", "m")
        assertEquals("Zrzut ekranu z czatem", c.description)
        assertThrows(AiException::class.java) { AiDescriber.parse("nie wiem", "m") }
        assertThrows(AiException::class.java) { AiDescriber.parse("{\"foo\":1}", "m") }
    }

    @Test
    fun sendsTheImageAndMapsErrors() {
        MockWebServer().use { srv ->
            srv.enqueue(MockResponse().setBody("""{"choices":[{"message":{"content":"{\"description\":\"Pasy\",\"tags\":[\"test\"],\"text\":\"DDN 42\"}"}}]}"""))
            srv.enqueue(MockResponse().setResponseCode(429).setHeader("retry-after", "7").setBody("{}"))
            srv.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
            srv.enqueue(MockResponse().setBody("""{"data":[{"id":"b"},{"id":"a"}]}"""))
            val ai = AiDescriber(srv.url("/v1").toString(), "good", "vision-1")
            val r = ai.describe(byteArrayOf(1, 2, 3))
            assertEquals("DDN 42", r.text); assertEquals("vision-1", r.model)
            val req = srv.takeRequest()
            assertEquals("/v1/chat/completions", req.path); assertEquals("Bearer good", req.getHeader("Authorization"))
            assertTrue(req.body.readUtf8().contains("data:image/jpeg;base64,AQID"))
            val rate = assertThrows(AiException::class.java) { ai.describe(byteArrayOf(1)) }
            assertEquals("rate", rate.kind); assertEquals(7, rate.retryAfterS)
            assertEquals("auth", assertThrows(AiException::class.java) { ai.describe(byteArrayOf(1)) }.kind)
            assertEquals(listOf("a", "b"), ai.models())
            // Without /v1 in the address the same paths.
            srv.takeRequest(); srv.takeRequest()
            assertEquals("/v1/models", srv.takeRequest().path)
        }
    }
}

class SearchTest {
    private val utc = java.time.ZoneId.of("UTC")
    private fun at(s: String) = java.time.Instant.parse(s + "T12:00:00Z").toEpochMilli()
    private val items = listOf(
        Search.Item("1", "IMG_0001.jpg", at("2024-05-17"), Describe.Record("Paragon ze sklepu spożywczego", listOf("paragon", "zakupy"), text = "RAZEM 42,50 PLN", model = "m", at = 0)),
        Search.Item("2", "kot.jpg", at("2023-01-02"), Describe.Record("Żółty kot na kanapie", listOf("kot", "kanapa"), model = "m", at = 0)),
        Search.Item("3", "wakacje paragon.pdf", at("2024-07-01"), null),
        Search.Item("4", "film.mp4", at("2024-05-20"), Describe.Record("Dzieci na plaży", listOf("plaża"), transcript = "patrz jaka fala", model = "m", at = 0)),
    )

    @Test
    fun findsByEveryField() {
        assertEquals(listOf("3", "1"), Search.run(items, "paragon", utc).map { it.id }) // name scores above a tag
        assertEquals(listOf("1"), Search.run(items, "42,50", utc).map { it.id })          // text on the picture
        assertEquals(listOf("4"), Search.run(items, "fala", utc).map { it.id })           // transcript
        assertEquals(listOf("2"), Search.run(items, "zolty KOT", utc).map { it.id })      // diacritics, case, two words
        assertEquals(listOf("2"), Search.run(items, "żółty", utc).map { it.id })
        assertEquals(listOf("2"), Search.run(items, "kot.jpg", utc).map { it.id })
    }

    @Test
    fun datesAndEveryWord() {
        assertEquals(listOf("4", "1"), Search.run(items, "2024-05", utc).map { it.id })
        assertEquals(listOf("1"), Search.run(items, "2024-05-17", utc).map { it.id })
        assertEquals(listOf("1"), Search.run(items, "paragon 2024-05", utc).map { it.id })
        assertTrue(Search.run(items, "kot plaża", utc).isEmpty())
        assertTrue(Search.run(items, "   ", utc).isEmpty())
    }
}
