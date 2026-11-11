package io.github.magiszonekk.discordrive.core

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

/** What the phone says when the Safe's slot is not what it saw before: deleted (Missing) vs older (rollback). */
class SafeStoreTest {
    /** An instance that signs anyone in and answers the Safe's slot with (revision, blob). */
    private fun withSlot(revision: Long, blob: String?, f: (InstanceApi) -> Unit) {
        val slot = "{\"revision\":$revision,\"blob\":" + (if (blob == null) "null" else "\"$blob\"") + "}"
        MockWebServer().use { srv ->
            srv.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                    "/v1/auth/challenge" -> MockResponse().setBody("""{"challengeId":"c1","nonce":"n","instanceId":"i1","expiresAt":9999999999999}""")
                    "/v1/auth/login" -> MockResponse().setBody("""{"token":"t","ttlMs":600000}""")
                    "/v1/slots/safe" -> MockResponse().setBody(slot)
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":"not_found"}""")
                }
            }
            f(InstanceApi(srv.url("/").toString(), "acct1", "dev1", Ed25519Key.generate()))
        }
    }

    @Test
    fun deletedSafeIsMissingNotRollback() = withSlot(0, null) { api ->
        // The phone opened the Safe at revision 5 before; another device deleted it (the slot is empty again).
        val st = SafeStore(api, AccountKey.generate(), "acct1", seenRevision = 5)
        assertFalse(st.exists())
        assertThrows(SafeStore.Missing::class.java) { st.unlock("kot ma ale i psa 2026") }
        assertThrows(SafeStore.Missing::class.java) { st.unlockWithMaster(ByteArray(32)) }
    }

    @Test
    fun olderSafeIsStillRefused() = withSlot(3, "REVM=") { api ->
        val st = SafeStore(api, AccountKey.generate(), "acct1", seenRevision = 5)
        assertThrows(Safe.RollbackException::class.java) { st.exists() }
        assertThrows(Safe.RollbackException::class.java) { st.unlock("kot ma ale i psa 2026") }
    }
}
