// Notemaker native helpers for Android, called from Rust (src/hw/android.rs) — never exposed to the page.
//   • android-keystore vault slots (docs/PLATFORMS.md): a non-exportable AES-256-GCM Keystore key that requires
//     user authentication for every use (BIOMETRIC_STRONG or DEVICE_CREDENTIAL), StrongBox when available.
//     BiometricPrompt is shown with a CryptoObject for both encrypt (create) and decrypt (unlock).
//   • files.save through the Storage Access Framework, .notemaker files opened with the app,
//     a "sensitive" clipboard, the screen-off lock trigger and the self-test log.
package com.mth.notemaker

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.provider.OpenableColumns
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class CreateKeyArgs {
  lateinit var alias: String
  lateinit var aad: String
  lateinit var vdk: String
  var title: String = "Notemaker"
}

@InvokeArg
class DecryptArgs {
  lateinit var alias: String
  lateinit var aad: String
  lateinit var iv: String
  lateinit var ct: String
  var title: String = "Notemaker"
}

@InvokeArg
class AliasArgs {
  lateinit var alias: String
}

@InvokeArg
class SaveFileArgs {
  lateinit var name: String
  lateinit var mime: String
  lateinit var path: String
}

@InvokeArg
class ClipboardArgs {
  lateinit var text: String
  var sensitive: Boolean = false
}

@InvokeArg
class LogArgs {
  lateinit var message: String
}

