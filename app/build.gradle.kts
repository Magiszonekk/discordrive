plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.discordrive.gallery"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.discordrive.gallery"
        // 29+: MediaStore loadThumbnail + clean scoped storage
        minSdk = 29
        targetSdk = 35
        versionCode = 12
        versionName = "0.7.1"
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
    implementation(libs.okhttp)
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.viewpager2:viewpager2:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)
}
