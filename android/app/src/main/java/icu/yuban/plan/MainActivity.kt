package icu.yuban.plan

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.WindowInsetsController
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Toast

/**
 * Plan 的 Android 壳：只加载线上 PWA。
 *
 * 认证完全复用 plan 的 SSO：WebView 跟随 plan → chat authorize → plan callback
 * 的 302 链，Cookie 由系统 WebView 持久化。壳不注入 token、不读网页内容。
 */
class MainActivity : Activity() {

    companion object {
        // 末尾不带斜杠：避免 "$HOME/auth/native" 拼出 //auth/native 双斜杠路径
        private const val HOME = "https://plan.yuban.icu"
        private const val RELOAD_AFTER_MS = 30 * 60 * 1000L
        private const val BROKER_PACKAGE = "com.aichatt.app"
        private const val BROKER_ACTIVITY = "com.aichatt.app.PlanAuthActivity"
        private const val REQ_AUTH = 4101
        private const val AUTH_TIMEOUT_MS = 15_000L
        private val ALLOWED_HOSTS = setOf("plan.yuban.icu", "chat.yuban.icu")
    }

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorPanel: LinearLayout
    private lateinit var authButton: Button
    private var pausedAt = 0L
    private var authInFlight = false
    private var authReturned = false
    private var lastAuthCode: String? = null
    private val handler = Handler(Looper.getMainLooper())
    private val authTimeout = Runnable {
        if (authInFlight) {
            authReturned = true
            setAuthBusy(false)
            Log.w("PlanAuth", "broker timeout")
            Toast.makeText(this, "aichatt 授权超时，请重试或手动登录", Toast.LENGTH_LONG).show()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // 浅色背景必须配深色系统栏图标；部分 ROM/深色模式下主题属性不生效，这里显式设置
        val barColor = Color.parseColor("#F5F5F7")
        window.statusBarColor = barColor
        window.navigationBarColor = barColor
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(light, light)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = window.decorView.systemUiVisibility or
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }

        webView = findViewById(R.id.webview)
        progress = findViewById(R.id.progress)
        errorPanel = findViewById(R.id.error_panel)
        authButton = findViewById(R.id.auth_button)
        findViewById<Button>(R.id.retry).setOnClickListener {
            errorPanel.visibility = View.GONE
            webView.reload()
        }
        authButton.setOnClickListener { startBroker() }

        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(webView, true)

        webView.setBackgroundColor(Color.parseColor("#F5F5F7"))
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString PlanAndroid/${versionName()}"
        }

        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                val scheme = uri.scheme
                if ((scheme == "http" || scheme == "https") && uri.host in ALLOWED_HOSTS) {
                    return false
                }
                return openExternal(uri)
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                errorPanel.visibility = View.GONE
                progress.progress = 0
                progress.visibility = View.VISIBLE
                updateAuthButton(url)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                progress.visibility = View.GONE
                updateAuthButton(url)
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    progress.visibility = View.GONE
                    errorPanel.visibility = View.VISIBLE
                }
            }

            override fun onReceivedSslError(
                view: WebView,
                handler: SslErrorHandler,
                error: SslError
            ) {
                handler.cancel()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                if (newProgress >= 100) progress.visibility = View.GONE
            }
        }

        val authCode = intent?.getStringExtra("code")
        if (authCode.isNullOrBlank()) {
            webView.loadUrl(HOME)
        } else {
            handleAuthCode(authCode)
        }
    }

    /** 显式 Intent 通道：即使 onActivityResult 被任务切换取消，也能拿到 code */
    private fun handleAuthCode(code: String?) {
        if (code.isNullOrBlank() || code == lastAuthCode) return
        lastAuthCode = code
        authButton.visibility = View.GONE
        webView.loadUrl("$HOME/auth/native?code=${Uri.encode(code)}")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAuthCode(intent.getStringExtra("code"))
    }

    /** 登录页才显示授权按钮；plan 主页和 chat 主界面隐藏 */
    private fun updateAuthButton(url: String?) {
        val onLogin = url != null && (
            url.startsWith("https://chat.yuban.icu/login") ||
            url.startsWith("https://plan.yuban.icu/auth/login")
        )
        authButton.visibility = if (onLogin) View.VISIBLE else View.GONE
    }

    private fun setAuthBusy(busy: Boolean) {
        authInFlight = busy
        authButton.isEnabled = !busy
        authButton.text = getString(
            if (busy) R.string.auth_in_progress else R.string.auth_with_aichatt
        )
    }

    /** 显式按钮触发：向同签名的 aichatt App 要一次性 code */
    private fun startBroker() {
        if (authInFlight) return
        authReturned = false
        // 限定「本次授权流程」作用域：onNewIntent 先于 onActivityResult 到达，
        // 若显式回传通道已交出 code，标准 result 被任务切换破坏成 CANCELED 时静默收场
        lastAuthCode = null
        setAuthBusy(true)
        val intent = Intent().setComponent(ComponentName(BROKER_PACKAGE, BROKER_ACTIVITY))
        try {
            Log.w("PlanAuth", "starting broker")
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQ_AUTH)
            handler.postDelayed(authTimeout, AUTH_TIMEOUT_MS)
        } catch (e: ActivityNotFoundException) {
            Log.w("PlanAuth", "broker missing", e)
            setAuthBusy(false)
            Toast.makeText(this, "未安装新版 aichatt，请先更新 aichatt", Toast.LENGTH_LONG).show()
        } catch (e: SecurityException) {
            Log.w("PlanAuth", "broker denied", e)
            setAuthBusy(false)
            Toast.makeText(this, "aichatt 授权被系统拒绝", Toast.LENGTH_LONG).show()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_AUTH || authReturned) return
        authReturned = true
        handler.removeCallbacks(authTimeout)
        setAuthBusy(false)
        val code = data?.getStringExtra("code")
        val reason = data?.getStringExtra("reason")
        Log.w("PlanAuth", "result=$resultCode codeLen=${code?.length ?: 0} reason=$reason")
        if (resultCode == RESULT_OK && !code.isNullOrBlank()) {
            handleAuthCode(code)
        } else if (lastAuthCode != null) {
            // 显式回传通道已接管（code 已经 onNewIntent 进入并开始登录），
            // 此时的 CANCELED 是 startActivity(NEW_TASK) 破坏 result 传递的正常副产物，不提示
            updateAuthButton(webView.url)
        } else {
            Toast.makeText(this, "未能通过 aichatt 登录，请重试或手动登录", Toast.LENGTH_LONG).show()
            updateAuthButton(webView.url)
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(authTimeout)
        super.onDestroy()
    }

    private fun versionName(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0"
    } catch (_: Exception) {
        "1.0"
    }

    private fun openExternal(uri: Uri): Boolean = try {
        startActivity(Intent(Intent.ACTION_VIEW, uri))
        true
    } catch (_: ActivityNotFoundException) {
        false
    }

    /** Plan 是单页应用，返回键直接退出，避免退回 chat 的 SSO 中转页 */
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        finish()
    }

    override fun onPause() {
        super.onPause()
        pausedAt = SystemClock.elapsedRealtime()
        CookieManager.getInstance().flush()
    }

    override fun onResume() {
        super.onResume()
        // 长时间切后台后让页面重新走一次 SSO/同步，避免拿 12 小时前的旧会话发呆
        if (pausedAt > 0 && SystemClock.elapsedRealtime() - pausedAt > RELOAD_AFTER_MS) {
            webView.reload()
        }
    }
}