@TauriPlugin
class NotemakerPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    const val TAG = "NotemakerSelftest"
    const val KEYSTORE = "AndroidKeyStore"
    const val MAX_TRANSFER_BYTES = 1L shl 30
  }

  private var pendingIntent: Intent? = null
  private var pendingSave: SaveFileArgs? = null
  @Volatile private var screenOffAt: Long = 0
  @Volatile private var inBackground = false

  private val screenReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action == Intent.ACTION_SCREEN_OFF) screenOffAt = System.currentTimeMillis()
    }
  }

  override fun load(webView: WebView) {
    pendingIntent = activity.intent
    ContextCompat.registerReceiver(activity, screenReceiver, IntentFilter(Intent.ACTION_SCREEN_OFF), ContextCompat.RECEIVER_NOT_EXPORTED)
  }

  override fun onNewIntent(intent: Intent) {
    pendingIntent = intent
  }

  override fun onPause() { inBackground = true }
  override fun onResume() { inBackground = false }

  override fun onDestroy() {
    try { activity.unregisterReceiver(screenReceiver) } catch (_: Exception) {}
  }

  // ------------------------------------------------------------------ device / launch

  private fun deviceName(): String {
    val named = try { Settings.Global.getString(activity.contentResolver, Settings.Global.DEVICE_NAME) } catch (_: Exception) { null }
    if (!named.isNullOrBlank()) return named
    val m = Build.MODEL ?: "Android"
    val brand = (Build.MANUFACTURER ?: "").replaceFirstChar { it.uppercase() }
    return if (m.startsWith(brand, ignoreCase = true)) m else "$brand $m".trim()
  }

  @Command
  fun deviceName(invoke: Invoke) {
    invoke.resolve(JSObject().put("device", deviceName()))
  }

  @Command
  fun launchInfo(invoke: Invoke) {
    val selftest = BuildConfig.DEBUG && (activity.intent?.getBooleanExtra("notemaker.selftest", false) ?: false)
    // notemaker.selftest.hw: also create + unwrap a real Keystore slot (prompts; drive it with adb input)
    val hw = selftest && (activity.intent?.getBooleanExtra("notemaker.selftest.hw", false) ?: false)
    invoke.resolve(JSObject().put("selftest", selftest).put("hw", hw))
  }

  @Command
  fun takeScreenOff(invoke: Invoke) {
    val t = screenOffAt
    screenOffAt = 0
    invoke.resolve(JSObject().put("since", t))
  }

  @Command
  fun log(invoke: Invoke) {
    val a = invoke.parseArgs(LogArgs::class.java)
    Log.i(TAG, a.message)
    invoke.resolve()
  }

  // ------------------------------------------------------------------ android-keystore keyslots

  private fun strongBoxAvailable(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
      activity.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

  /** BIOMETRIC_STRONG | DEVICE_CREDENTIAL with a CryptoObject needs Android 11+; older: strong biometrics only. */
  private fun authenticators(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_STRONG

  @Command
  fun available(invoke: Invoke) {
    val r = BiometricManager.from(activity).canAuthenticate(authenticators())
    val ok = r == BiometricManager.BIOMETRIC_SUCCESS
    val o = JSObject().put("available", ok).put("strongBox", strongBoxAvailable()).put("device", deviceName())
    if (!ok) {
      o.put("detail", when (r) {
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "Set up a screen lock (PIN, pattern, password or fingerprint) first."
        BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE, BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "No usable biometric hardware."
        BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> "A security update is required."
        else -> "Screen-lock authentication is not available ($r)."
      })
    }
    invoke.resolve(o)
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  private fun generateKey(alias: String, strongBox: Boolean): SecretKey {
    val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      // timeout 0 = authenticate for every single use (CryptoObject)
      b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
    }
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) b.setIsStrongBoxBacked(true)
    val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    g.init(b.build())
    return g.generateKey()
  }

  private fun prompt(invoke: Invoke, cipher: Cipher, title: String, onOk: (Cipher) -> Unit, onFail: () -> Unit) {
    val fa = activity as? FragmentActivity ?: run { onFail(); invoke.reject("no-device"); return }
    fa.runOnUiThread {
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title)
        .setSubtitle("Notemaker vault")
        .setAllowedAuthenticators(authenticators())
        .apply { if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) setNegativeButtonText("Cancel") }
        .build()
      val bp = BiometricPrompt(fa, ContextCompat.getMainExecutor(fa), object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          val c = result.cryptoObject?.cipher
          if (c == null) { onFail(); invoke.reject("Authentication returned no cipher"); return }
          try { onOk(c) } catch (e: Exception) { onFail(); invoke.reject(cryptoError(e)) }
        }
        override fun onAuthenticationError(code: Int, msg: CharSequence) {
          onFail()
          invoke.reject(when (code) {
            BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_CANCELED -> "cancelled"
            BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "biometry-lockout"
            BiometricPrompt.ERROR_NO_BIOMETRICS, BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL, BiometricPrompt.ERROR_HW_NOT_PRESENT -> "no-device"
            else -> "Authentication error: $msg"
          })
        }
        // onAuthenticationFailed = one wrong finger; the prompt stays open.
      })
      bp.authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
  }

  private fun cryptoError(e: Exception): String = when (e) {
    is KeyPermanentlyInvalidatedException -> "biometry-changed"
    is javax.crypto.AEADBadTagException -> "not-this-device"
    else -> e.message ?: e.javaClass.simpleName
  }

  @Command
  fun createKey(invoke: Invoke) {
    val a = invoke.parseArgs(CreateKeyArgs::class.java)
    val vdk = Base64.decode(a.vdk, Base64.NO_WRAP)
    try {
      if (keyStore().containsAlias(a.alias)) keyStore().deleteEntry(a.alias)
      var strong = strongBoxAvailable()
      val key = try { generateKey(a.alias, strong) } catch (e: Exception) {
        if (strong && (e is StrongBoxUnavailableException || e.cause is StrongBoxUnavailableException || e is java.security.ProviderException)) {
          strong = false; generateKey(a.alias, false)
        } else throw e
      }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key) // the Keystore picks a fresh random 12-byte IV
      val del = { try { keyStore().deleteEntry(a.alias) } catch (_: Exception) {} }
      prompt(invoke, cipher, a.title, { c ->
        c.updateAAD(a.aad.toByteArray(Charsets.UTF_8))
        val ct = c.doFinal(vdk)
        vdk.fill(0)
        invoke.resolve(JSObject()
          .put("iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
          .put("ct", Base64.encodeToString(ct, Base64.NO_WRAP))
          .put("strongBox", strong))
      }, { vdk.fill(0); del() })
    } catch (e: Exception) {
      vdk.fill(0)
      try { keyStore().deleteEntry(a.alias) } catch (_: Exception) {}
      invoke.reject(cryptoError(e))
    }
  }

  @Command
  fun decrypt(invoke: Invoke) {
    val a = invoke.parseArgs(DecryptArgs::class.java)
    try {
      val key = keyStore().getKey(a.alias, null) as? SecretKey ?: run { invoke.reject("not-this-device"); return }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      try {
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(a.iv, Base64.NO_WRAP)))
      } catch (e: KeyPermanentlyInvalidatedException) {
        invoke.reject("biometry-changed"); return
      }
      prompt(invoke, cipher, a.title, { c ->
        c.updateAAD(a.aad.toByteArray(Charsets.UTF_8))
        val vdk = c.doFinal(Base64.decode(a.ct, Base64.NO_WRAP))
        invoke.resolve(JSObject().put("vdk", Base64.encodeToString(vdk, Base64.NO_WRAP)))
        vdk.fill(0)
      }, {})
    } catch (e: Exception) {
      invoke.reject(cryptoError(e))
    }
  }

  @Command
  fun deleteKey(invoke: Invoke) {
    val a = invoke.parseArgs(AliasArgs::class.java)
    try { keyStore().deleteEntry(a.alias) } catch (_: Exception) {}
    invoke.resolve()
  }

  // ------------------------------------------------------------------ files.save (Storage Access Framework)

  @Command
  fun saveFile(invoke: Invoke) {
    val a = invoke.parseArgs(SaveFileArgs::class.java)
    pendingSave = a
    val i = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = if (a.name.endsWith(".notemaker", true)) "application/octet-stream" else a.mime
      putExtra(Intent.EXTRA_TITLE, a.name)
    }
    startActivityForResult(invoke, i, "saveFileResult")
  }

  @ActivityCallback
  fun saveFileResult(invoke: Invoke, result: ActivityResult) {
    val a = pendingSave
    pendingSave = null
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null || a == null) {
      invoke.resolve(JSObject().put("saved", false)); return
    }
    Thread {
      try {
        activity.contentResolver.openOutputStream(uri, "wt")!!.use { out -> File(a.path).inputStream().use { it.copyTo(out) } }
        invoke.resolve(JSObject().put("saved", true).put("uri", uri.toString()))
      } catch (e: Exception) {
        invoke.reject("Couldn’t save: ${e.message}")
      }
    }.start()
  }

  // ------------------------------------------------------------------ .notemaker files opened with the app

  private fun displayName(uri: Uri): String? = try {
    activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }
  } catch (_: Exception) { null }

  private fun size(uri: Uri): Long = try {
    activity.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else -1L
    } ?: -1L
  } catch (_: Exception) { -1L }

  @Command
  fun takePendingFile(invoke: Invoke) {
    val intent = pendingIntent
    pendingIntent = null
    val uri: Uri? = when (intent?.action) {
      Intent.ACTION_VIEW -> intent.data
      Intent.ACTION_SEND -> if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                            else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
      else -> null
    }
    if (uri == null) { invoke.resolve(JSObject()); return }
    Thread {
      try {
        val name = (displayName(uri) ?: uri.lastPathSegment ?: "transfer").substringAfterLast('/')
        if (!name.endsWith(".notemaker", true)) {
          invoke.resolve(JSObject().put("error", "“$name” isn’t a Notemaker transfer file (they end in .notemaker)."))
          return@Thread
        }
        if (size(uri) > MAX_TRANSFER_BYTES) {
          invoke.resolve(JSObject().put("error", "“$name” is too large (transfer files can be at most 1 GB)."))
          return@Thread
        }
        val dir = File(activity.cacheDir, "incoming").apply { mkdirs() }
        val safe = name.replace(Regex("[/\\\\:*?\"<>|\\p{Cntrl}]"), "_")
        val out = File(dir, safe)
        var total = 0L
        activity.contentResolver.openInputStream(uri)!!.use { input ->
          out.outputStream().use { o ->
            val buf = ByteArray(1 shl 16)
            while (true) {
              val n = input.read(buf)
              if (n < 0) break
              total += n
              if (total > MAX_TRANSFER_BYTES) throw IllegalStateException("The file is larger than 1 GB.")
              o.write(buf, 0, n)
            }
          }
        }
        invoke.resolve(JSObject().put("fileName", safe).put("path", out.absolutePath))
      } catch (e: Exception) {
        invoke.resolve(JSObject().put("error", e.message ?: "Couldn’t read the file."))
      }
    }.start()
  }

  // ------------------------------------------------------------------ clipboard

  private fun clipboard() = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

  @Command
  fun clipboardWrite(invoke: Invoke) {
    val a = invoke.parseArgs(ClipboardArgs::class.java)
    activity.runOnUiThread {
      val clip = ClipData.newPlainText("Notemaker", a.text)
      if (a.sensitive) {
        // Android 13+: keeps the copied secret out of the clipboard preview / keyboard suggestions
        clip.description.extras = PersistableBundle().apply {
          putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
        }
      }
      clipboard().setPrimaryClip(clip)
      invoke.resolve()
    }
  }

  private fun currentText(): String? = try {
    clipboard().primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(activity)?.toString()
  } catch (_: Exception) { null }

  @Command
  fun clipboardClearIf(invoke: Invoke) {
    val a = invoke.parseArgs(ClipboardArgs::class.java)
    activity.runOnUiThread {
      if (currentText() == a.text) {
        if (Build.VERSION.SDK_INT >= 28) clipboard().clearPrimaryClip() else clipboard().setPrimaryClip(ClipData.newPlainText("", ""))
      }
      invoke.resolve()
    }
  }

  @Command
  fun clipboardRead(invoke: Invoke) {
    // Only readable while the app is in the foreground (Android 10+) — used by the self-test.
    activity.runOnUiThread { invoke.resolve(JSObject().put("text", currentText() ?: "")) }
  }
}
