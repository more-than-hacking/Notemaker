package com.mth.notemaker

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.max
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  // Edge-to-edge: the page draws behind the status/navigation bars, so it needs their sizes
  // (Android WebView doesn't reliably report env(safe-area-inset-*)). Sizes are in CSS px.
  @Volatile private var insetsJson = """{"top":0,"right":0,"bottom":0,"left":0}"""
  private var lightBars: Boolean? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // Read-only sizes + status-bar icon colour. Nothing else is exposed to the page.
    webView.addJavascriptInterface(SystemBars(), "NotemakerSystemBars")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val d = resources.displayMetrics.density
      fun css(px: Int) = (px / d).roundToInt()
      val json = """{"top":${css(bars.top)},"right":${css(bars.right)},"bottom":${css(max(bars.bottom, ime.bottom))},"left":${css(bars.left)}}"""
      if (json != insetsJson) {
        insetsJson = json
        (v as WebView).evaluateJavascript("window.__notemakerInsets && window.__notemakerInsets($json)", null)
      }
      ViewCompat.onApplyWindowInsets(v, insets)
    }
    ViewCompat.requestApplyInsets(webView)
  }

  private inner class SystemBars {
    @JavascriptInterface
    fun insets(): String = insetsJson

    /** true = light page background → dark status/navigation bar icons. */
    @JavascriptInterface
    fun setLightBackground(light: Boolean) {
      runOnUiThread {
        if (lightBars == light) return@runOnUiThread
        lightBars = light
        WindowCompat.getInsetsController(window, window.decorView).apply {
          isAppearanceLightStatusBars = light
          isAppearanceLightNavigationBars = light
        }
      }
    }
  }
}
