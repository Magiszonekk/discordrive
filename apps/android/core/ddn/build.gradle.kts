// discordrive account and network layer for the phone, pure JVM (tested on any JDK): the same formats as
// packages/metadata-client (device keys, sealed objects, operation log, webhook vault, pairing, snapshots,
// the instance's HTTP API), checked against vectors generated from the TypeScript code.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    `java-test-fixtures`
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
}

dependencies {
    api(libs.kotlinx.serialization.json)
    implementation(libs.bouncycastle.prov)
    implementation(libs.okhttp)

    // The interop scenario (InteropScenario) is shared by the JVM test and the on-device test of :syncjs.
    testFixturesImplementation(libs.okhttp)
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.okhttp.mockwebserver)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    // The interop test runs only when a harness started the servers (apps/android/interop/harness.mts).
    providers.gradleProperty("ddnInterop").orNull?.let { systemProperty("ddn.interop", it) }
    testLogging { events("passed", "skipped", "failed"); showStandardStreams = true }
}
