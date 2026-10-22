package io.github.magiszonekk.discordrive.core

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test

/** The interop scenario on the JVM (sync core over the harness RPC). Skipped unless started by the harness. */
class InteropTest {
    @Test
    fun phoneJoinsByPairingAndWorksWithTheWebClient() {
        val rpc = System.getenv("DDN_INTEROP_RPC")
        assumeTrue(System.getProperty("ddn.interop") != null && rpc != null, "started by apps/android/interop/harness.mts")
        val s = InteropScenario(rpc!!, System.getenv("DDN_INTEROP_SERVER")!!, System.getenv("DDN_INTEROP_DISCORD")!!)
        val r = s.run({ s.rpcReplica() }, "Pixel 7")
        assertTrue(r.values.all { it }, "interop checks: $r")
    }
}
