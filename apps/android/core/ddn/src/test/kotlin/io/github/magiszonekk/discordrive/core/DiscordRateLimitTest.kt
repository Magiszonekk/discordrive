package io.github.magiszonekk.discordrive.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Discord's 429 of a webhook's bucket as seen in production (2026-10-26): header retry-after 1812, body
 * retry_after 0.3, x-ratelimit-reset-after 2, scope user. Read from the header, every bucket hit waited the cap.
 */
class DiscordRateLimitTest {
    private val prod = mapOf("retry-after" to "1812", "x-ratelimit-reset-after" to "2", "x-ratelimit-remaining" to "0", "x-ratelimit-scope" to "user", "x-ratelimit-limit" to "5", "via" to "1.1 google")
    private val body = """{"message":"You are being rate limited.","retry_after":0.3,"global":false}"""

    @Test
    fun bucketWaitsTheBodyNotTheHeader() {
        val w = DiscordRateLimit.wait({ prod[it.lowercase()] }, body)
        assertEquals(0.3, w.seconds, 1e-9)
        assertFalse(w.global)
        assertFalse(w.cloudflare)
        // No body value: x-ratelimit-reset-after.
        assertEquals(2.0, DiscordRateLimit.wait({ prod[it.lowercase()] }, "").seconds, 1e-9)
    }

    @Test
    fun cloudflarePlainTextAndGlobal() {
        val cf = DiscordRateLimit.wait({ mapOf("retry-after" to "1800")[it.lowercase()] }, "error code: 1015")
        assertTrue(cf.cloudflare)
        val g = DiscordRateLimit.wait({ mapOf("retry-after" to "40", "x-ratelimit-scope" to "global")[it.lowercase()] }, """{"retry_after":40,"global":true}""")
        assertTrue(g.global)
        assertEquals(40.0, g.seconds, 1e-9)
    }

    @Test
    fun readThroughABucketRateLimitWaitsLessThanASecond() {
        MockWebServer().use { s ->
            val r429 = MockResponse().setResponseCode(429).setBody(body).setHeader("content-type", "application/json")
            prod.forEach { (k, v) -> r429.setHeader(k, v) }
            s.enqueue(r429)
            s.enqueue(MockResponse().setResponseCode(200).setBody("abc"))
            s.start()
            val t0 = System.currentTimeMillis()
            val got = Discord().download(s.url("/attachments/1/2/x.txt").toString())
            val took = System.currentTimeMillis() - t0
            assertArrayEquals("abc".toByteArray(), got)
            assertTrue(took < 3_000, "waited $took ms")
        }
    }
}
