package io.github.magiszonekk.discordrive.core

import io.github.magiszonekk.discordrive.core.GalleryBackup.Badge
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GalleryBackupTest {
    private fun node(id: String, name: String, size: Long = 100) = IndexReplica.Child(id, name, "file", size, manifestRef = "ref-$id", createdAt = 1_000)
    private fun local(id: Long, name: String, size: Long = 100, bucket: String = "Camera") = GalleryBackup.Local(id, name, bucket, size, modified = 50, taken = 2_000, video = false)
    private fun badges(e: List<GalleryBackup.Entry>) = e.associate { it.item.name to it.badge }

    @Test fun pairedByTheCopyRecordOnce() {
        val e = GalleryBackup.merge(GalleryBackup.Input(
            account = listOf(node("n1", "a.jpg"), node("n2", "b.jpg")),
            locals = listOf(local(1, "a.jpg")),
            copied = mapOf(1L to GalleryBackup.Copied(100, 50, "n1")),
        ))
        // One tile for the phone's photo and its copy (the account's node), the other only in the account.
        assertEquals(2, e.size)
        assertEquals(mapOf("a.jpg" to Badge.BOTH, "b.jpg" to Badge.ACCOUNT_ONLY), badges(e))
        val a = e.first { it.item.name == "a.jpg" }
        assertEquals("n1", a.item.id)
        assertTrue(a.onPhone && a.inAccount)
    }

    @Test fun pairedByNameAndSizeWithoutARecord() {
        // A reinstall (no record), or a copy made by Share: the same name and size.
        val e = GalleryBackup.merge(GalleryBackup.Input(
            account = listOf(node("n1", "a.jpg", 100), node("n2", "a.jpg", 999)),
            locals = listOf(local(1, "a.jpg", 100), local(2, "a.jpg", 100)),
        ))
        // The first local takes n1; the second (same name, no twin left) stays on the phone; n2 differs in size.
        assertEquals(3, e.size)
        assertEquals(Badge.BOTH, e.first { it.item.id == "n1" }.badge)
        assertEquals(Badge.ACCOUNT_ONLY, e.first { it.item.id == "n2" }.badge)
        val l2 = e.first { it.local?.mediaId == 2L }
        assertEquals(Badge.LOCAL_ONLY, l2.badge)
        assertEquals(GalleryBackup.localId(2), l2.item.id)
        assertTrue(!l2.inAccount)
    }

    @Test fun aRecordOfAnEditedPhotoDoesNotCount() {
        // Edited after the copy (other size): the record does not match, the copy stays its own tile.
        val e = GalleryBackup.merge(GalleryBackup.Input(
            account = listOf(node("n1", "a.jpg", 100)),
            locals = listOf(local(1, "a.jpg", 120)),
            copied = mapOf(1L to GalleryBackup.Copied(100, 50, "n1")),
            autoOn = true, autoBuckets = setOf("Camera"),
        ))
        assertEquals(mapOf(Badge.ACCOUNT_ONLY to 1, Badge.QUEUED to 1), e.groupingBy { it.badge }.eachCount())
    }

    @Test fun aCopyHiddenFromTheListIsNotShownThroughThePhone() {
        // Copied into an album marked private (or moved to the Drive): the node lives, the list leaves it out.
        val e = GalleryBackup.merge(GalleryBackup.Input(
            account = emptyList(),
            locals = listOf(local(1, "secret.jpg"), local(2, "trashed.jpg")),
            copied = mapOf(1L to GalleryBackup.Copied(100, 50, "hidden"), 2L to GalleryBackup.Copied(100, 50, "gone")),
            live = { it == "hidden" },
        ))
        // The trashed one's copy is gone: back to "only on the phone" (the automatic copy does not redo it).
        assertEquals(mapOf("trashed.jpg" to Badge.LOCAL_ONLY), badges(e))
    }

    @Test fun badgesFromTheQueueAndTheAutomaticCopy() {
        val e = GalleryBackup.merge(GalleryBackup.Input(
            account = emptyList(),
            locals = listOf(
                local(1, "cam.jpg"), local(2, "shot.png", bucket = "Screenshots"), local(3, "queued.jpg", bucket = "Screenshots"),
                local(4, "broken.jpg", bucket = "Screenshots"), local(5, "now.jpg"), local(6, "bad.jpg"),
            ),
            queue = listOf(GalleryBackup.Queued(10, "queued.jpg", 100, null), GalleryBackup.Queued(11, "broken.jpg", 100, "HTTP 404 discord")),
            failed = mapOf(6L to "too large"),
            autoOn = true, autoBuckets = setOf("Camera"), sending = "now.jpg",
        ))
        assertEquals(mapOf(
            "cam.jpg" to Badge.QUEUED, "shot.png" to Badge.LOCAL_ONLY, "queued.jpg" to Badge.QUEUED,
            "broken.jpg" to Badge.FAILED, "now.jpg" to Badge.SENDING, "bad.jpg" to Badge.FAILED,
        ), badges(e))
        assertEquals(11L, e.first { it.item.name == "broken.jpg" }.queueId)
        assertEquals("too large", e.first { it.item.name == "bad.jpg" }.error)
        // The copy off: nothing waits except the queue; a past failure of the copy is not shown.
        val off = GalleryBackup.merge(GalleryBackup.Input(account = emptyList(), locals = listOf(local(1, "cam.jpg"), local(6, "bad.jpg")), failed = mapOf(6L to "x")))
        assertEquals(mapOf("cam.jpg" to Badge.LOCAL_ONLY, "bad.jpg" to Badge.LOCAL_ONLY), badges(off))
    }

    @Test fun filterAndBar() {
        val e = GalleryBackup.merge(GalleryBackup.Input(
            account = listOf(node("n1", "a.jpg"), node("n9", "other.jpg")),
            locals = listOf(local(1, "a.jpg"), local(2, "b.jpg"), local(3, "c.jpg")),
            copied = mapOf(1L to GalleryBackup.Copied(100, 50, "n1")),
            autoOn = true, autoBuckets = setOf("Camera"),
        ))
        assertEquals(listOf("b.jpg", "c.jpg"), GalleryBackup.filter(e, GalleryBackup.Filter.PHONE_ONLY).map { it.item.name })
        assertEquals(listOf("other.jpg"), GalleryBackup.filter(e, GalleryBackup.Filter.ACCOUNT_ONLY).map { it.item.name })
        assertEquals(4, GalleryBackup.filter(e, GalleryBackup.Filter.ALL).size)
        // A series of runs is open: the notification's count ("1 100 of 1 109"), what is left waits for Wi-Fi.
        assertEquals(GalleryBackup.Bar.Progress(1100, 1109, 9, GalleryBackup.Wait.WIFI, 0), GalleryBackup.bar(e, true, true, 1100, 1109, GalleryBackup.Wait.WIFI))
        // No series: the grid's count.
        assertEquals(GalleryBackup.Bar.Waiting(2, GalleryBackup.Wait.QUEUE, 0), GalleryBackup.bar(e, true, false, 0, 0, GalleryBackup.Wait.QUEUE))
        val done = GalleryBackup.merge(GalleryBackup.Input(account = listOf(node("n1", "a.jpg")), locals = listOf(local(1, "a.jpg")), autoOn = true, autoBuckets = setOf("Camera")))
        assertEquals(GalleryBackup.Bar.AllCopied(0), GalleryBackup.bar(done, true, false, 0, 0, GalleryBackup.Wait.QUEUE))
        val off = GalleryBackup.merge(GalleryBackup.Input(account = emptyList(), locals = listOf(local(1, "a.jpg"), local(2, "b.jpg"))))
        assertEquals(GalleryBackup.Bar.Off(2), GalleryBackup.bar(off, false, false, 0, 0, GalleryBackup.Wait.QUEUE))
    }

    @Test fun whyItWaits() {
        assertEquals(GalleryBackup.Wait.WIFI, GalleryBackup.waitOf(wifiOnly = true, unmetered = false, chargingOnly = true, charging = false))
        assertEquals(GalleryBackup.Wait.CHARGING, GalleryBackup.waitOf(wifiOnly = true, unmetered = true, chargingOnly = true, charging = false))
        assertEquals(GalleryBackup.Wait.QUEUE, GalleryBackup.waitOf(wifiOnly = false, unmetered = false, chargingOnly = false, charging = false))
    }
}
