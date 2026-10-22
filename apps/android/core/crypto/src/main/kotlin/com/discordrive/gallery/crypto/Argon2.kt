package com.discordrive.gallery.crypto

import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters

data class Argon2Params(
    val memoryKB: Int,
    val iterations: Int,
    val parallelism: Int,
    val saltB64: String,
)

/**
 * Argon2id matching hash-wasm's output (Argon2 v1.3).
 *
 * Bouncy Castle is pure JVM, so the same implementation runs in unit tests and
 * on Android. If first-import performance becomes an issue on-device, swap in
 * a native binding behind this object — the test vectors guarantee parity.
 */
object Argon2 {
    fun hash(password: String, salt: ByteArray, params: Argon2Params, hashLength: Int = 32): ByteArray {
        val builder = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withMemoryAsKB(params.memoryKB)
            .withIterations(params.iterations)
            .withParallelism(params.parallelism)
            .withSalt(salt)

        val generator = Argon2BytesGenerator()
        generator.init(builder.build())
        val output = ByteArray(hashLength)
        generator.generateBytes(password.toByteArray(Charsets.UTF_8), output)
        return output
    }
}
