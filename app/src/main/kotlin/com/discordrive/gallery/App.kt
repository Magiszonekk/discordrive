package com.discordrive.gallery

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle

class App : Application() {

    override fun onCreate() {
        super.onCreate()
        AppLog.init(this)
        applyAccentToEveryActivity()
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

    /**
     * Overlays the user's chosen accent on every activity before it inflates,
     * so the colour pick applies app-wide without each screen opting in.
     * onActivityPreCreated runs before onCreate/setContentView (API 29+).
     */
    private fun applyAccentToEveryActivity() {
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityPreCreated(activity: Activity, savedInstanceState: Bundle?) {
                Settings.accentOverlay(activity)?.let { activity.theme.applyStyle(it, true) }
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }
}
