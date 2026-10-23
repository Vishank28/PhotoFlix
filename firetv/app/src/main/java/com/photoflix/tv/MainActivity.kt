package com.photoflix.tv

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.text.InputType
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/**
 * Full-screen WebView showing the PhotoFlix TV screen (/tv/): photo slideshow + "Token 12, please go to Room 2".
 * Native extras: announcements are spoken with Android's text-to-speech (window.PhotoFlixTV.speak),
 * sound works without pressing a button first, and the screen never sleeps.
 *
 * Remote: OK = show the staff QR, Back = hide it (Back again = home screen), Menu (≡) = screen name, room and server address.
 */
internal const val TAG = "PhotoFlix"

class MainActivity : AppCompatActivity(), TextToSpeech.OnInitListener {

    private lateinit var web: WebView
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // adb shell am start -n com.photoflix.tv/.MainActivity --es url http://192.168.0.164:3200
        intent.getStringExtra("url")?.let { if (it.startsWith("http")) Prefs.setServerUrl(this, it) }

        tts = TextToSpeech(this, this)
        // Fire TV plays video on its own layer *behind* the WebView, so the WebView must be see-through
        // (the page itself is dark; the window behind it is black). An opaque WebView hides every video.
        window.setBackgroundDrawable(ColorDrawable(Color.BLACK))
        web = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            isFocusable = true
            isFocusableInTouchMode = true
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false // chime plays without a button press
                cacheMode = WebSettings.LOAD_DEFAULT
                useWideViewPort = true
                loadWithOverviewMode = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                userAgentString = settings.userAgentString + " FireTV PhotoFlixApp"
            }
            addJavascriptInterface(Bridge(), "PhotoFlixTV")
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) showError(view)
                }
            }
        }
        setContentView(web)
        goImmersive()

        val saved = Prefs.serverUrl(this)
        when {
            saved.isBlank() -> lookForServer(firstStart = true) // a new TV: find the PhotoFlix PC on the Wi-Fi
            saved.contains(".trycloudflare.com") -> { load(); lookForServer(firstStart = false) } // the PC on the Wi-Fi is faster and never changes
            else -> load()
        }
    }

    private fun load() = web.loadUrl(Prefs.serverUrl(this) + "/tv/")

    /** Opens [url] keeping this TV's screen (the page keeps its code per address, so it is passed along). */
    private fun open(url: String) {
        Prefs.setServerUrl(this, url)
        val code = Prefs.screenCode(this)
        web.loadUrl(url + "/tv/" + if (code.isNotBlank()) "?s=$code" else "")
    }

    /** Looks for the PhotoFlix PC on this Wi-Fi and opens it; on a first start without one, asks for the address. */
    private fun lookForServer(firstStart: Boolean) {
        if (firstStart) message("Looking for the PhotoFlix PC on this Wi-Fi…", "Keep the PhotoFlix PC on and on the same Wi-Fi.")
        Thread {
            val url = Discovery.find()
            runOnUiThread {
                when {
                    url != null && url != Prefs.serverUrl(this) -> open(url)
                    url == null && firstStart -> askServerUrl()
                }
            }
        }.start()
    }

    private fun message(title: String, text: String) {
        val html = """
            <html><body style="margin:0;background:#0B0B0D;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">
            <div><h1 style="color:#E8453C">$title</h1><p>$text</p></div></body></html>
        """.trimIndent()
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    // ---------------------------------------------------------------- voice announcements
    override fun onInit(status: Int) {
        val engine = tts ?: return
        if (status != TextToSpeech.SUCCESS) { Log.w(TAG, "text-to-speech failed to start: $status"); return }
        // A voice that is really on the TV. Asking for a language is not enough: Fire TV says Indian English is
        // "available" (it only has the language, not that country's voice) and then says nothing at all.
        val voice = pickVoice(engine)
        if (voice != null) engine.voice = voice else engine.language = Locale.US
        engine.setSpeechRate(0.9f)
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) { Log.i(TAG, "speaking $id") }
            override fun onDone(id: String?) { Log.i(TAG, "spoken $id") }
            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) { Log.w(TAG, "speech failed $id") }
            override fun onError(id: String?, errorCode: Int) { Log.w(TAG, "speech failed $id: $errorCode") }
        })
        Log.i(TAG, "voice: ${engine.voice?.name} (${engine.voice?.locale}), engine ${engine.defaultEngine}, " +
            "${try { engine.voices?.size } catch (e: Exception) { "?" }} voices, languages " +
            "${try { engine.availableLanguages?.joinToString() } catch (e: Exception) { "?" }}, " +
            "en-US ${engine.isLanguageAvailable(Locale.US)} en-GB ${engine.isLanguageAvailable(Locale.UK)} en-IN ${engine.isLanguageAvailable(Locale("en", "IN"))}")
        ttsReady = true
    }

    /** An installed English voice that works without internet: Indian English first, then US, then any English. */
    private fun pickVoice(engine: TextToSpeech): Voice? {
        val all = try { engine.voices } catch (e: Exception) { null } ?: return null
        val usable = all.filter {
            it.locale.language == "en" && !it.isNetworkConnectionRequired &&
                TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in it.features
        }
        return usable.firstOrNull { it.locale.country == "IN" }
            ?: usable.firstOrNull { it.locale.country == "US" }
            ?: usable.firstOrNull()
    }

    /** Called from tv.js. */
    inner class Bridge {
        @JavascriptInterface
        fun canSpeak(): Boolean = ttsReady

        /** Speaks [text] after anything already being said. */
        @JavascriptInterface
        fun speak(text: String) {
            if (!ttsReady) return
            val r = tts?.speak(text.take(300), TextToSpeech.QUEUE_ADD, null, "pf-" + System.nanoTime())
            if (r != TextToSpeech.SUCCESS) Log.w(TAG, "speak refused: $r")
        }

        @JavascriptInterface
        fun stop() {
            tts?.stop()
        }

        /** The page reached its server at [url]: open that address next time (it moves when the PC restarts). */
        @JavascriptInterface
        fun setServer(url: String) {
            if (url.startsWith("http") && url != Prefs.serverUrl(this@MainActivity)) Prefs.setServerUrl(this@MainActivity, url)
        }

        /** Where the server keeps its current address ([linkFile], a signed S3 link), and this TV's screen code. */
        @JavascriptInterface
        fun setLink(linkFile: String, code: String) {
            if (linkFile.startsWith("https://") && code.isNotBlank()) Prefs.setLink(this@MainActivity, linkFile, code)
        }

        /** This TV's screen code, so it stays the same screen if the app has to open another address. */
        @JavascriptInterface
        fun setScreen(code: String) {
            if (code.isNotBlank() && code != Prefs.screenCode(this@MainActivity)) Prefs.setScreenCode(this@MainActivity, code)
        }
    }

    // ---------------------------------------------------------------- the server moved (its PC restarted)
    private var lastRecover = 0L

    /**
     * The saved address does not answer: look for the PhotoFlix PC on the Wi-Fi (its address may have changed),
     * else read the server's current Cloudflare link from its link file, and go there.
     */
    private fun recover() {
        if (System.currentTimeMillis() - lastRecover < 45_000) return
        lastRecover = System.currentTimeMillis()
        Thread {
            val url = Discovery.find() ?: readLinkFile()
            if (url != null && url.startsWith("http") && url != Prefs.serverUrl(this)) {
                Log.i(TAG, "server moved to $url")
                runOnUiThread { open(url) }
            }
        }.start()
    }

    private fun readLinkFile(): String? {
        val linkFile = Prefs.linkFile(this)
        if (linkFile.isBlank()) return null
        return try {
            val c = URL(linkFile).openConnection() as HttpURLConnection
            c.connectTimeout = 10_000
            c.readTimeout = 10_000
            c.useCaches = false
            val body = c.inputStream.bufferedReader().use { it.readText() }
            JSONObject(body).optString("url").trimEnd('/').ifBlank { null }
        } catch (e: Exception) { Log.w(TAG, "link file: ${e.message}"); null }
    }

    // ---------------------------------------------------------------- Menu: screen name, room, server address
    private fun showSettings() {
        if (Prefs.serverUrl(this).isBlank()) { askServerUrl(); return }
        // Current name / room come from the page (tv.js); if the page is not loaded they start empty.
        web.evaluateJavascript("window.pfSettings ? window.pfSettings() : ''") { raw ->
            var name = ""
            var room = ""
            try {
                val json = JSONObject(JSONObject("{\"v\":$raw}").getString("v")) // raw is a quoted JSON string
                name = json.optString("name")
                room = json.optString("room")
            } catch (e: Exception) { /* page not ready */ }
            val pad = (16 * resources.displayMetrics.density).toInt()
            fun label(text: String) = TextView(this).apply { this.text = text; setPadding(0, pad / 2, 0, 0) }
            val nameIn = EditText(this).apply { setSingleLine(); hint = "e.g. OPD waiting hall (optional)"; setText(name) }
            val roomIn = EditText(this).apply { setSingleLine(); hint = "e.g. Room 2"; setText(room) }
            val urlIn = EditText(this).apply { setSingleLine(); inputType = InputType.TYPE_TEXT_VARIATION_URI; setText(Prefs.serverUrl(this@MainActivity)) }
            val box = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, 0, pad, 0)
                addView(label("Screen name")); addView(nameIn)
                addView(label("Room / counter (said when a token is called)")); addView(roomIn)
                addView(label("PhotoFlix server address")); addView(urlIn)
            }
            AlertDialog.Builder(this)
                .setTitle("Screen settings")
                .setView(box)
                .setPositiveButton("Save") { _, _ ->
                    val url = urlIn.text.toString().trim().trimEnd('/')
                    web.evaluateJavascript("window.pfApplySettings && window.pfApplySettings(" +
                            JSONObject.quote(nameIn.text.toString().trim()) + "," + JSONObject.quote(roomIn.text.toString().trim()) + ")", null)
                    if (url.startsWith("http") && url != Prefs.serverUrl(this)) {
                        Prefs.setServerUrl(this, url)
                        web.postDelayed({ load() }, 500) // after the name / room were sent
                    }
                }
                .setNegativeButton("Cancel", null)
                .show()
        }
    }

    // ---------------------------------------------------------------- server address
    private fun askServerUrl() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(Prefs.serverUrl(this@MainActivity).ifBlank { "http://" })
            setSelection(text.length)
        }
        AlertDialog.Builder(this)
            .setTitle("PhotoFlix server address")
            .setMessage("No PhotoFlix PC found on this Wi-Fi. Type the address the PhotoFlix server prints, e.g. http://192.168.1.140:3200, " +
                "or check that the PC is on and on the same Wi-Fi and look again.")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                val url = input.text.toString().trim().trimEnd('/')
                if (url.startsWith("http")) open(url) else askServerUrl()
            }
            .setNeutralButton("Look again") { _, _ -> lookForServer(firstStart = true) }
            .setCancelable(false)
            .show()
    }

    private fun showError(view: WebView) {
        val html = """
            <html><body style="margin:0;background:#0B0B0D;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">
            <div><h1 style="color:#E8453C">Can't reach PhotoFlix</h1>
            <p>Check the internet connection, and that the PhotoFlix server is running.</p>
            <p style="opacity:.7">${Prefs.serverUrl(this)}</p>
            <p>Press <b>OK</b> to try again, or <b>Menu (≡)</b> to change the address.</p></div></body></html>
        """.trimIndent()
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        recover() // the PC may have a new address (on the Wi-Fi, or a new Cloudflare link after a restart)
        // Keep trying by itself too (e.g. Wi-Fi coming back after a power cut).
        view.postDelayed({ if (web.url?.startsWith("data:") == true) load() }, 30_000)
    }

    // ---------------------------------------------------------------- screen + remote
    private fun goImmersive() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU) { showSettings(); return true }
        // OK on the error page retries; elsewhere the page shows the staff QR.
        if ((keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) && web.url?.startsWith("data:") == true) {
            load()
            return true
        }
        // Back: hides the staff QR if it is showing (tv.js), otherwise goes to the TV home screen.
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            web.evaluateJavascript("window.pfBack ? window.pfBack() : false") { hid -> if (hid != "true") moveTaskToBack(true) }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        tts?.shutdown()
        web.destroy()
        super.onDestroy()
    }
}
