package com.discordrive.gallery

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * The app's texts are Polish, but Android picks the plural form by the phone's locale: on an English phone
 * 2 is "other" ("2 pliku ma") instead of "few" ("2 pliki mają"). The plural form is taken with Polish rules
 * whatever the phone's language.
 */
private var plRes: android.content.res.Resources? = null

fun Context.plq(id: Int, n: Int, vararg args: Any): String {
    val r = plRes ?: createConfigurationContext(Configuration(resources.configuration).apply { setLocale(Locale.forLanguageTag("pl-PL")) }).resources.also { plRes = it }
    return r.getQuantityString(id, n, *args)
}
