plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Release signing from the environment (CI secrets): ANDROID_KEYSTORE_FILE (path to the keystore),
// ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD. Without them the release build is
// left unsigned. The key never lives in the repository: an APK signed with another key cannot update an
// installed one.
val releaseKeystore: String? = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }

android {
    namespace = "com.discordrive.gallery"
    compileSdk = 35

    defaultConfig {
        // Not the old gallery's ID, so both apps can be installed side by side.
        applicationId = "io.github.magiszonekk.discordrive"
        // 29+: MediaStore loadThumbnail + clean scoped storage
        minSdk = 29
        targetSdk = 35
        // CI sets a growing number (an update must have a higher versionCode than the installed one).
        versionCode = (System.getenv("ANDROID_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("ANDROID_VERSION_NAME") ?: "0.1.0-dev"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    packaging {
        // BouncyCastle and jspecify (via androidx.javascriptengine) ship the same OSGi manifest.
        resources.excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"
    }

    buildTypes {
        release {
            if (releaseKeystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(project(":core:crypto"))
    implementation(project(":core:api"))
    implementation(project(":syncjs"))
    implementation(libs.zxing.core)
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.media3:media3-datasource:1.4.1")
    implementation(libs.okhttp)
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.viewpager2:viewpager2:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)

    androidTestImplementation(testFixtures(project(":core:ddn")))
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.junit4)
    androidTestImplementation("androidx.test:core:1.6.1")
}
