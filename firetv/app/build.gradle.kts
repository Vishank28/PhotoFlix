plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.photoflix.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.photoflix.tv"
        minSdk = 22            // Fire OS 5 and newer
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        val url = ((project.findProperty("serverUrl") as String?) ?: "").trimEnd('/')
        buildConfigField("String", "SERVER_URL", "\"$url\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
