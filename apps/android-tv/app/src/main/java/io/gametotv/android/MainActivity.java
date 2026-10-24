package io.gametotv.android;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * «Juegos del Salón»: a fullscreen WebView with the TV page of the game server
 * that runs inside the TV (NodeService, process :node).
 *
 *  onStart  shows assets/loading.html, starts NodeService if /info does not
 *           answer (or restarts it if the TV's IP changed), waits for
 *           http://127.0.0.1:8090/info and opens http://127.0.0.1:8090/
 *
 * Automatic game updates (Updater, BundleStore, BundlePolicy): before
 * starting the server, up to 4 s to ask GitHub for a newer game bundle; if
 * there is one it is downloaded («Actualizando los juegos… 45 %»), checked and
 * tried. If /info answers with its version within 30 s it stays; if Node dies
 * or does not answer, the app goes back to the previous bundle (or the APK's)
 * and never uses that version again. With no network or a slow GitHub the
 * games start at once, and the check runs again in the background once they
 * are open (the download is then used on the next start).
 *  onStop   unloads the page (about:blank): its WebSocket closes, so the
 *           server counts no TV screen and shuts down after 15 min without
 *           players (src/tv-service/android.js), ending the :node process
 *
 * Keys (see Keys.java): arrows and OK go to the page as ArrowX / Enter.
 * Back sends Escape (the page's «Back»); at the main menu, a second Back
 * within 2 s exits. Media keys: play/pause = OK, stop = Back, rewind/forward = arrows.
 */
public class MainActivity extends Activity {
    private static final String TAG = "g2t";
    static final String BASE = "http://127.0.0.1:" + NodeService.PORT;
    private static final String LOADING = "file:///android_asset/loading.html";
    private static final long START_TIMEOUT_MS = 120_000;   // first run: copy files + cold start on a slow TV
    private static final long EXIT_WINDOW_MS = 2000;
    private static final long CHECK_MS = 4000;               // asking GitHub before starting: never longer
    private static final long TRIAL_TIMEOUT_MS = 30_000;     // a new game bundle must answer /info by then
    private static final long DOWNLOAD_MAX_MS = 120_000;     // with the progress on screen
    private static final AtomicBoolean downloading = new AtomicBoolean();
    private static final String JS_WHERE = "(function(){try{var t=window.__tv;if(!t)return 'none';" +
            "if(t.atMainMenu)return t.atMainMenu()?'main':'other';return t.screen()==='menu'?'main':'other';}catch(e){return 'none';}})()";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private ExecutorService io;
    private ExecutorService bg;          // background update check (never delays the start)
    private BundleStore bundles;
    private volatile boolean checked;    // this launch already asked for updates
    private WebView web;
    private volatile int gen;            // bumped to cancel the current wait
    private boolean onServerPage;        // main thread only
    private boolean loadingReady;
    private String pendingState;
    private volatile boolean failed;
    private long lastBackAt;
    private String path = "/";
    private int idleMin;                 // tests only: `am start … --ei idleMin 1` (default 15, NodeService)
    private String version = "?";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        try { version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { /* noop */ }
        path = pathFrom(getIntent());
        idleMin = getIntent() != null ? getIntent().getIntExtra(NodeService.EXTRA_IDLE_MIN, 0) : 0;
        io = Executors.newSingleThreadExecutor();
        bg = Executors.newSingleThreadExecutor();
        bundles = BundleStore.get(this);
        // `game-to-tv tv perf` measures FPS through DevTools (adb forward … webview_devtools_remote_<pid>)
        WebView.setWebContentsDebuggingEnabled(true);
        web = createWebView();
        setContentView(web);
        hideSystemUi();
    }

    private WebView createWebView() {
        WebView w = new WebView(this);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);          // honour <meta name="viewport">
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);                  // ignore the TV's accessibility font size: the page scales itself
        s.setUserAgentString(s.getUserAgentString() + " JuegosDelSalon-Android/" + version);
        w.setBackgroundColor(0xFF070915);
        w.setOverScrollMode(View.OVER_SCROLL_NEVER);
        w.setVerticalScrollBarEnabled(false);
        w.setHorizontalScrollBarEnabled(false);
        w.setFocusable(true);
        w.setFocusableInTouchMode(true);
        w.setWebViewClient(new Client());
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public Bitmap getDefaultVideoPoster() {
                // The page's tiny keep-alive <video> would otherwise show a grey «play» icon
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, "página: " + m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        return w;
    }

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onStart() {
        super.onStart();
        web.onResume();
        web.resumeTimers();
        startFlow(false);
    }

    @Override
    protected void onStop() {
        gen++;
        if (onServerPage) {
            // Leave no TV page connected in the background: the server's idle
            // shutdown (15 min without screen or players) can then kick in
            onServerPage = false;
            web.loadUrl("about:blank");
        }
        loadingReady = false;
        web.onPause();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        gen++;
        io.shutdownNow();
        bg.shutdownNow();
        ViewGroup parent = (ViewGroup) web.getParent();
        if (parent != null) parent.removeView(web);
        web.destroy();
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String p = pathFrom(intent);
        if (!p.equals(path)) {
            path = p;
            if (onServerPage) web.loadUrl(BASE + path);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    /** `adb shell am start … --es path /ambiente` (game-to-tv tv open --ruta) */
    private static String pathFrom(Intent i) {
        String p = i != null ? i.getStringExtra("path") : null;
        return p != null && p.startsWith("/") ? p : "/";
    }

    @SuppressWarnings("deprecation")
    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    // ------------------------------------------------------------------ server start

    /** Shows the loading page and waits for the server (starting or restarting it). */
    private void startFlow(final boolean restart) {
        final int g = ++gen;
        failed = false;
        checked = false;
        showLoading();
        state("Preparando los juegos…", "La tele está poniendo en marcha su servidor.", false, "");
        io.execute(new Runnable() {
            @Override public void run() { ensureServer(g, restart); }
        });
    }

    private void ensureServer(int g, boolean restart) {
        Net.Result net = Net.lanIp(this);
        Log.i(TAG, "IP de la tele: " + net);
        JSONObject info = restart ? null : fetchInfo(1500);
        if (info != null && net.ip != null && !net.ip.equals(info.optString("ip"))) {
            Log.i(TAG, "La IP ha cambiado (" + info.optString("ip") + " -> " + net.ip + "): se reinicia el servidor");
            state("La tele ha cambiado de dirección", "Reiniciando el servidor para que el QR sea el bueno…", false, "");
            info = null;
            restart = true;
        }
        if (info != null) { serverUp(g, info); return; }
        if (restart) stopNode();
        BundlePolicy.Choice launch = null;
        if (!nodeAlive()) {
            quickUpdate(g, net);
            if (g != gen) return;
            launch = bundles.choose();
            startNode(net, launch);
        }

        long t0 = SystemClock.uptimeMillis();
        boolean slow = false;
        boolean seen = false;
        int relaunches = 0;
        while (g == gen) {
            JSONObject inf = fetchInfo(1500);
            if (inf != null) { serverUp(g, inf); return; }
            long el = SystemClock.uptimeMillis() - t0;
            boolean alive = nodeAlive();
            seen |= alive;
            if (launch != null && launch.downloaded()) {
                // A downloaded bundle that does not come up: back to the previous one (or the APK's)
                boolean died = seen ? !alive : el > 10000;
                long limit = launch.trial ? TRIAL_TIMEOUT_MS : START_TIMEOUT_MS;
                if (died || el > limit) {
                    String why = died ? "el servidor se ha cerrado" : "no responde en " + limit / 1000 + " s";
                    state("La actualización de los juegos no ha funcionado", "Volviendo a la versión anterior…", false, "");
                    stopNode();
                    bundles.markBad(launch.info.version, why);
                    if (g != gen) return;
                    launch = bundles.choose();
                    startNode(net, launch);
                    t0 = SystemClock.uptimeMillis();
                    seen = false;
                    slow = false;
                    continue;
                }
            }
            if (!slow && el > 6000) {
                slow = true;
                state("Preparando los juegos…", "La primera vez, o después de actualizar la app, tarda un poco más.", false, "");
            }
            if (el > 15000 && !alive) {
                if (relaunches++ >= 2) { fail(g, "El servidor de la tele se ha cerrado al arrancar."); return; }
                Log.w(TAG, "El proceso :node no está: se arranca otra vez");
                if (launch == null) launch = bundles.choose();
                startNode(net, launch);
            }
            if (el > START_TIMEOUT_MS) { fail(g, "El servidor de la tele no responde en " + BASE + "."); return; }
            SystemClock.sleep(300);
        }
    }

    /** /info answered: confirm a new bundle if it is the one running, open the page, look for updates. */
    private void serverUp(int g, JSONObject info) {
        JSONObject tele = info.optJSONObject("tele");
        JSONObject b = tele != null ? tele.optJSONObject("bundle") : null;
        if (b != null) {
            Log.i(TAG, "Servidor en marcha con los juegos " + b.optString("version") + " (" + b.optString("source") + ")");
            bundles.confirm(b.optString("version", null));
        }
        openWhenCurrent(g);
        backgroundUpdate();
    }

    // ------------------------------------------------------------------ automatic updates

    /**
     * Before a cold start: at most CHECK_MS asking for bundle.json. If there
     * is a newer bundle for this app, downloads it with the progress on the
     * loading screen. Any problem: start what there is, right away.
     */
    private void quickUpdate(final int g, Net.Result net) {
        if (net.ip == null) { Log.i(TAG, "Sin red: no se buscan actualizaciones"); return; }
        String base = Updater.baseUrl();
        if (base == null) { checked = true; return; }
        Updater.Remote r = Updater.fetchManifest(base, CHECK_MS);
        if (r == null || g != gen) return;   // slow or offline: checked again in the background later
        checked = true;
        String why = bundles.whyNotDownload(r.info);
        if (why != null) { Log.i(TAG, "Actualizaciones: " + r.info.version + ": " + why); return; }
        if (!downloading.compareAndSet(false, true)) return;
        File zip = null;
        try {
            state("Actualizando los juegos…", "Hay juegos nuevos o arreglos. Solo tarda un momento.", false, "");
            zip = Updater.download(this, base, r, new Updater.Progress() {
                @Override public void percent(int p) {
                    state("Actualizando los juegos… " + p + " %", "Hay juegos nuevos o arreglos. Solo tarda un momento.", false, "");
                }
            }, DOWNLOAD_MAX_MS, new Updater.Cancel() {
                @Override public boolean cancelled() { return g != gen; }
            });
            bundles.install(r.info, zip);
            state("Juegos actualizados", "Poniéndolos en marcha…", false, "");
        } catch (Exception e) {
            Log.w(TAG, "No se pudo actualizar a " + r.info.version + ": " + e.getMessage());
            state("Preparando los juegos…", "La tele está poniendo en marcha su servidor.", false, "");
        } finally {
            downloading.set(false);
            if (zip != null) //noinspection ResultOfMethodCallIgnored
                zip.delete();
        }
    }

    /** Games open and no answer from GitHub yet this time: check and download quietly, for the next start. */
    private void backgroundUpdate() {
        if (checked) return;
        checked = true;
        final Context c = getApplicationContext();
        try {
            bg.execute(new Runnable() {
                @Override public void run() {
                    String base = Updater.baseUrl();
                    if (base == null) return;
                    Updater.Remote r = Updater.fetchManifest(base, 20000);
                    if (r == null) return;
                    String why = bundles.whyNotDownload(r.info);
                    if (why != null) { Log.i(TAG, "Actualizaciones (en segundo plano): " + r.info.version + ": " + why); return; }
                    if (!downloading.compareAndSet(false, true)) return;
                    File zip = null;
                    try {
                        zip = Updater.download(c, base, r, null, 10 * 60_000L, new Updater.Cancel() {
                            @Override public boolean cancelled() { return Thread.currentThread().isInterrupted(); }
                        });
                        bundles.install(r.info, zip);
                        Log.i(TAG, "Los juegos " + r.info.version + " se usarán la próxima vez que arranque el servidor");
                    } catch (Exception e) {
                        Log.w(TAG, "No se pudo descargar " + r.info.version + " en segundo plano: " + e.getMessage());
                    } finally {
                        downloading.set(false);
                        if (zip != null) //noinspection ResultOfMethodCallIgnored
                            zip.delete();
                    }
                }
            });
        } catch (RuntimeException e) {
            // Activity being destroyed
        }
    }

    private void openWhenCurrent(final int g) {
        ui.post(new Runnable() {
            @Override public void run() {
                if (g != gen || isFinishing()) return;
                onServerPage = true;
                failed = false;
                lastBackAt = 0;
                web.loadUrl(BASE + path);
                web.requestFocus();
            }
        });
    }

    private void fail(int g, String why) {
        if (g != gen) return;
        failed = true;
        String detail = readEstadoError();
        Log.w(TAG, why + (detail != null ? " " + detail : ""));
        state("No se han podido abrir los juegos", why + (detail != null ? "\n" + detail : ""), true,
                "· Pulsa <b>OK</b> para reintentar · <b>Atrás</b> para salir.<br>" +
                "· Desde el PC: <b>game-to-tv tv status NOMBRE --logs</b> o <b>adb logcat -s g2t g2t-node</b>.<br>" +
                "· Si la tele va justa de memoria, cierra otras apps (o reiníciala) y vuelve a probar.");
    }

    private String readEstadoError() {
        String txt = NodeBundle.readText(new File(NodeBundle.dataDir(this), "estado.json"));
        if (txt == null) return null;
        try {
            JSONObject o = new JSONObject(txt);
            return "error".equals(o.optString("state")) ? o.optString("error", null) : null;
        } catch (Exception e) {
            return null;
        }
    }

    private void startNode(Net.Result net, BundlePolicy.Choice bundle) {
        Intent i = new Intent(this, NodeService.class).setAction(NodeService.ACTION_START);
        if (net.ip != null) i.putExtra(NodeService.EXTRA_HOST_IP, net.ip).putExtra(NodeService.EXTRA_NET, net.kind);
        if (idleMin > 0) i.putExtra(NodeService.EXTRA_IDLE_MIN, idleMin);
        if (bundle != null && bundle.downloaded()) {
            i.putExtra(NodeService.EXTRA_BUNDLE_DIR, bundles.dir(bundle.info.version).getAbsolutePath())
                    .putExtra(NodeService.EXTRA_BUNDLE_VERSION, bundle.info.version);
        }
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (RuntimeException e) {
            Log.e(TAG, "No se pudo arrancar NodeService", e);
        }
    }

    /** Asks the :node process to end and waits (up to 5 s) until it is gone. */
    private void stopNode() {
        if (!nodeAlive()) return;
        try {
            startService(new Intent(this, NodeService.class).setAction(NodeService.ACTION_STOP));
        } catch (RuntimeException e) {
            Log.w(TAG, "No se pudo parar NodeService", e);
        }
        long t0 = SystemClock.uptimeMillis();
        while (nodeAlive() && SystemClock.uptimeMillis() - t0 < 5000) SystemClock.sleep(100);
        SystemClock.sleep(300);
    }

    private boolean nodeAlive() {
        ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        List<ActivityManager.RunningAppProcessInfo> procs = am.getRunningAppProcesses();
        if (procs == null) return false;
        String name = getPackageName() + ":node";
        for (ActivityManager.RunningAppProcessInfo p : procs) if (name.equals(p.processName)) return true;
        return false;
    }

    /** GET http://127.0.0.1:8090/info, or null. */
    static JSONObject fetchInfo(int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(BASE + "/info").openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setUseCaches(false);
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                JSONObject o = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
                return "game-to-tv".equals(o.optString("app")) ? o : null;
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------------------------ loading page

    private void showLoading() {
        onServerPage = false;
        if (!LOADING.equals(web.getUrl())) {
            loadingReady = false;
            web.loadUrl(LOADING);
        }
    }

    private void state(String title, String sub, boolean error, String tipsHtml) {
        final String js = "window.g2tState&&g2tState(" + JSONObject.quote(title) + "," + JSONObject.quote(sub) + "," + error + "," + JSONObject.quote(tipsHtml) + ")";
        ui.post(new Runnable() {
            @Override public void run() {
                pendingState = js;
                if (loadingReady && !onServerPage) web.evaluateJavascript(js, null);
            }
        });
    }

    private final class Client extends WebViewClient {
        @Override
        public void onPageFinished(WebView view, String url) {
            if (LOADING.equals(url)) {
                loadingReady = true;
                if (pendingState != null) view.evaluateJavascript(pendingState, null);
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            String host = u.getHost();
            // Only our own pages inside the app; anything else is ignored
            return !("127.0.0.1".equals(host) || "localhost".equals(host) || "file".equals(u.getScheme()) || "about".equals(u.getScheme()));
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame() || !onServerPage) return;
            Log.w(TAG, "La página de la tele no carga (" + err.getDescription() + "): se espera al servidor otra vez");
            startFlow(false);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The page's renderer died (usually low memory): new WebView, same flow
            Log.w(TAG, "El WebView se ha cerrado (" + (detail.didCrash() ? "fallo" : "sin memoria") + "): se crea otro");
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) parent.removeView(view);
            view.destroy();
            web = createWebView();
            setContentView(web);
            onServerPage = false;
            loadingReady = false;
            startFlow(false);
            return true;
        }
    }

    // ------------------------------------------------------------------ keys

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        int m = Keys.map(code);
        if (m == Keys.PASS) return super.dispatchKeyEvent(e);
        if (m == Keys.BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP && !e.isCanceled()) onBackKey();
            return true;
        }
        if (!onServerPage) {
            // Loading / error screen: OK retries after an error
            if (failed && m == KeyEvent.KEYCODE_ENTER && e.getAction() == KeyEvent.ACTION_UP) startFlow(true);
            return true;
        }
        if (m == code) return super.dispatchKeyEvent(e);
        web.dispatchKeyEvent(new KeyEvent(e.getDownTime(), e.getEventTime(), e.getAction(), m, e.getRepeatCount(),
                e.getMetaState(), e.getDeviceId(), 0, e.getFlags(), e.getSource()));
        return true;
    }

    private void sendKeyToPage(int keyCode) {
        long now = SystemClock.uptimeMillis();
        web.dispatchKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0));
        web.dispatchKeyEvent(new KeyEvent(now, now + 20, KeyEvent.ACTION_UP, keyCode, 0));
    }

    private void onBackKey() {
        if (!onServerPage) { finish(); return; }
        web.evaluateJavascript(JS_WHERE, new ValueCallback<String>() {
            @Override public void onReceiveValue(String where) {
                if (where != null && where.contains("other")) {
                    // In a game, a section or a dialog: the page's own Back (it asks before leaving a game)
                    lastBackAt = 0;
                    sendKeyToPage(KeyEvent.KEYCODE_ESCAPE);
                    return;
                }
                long now = SystemClock.uptimeMillis();
                if (now - lastBackAt < EXIT_WINDOW_MS) {
                    finish();
                } else {
                    lastBackAt = now;
                    Toast.makeText(MainActivity.this, R.string.press_back_again, Toast.LENGTH_SHORT).show();
                }
            }
        });
    }
}
