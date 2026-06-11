pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "discordrive-gallery"

include(":core:crypto")
include(":core:api")

// The Android app module needs the Android SDK; core modules are pure JVM so
// crypto/API work can be built and tested on any machine with a JDK.
val androidSdkPresent = System.getenv("ANDROID_HOME") != null ||
    File(rootDir, "local.properties").let { it.exists() && it.readText().contains("sdk.dir") }
if (androidSdkPresent) {
    include(":app")
}
