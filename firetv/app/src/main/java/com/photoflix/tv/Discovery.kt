package com.photoflix.tv

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Finds the PhotoFlix PC on this TV's Wi-Fi, so a new TV needs no address typed in: asks every address of the TV's
 * own network (x.x.x.1-254) on port 3200 for /api/info, and takes the one that answers app: "photoflix".
 * A few seconds; call it off the UI thread. The PC's firewall must let port 3200 in.
 */
object Discovery {
    private const val PORT = 3200

    fun find(): String? {
        val me = ownAddress() ?: return null
        val b = me.address
        val net = "${b[0].toInt() and 255}.${b[1].toInt() and 255}.${b[2].toInt() and 255}."
        val found = AtomicReference<String?>(null)
        val pool = Executors.newFixedThreadPool(48)
        for (i in 1..254) {
            val ip = net + i
            if (ip == me.hostAddress) continue
            pool.execute { if (found.get() == null && isPhotoFlix(ip)) found.compareAndSet(null, "http://$ip:$PORT") }
        }
        pool.shutdown()
        pool.awaitTermination(15, TimeUnit.SECONDS)
        pool.shutdownNow()
        Log.i(TAG, "PhotoFlix on ${net}x: ${found.get() ?: "not found"}")
        return found.get()
    }

    private fun isPhotoFlix(ip: String): Boolean = try {
        val c = URL("http://$ip:$PORT/api/info").openConnection() as HttpURLConnection
        c.connectTimeout = 700
        c.readTimeout = 1500
        c.useCaches = false
        val ok = c.responseCode == 200 && JSONObject(c.inputStream.bufferedReader().use { it.readText() }).optString("app") == "photoflix"
        c.disconnect()
        ok
    } catch (e: Exception) { false }

    /** The TV's own address on its Wi-Fi / network cable. */
    private fun ownAddress(): Inet4Address? = try {
        NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }.filterIsInstance<Inet4Address>().firstOrNull { it.isSiteLocalAddress }
    } catch (e: Exception) { null }
}
