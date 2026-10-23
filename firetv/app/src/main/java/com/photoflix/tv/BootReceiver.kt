package com.photoflix.tv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Waiting-room TV: open PhotoFlix again when the TV is switched on (power cut, reboot, app update). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Prefs.serverUrl(context).isBlank()) return // not set up yet
        try {
            context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            // Newer Fire OS may block this without "Display over other apps"; see photoflix/firetv/README.md.
        }
    }
}
