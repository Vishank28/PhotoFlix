package com.photoflix.tv

import android.content.Context

/**
 * Saved settings: which PhotoFlix server to open (the TV page keeps the screen code too), and where to find the
 * server's new address after its PC restarts (a signed link to its link file in S3, given by the page).
 */
object Prefs {
    private const val FILE = "photoflix"
    private fun prefs(ctx: Context) = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun serverUrl(ctx: Context): String = prefs(ctx).getString("server", null) ?: BuildConfig.SERVER_URL

    fun setServerUrl(ctx: Context, url: String) = prefs(ctx).edit().putString("server", url.trim().trimEnd('/')).apply()

    fun linkFile(ctx: Context): String = prefs(ctx).getString("link", null) ?: ""
    fun screenCode(ctx: Context): String = prefs(ctx).getString("code", null) ?: ""

    fun setLink(ctx: Context, linkFile: String, code: String) = prefs(ctx).edit().putString("link", linkFile).putString("code", code).apply()
    fun setScreenCode(ctx: Context, code: String) = prefs(ctx).edit().putString("code", code).apply()
}
