package io.gametotv.android;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * Network side of the automatic game updates: CI publishes, on the «apk»
 * branch, bundle.json { version, build, built, sha256, size, minApp } and
 * bundle.zip (the nodejs-project folder of the APK). The app asks for
 * bundle.json with a hard time limit (it never holds the games back) and
 * downloads bundle.zip checking size and SHA-256.
 *
 * Base URL: BuildConfig.UPDATE_URL. Tests (CI emulator) point it elsewhere
 * with a system property that only adb can set:
 *   adb shell setprop debug.g2t.update_url http://10.0.2.2:8765/ok/
 *   adb shell setprop debug.g2t.update_url off      (no checks at all)
 */
final class Updater {
    private Updater() {}

    private static final String TAG = "g2t";
    static final String PROP = "debug.g2t.update_url";

    /** The published bundle.json. */
    static final class Remote {
        final BundlePolicy.Info info;
        final String sha256;
        final long size;

        Remote(BundlePolicy.Info info, String sha256, long size) {
            this.info = info;
            this.sha256 = sha256;
            this.size = size;
        }

        @Override public String toString() { return info + " " + size + " bytes"; }
    }

    interface Progress { void percent(int p); }
    interface Cancel { boolean cancelled(); }

    private static final ExecutorService NET = Executors.newCachedThreadPool(new ThreadFactory() {
        @Override public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "g2t-update");
            t.setDaemon(true);
            return t;
        }
    });

    /** Base URL ending in «/», or null if updates are off. */
    static String baseUrl() {
        String p = sysprop(PROP);
        String base = p != null && !p.isEmpty() ? p : BuildConfig.UPDATE_URL;
        if ("off".equals(base) || !(base.startsWith("https://") || base.startsWith("http://"))) return null;
        return base.endsWith("/") ? base : base + "/";
    }

    private static String sysprop(String name) {
        Process p = null;
        try {
            p = new ProcessBuilder("/system/bin/getprop", name).redirectErrorStream(true).start();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line = r.readLine();
                return line != null ? line.trim() : null;
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (p != null) p.destroy();
        }
    }

    /**
     * GET base/bundle.json within «limitMs» in all (DNS included: it runs on
     * another thread and is abandoned at the limit). null if there is no
     * answer in time, no network or the JSON is not valid.
     */
    static Remote fetchManifest(final String base, long limitMs) {
        final int t = (int) Math.max(1000, limitMs);
        Future<Remote> f = NET.submit(new Callable<Remote>() {
            @Override public Remote call() throws Exception {
                // ?t= changes every minute: past the CDN cache of raw.githubusercontent.com
                HttpURLConnection c = open(base + "bundle.json?t=" + (System.currentTimeMillis() / 60000), t, t);
                try {
                    int code = c.getResponseCode();
                    if (code != 200) {
                        Log.i(TAG, "Actualizaciones: bundle.json respondió " + code);
                        return null;
                    }
                    try (InputStream in = c.getInputStream()) {
                        JSONObject o = new JSONObject(BundleStore.readAll(in));
                        BundlePolicy.Info i = BundleStore.info(o);
                        String sha = o.optString("sha256", "");
                        long size = o.optLong("size", 0);
                        if (i == null || !sha.matches("[0-9a-f]{64}") || size <= 0) {
                            Log.w(TAG, "Actualizaciones: bundle.json no válido: " + o);
                            return null;
                        }
                        return new Remote(i, sha, size);
                    }
                } finally {
                    c.disconnect();
                }
            }
        });
        try {
            return f.get(limitMs, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            f.cancel(true);
            Log.i(TAG, "Actualizaciones: sin respuesta de " + base + " (" + e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "") + ")");
            return null;
        }
    }

    /**
     * Downloads base/bundle.zip to the cache folder, checking size and
     * SHA-256. Throws if anything is off, if it takes more than «maxMs» or if
     * «cancel» says so. The caller deletes the file.
     */
    static File download(Context c, String base, Remote r, Progress progress, long maxMs, Cancel cancel) throws IOException {
        File out = new File(c.getCacheDir(), "bundle-descarga.zip");
        //noinspection ResultOfMethodCallIgnored
        out.delete();
        long t0 = System.currentTimeMillis();
        HttpURLConnection conn = open(base + "bundle.zip?v=" + URLEncoder.encode(r.info.version, "UTF-8"), 8000, 15000);
        MessageDigest md = BundleFiles.sha256();
        long got = 0;
        int last = -1;
        try {
            int code = conn.getResponseCode();
            if (code != 200) throw new IOException("bundle.zip respondió " + code);
            try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[32 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    got += n;
                    if (got > r.size) throw new IOException("bundle.zip es más grande de lo anunciado (" + r.size + " bytes)");
                    if (cancel != null && cancel.cancelled()) throw new IOException("descarga cancelada");
                    if (System.currentTimeMillis() - t0 > maxMs) throw new IOException("descarga demasiado lenta (más de " + maxMs / 1000 + " s)");
                    md.update(buf, 0, n);
                    os.write(buf, 0, n);
                    int p = (int) (got * 100 / r.size);
                    if (progress != null && p != last) { last = p; progress.percent(p); }
                }
            }
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw e;
        } finally {
            conn.disconnect();
        }
        String sha = BundleFiles.hex(md.digest());
        if (got != r.size || !sha.equals(r.sha256)) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw new IOException("bundle.zip no coincide con bundle.json (" + got + " de " + r.size + " bytes, sha256 " + sha + ")");
        }
        Log.i(TAG, "Descargado bundle.zip " + r.info.version + " (" + got + " bytes, " + (System.currentTimeMillis() - t0) + " ms, sha256 correcto)");
        return out;
    }

    private static HttpURLConnection open(String url, int connectMs, int readMs) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(connectMs);
        c.setReadTimeout(readMs);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("User-Agent", "JuegosDelSalon-Android/" + BuildConfig.VERSION_NAME);
        return c;
    }
}
