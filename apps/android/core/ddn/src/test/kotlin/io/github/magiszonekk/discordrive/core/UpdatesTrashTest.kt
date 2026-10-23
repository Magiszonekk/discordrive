package io.github.magiszonekk.discordrive.core

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

class UpdatesTrashTest {
    private fun hex(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    private fun server(apk: ByteArray, sha: String, status: Int = 200): MockWebServer = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val base = url("/").toString().trimEnd('/')
                return when (request.path) {
                    "/repos/Magiszonekk/discordrive/releases/tags/android-main-build" -> if (status != 200) MockResponse().setResponseCode(status) else MockResponse().setBody(
                        """{"published_at":"2026-10-23T12:00:00Z","body":"Build of main","assets":[
                          {"name":"android-build.json","browser_download_url":"$base/a/info","size":10},
                          {"name":"discordrive-android-412.apk","browser_download_url":"$base/a/apk","size":${apk.size}}]}""",
                    )
                    "/a/info" -> MockResponse().setBody("""{"versionCode":412,"versionName":"0.1.0-412","commit":"abc1234","apk":"discordrive-android-412.apk","sha256":"$sha"}""")
                    "/a/apk" -> MockResponse().setBody(Buffer().write(apk))
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        start()
    }

    @Test
    fun `a higher versionCode is offered, the APK is checked against its SHA-256`() {
        val apk = ByteArray(300_000) { (it * 7).toByte() }
        server(apk, hex(apk)).use { s ->
            val u = AppUpdates(apiBase = s.url("/").toString().trimEnd('/'))
            val b = u.latest()!!
            assertEquals(412, b.versionCode)
            assertEquals("0.1.0-412", b.versionName)
            assertTrue(AppUpdates.isNewer(411, b))
            assertFalse(AppUpdates.isNewer(412, b))
            assertFalse(AppUpdates.isNewer(500, b))
            val dir = Files.createTempDirectory("upd").toFile()
            var last = 0L
            val f = u.download(b, File(dir, "u.apk"), { d, _ -> last = d })
            assertTrue(f.readBytes().contentEquals(apk))
            assertEquals(apk.size.toLong(), last)
            // The same build again: the file is reused (no second download).
            val before = s.requestCount
            u.download(b, File(dir, "u.apk"))
            assertEquals(before, s.requestCount)
        }
    }

    @Test
    fun `a wrong checksum deletes the file, no release offers nothing`() {
        val apk = ByteArray(1000) { 1 }
        server(apk, "0".repeat(64)).use { s ->
            val u = AppUpdates(apiBase = s.url("/").toString().trimEnd('/'))
            val dir = Files.createTempDirectory("upd").toFile()
            assertThrows(AppUpdates.UpdateException::class.java) { u.download(u.latest()!!, File(dir, "u.apk")) }
            assertFalse(File(dir, "u.apk").exists())
            assertFalse(File(dir, "u.apk.part").exists())
        }
        server(apk, hex(apk), status = 404).use { s -> assertNull(AppUpdates(apiBase = s.url("/").toString().trimEnd('/')).latest()) }
    }

    @Test
    fun `Q4 - the phone waits for the main device, never metered, never unsynced`() {
        val now = 100 * TrashPolicy.DAY_MS
        val ids = listOf("a", "b")
        assertEquals(TrashPolicy.Decision.Skip("not_synced"), TrashPolicy.decide(ids, now, true, false, false, null, 0))
        assertEquals(TrashPolicy.Decision.Skip("metered"), TrashPolicy.decide(ids, now, true, true, true, null, 0))
        assertEquals(TrashPolicy.Decision.Skip("primary_cleans"), TrashPolicy.decide(ids, now, false, true, false, now - 6 * TrashPolicy.DAY_MS, 0))
        assertEquals(TrashPolicy.Decision.Clean(ids), TrashPolicy.decide(ids, now, false, true, false, now - 7 * TrashPolicy.DAY_MS, 0))
        assertEquals(TrashPolicy.Decision.Skip("primary_cleans"), TrashPolicy.decide(ids, now, false, true, false, null, null))
        assertEquals(TrashPolicy.Decision.Clean(ids), TrashPolicy.decide(ids, now, false, true, false, null, now - 8 * TrashPolicy.DAY_MS))
        assertEquals(TrashPolicy.Decision.Skip("nothing_expired"), TrashPolicy.decide(emptyList(), now, true, true, false, null, 0))
        assertEquals(30, TrashPolicy.daysLeft(now, now))
        assertEquals(1, TrashPolicy.daysLeft(now - 29 * TrashPolicy.DAY_MS - 1, now))
        assertEquals(0, TrashPolicy.daysLeft(now - 31 * TrashPolicy.DAY_MS, now))
    }
}
