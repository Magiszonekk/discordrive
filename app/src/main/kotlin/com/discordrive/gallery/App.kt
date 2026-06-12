package com.discordrive.gallery

import android.app.Application
import android.os.Build

class App : Application() {

    override fun onCreate() {
        super.onCreate()
        AppLog.init(this)
        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull()
        AppLog.i(
            "App",
            "start v$version · Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}) · " +
                "${Build.MANUFACTURER} ${Build.MODEL}",
        )

        // Persist fatal crashes before the system kills the process, then let
        // the default handler show the usual crash dialog.
        val systemHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            AppLog.e("FATAL", "uncaught exception on thread ${thread.name}", error)
            systemHandler?.uncaughtException(thread, error)
        }
    }
}
