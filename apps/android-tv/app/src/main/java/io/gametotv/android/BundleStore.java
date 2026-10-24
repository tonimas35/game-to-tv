package io.gametotv.android;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Properties;
import java.util.Set;

/**
 * The game bundles on disk (main process only): the APK's own one
 * (assets/nodejs-project, copied out by NodeBundle) and the downloaded ones in
 * files/bundles/<version>/, with the state of BundlePolicy in
 * files/bundles/estado.properties. Every method is synchronized: the start
 * flow and the background download run on different threads.
 */
final class BundleStore {
    private static final String TAG = "g2t";
    private static final String STATE = "estado.properties";
    private static BundleStore instance;

    private final Context app;
    private final File root;
    private final int appCode;
    private BundlePolicy.Info apk;

    static synchronized BundleStore get(Context c) {
        if (instance == null) instance = new BundleStore(c.getApplicationContext());
        return instance;
    }

    private BundleStore(Context app) {
        this.app = app;
        this.root = new File(app.getFilesDir(), "bundles");
        this.appCode = BuildConfig.VERSION_CODE;
    }

    File dir(String version) { return new File(root, version); }

    private final BundlePolicy.Dirs dirs = new BundlePolicy.Dirs() {
        @Override public boolean ready(String version) { return new File(dir(version), "main.js").isFile(); }
    };

    /** The bundle inside the APK (assets/nodejs-project/bundle.json). */
    synchronized BundlePolicy.Info apk() {
        if (apk == null) {
            BundlePolicy.Info i = null;
            try (InputStream in = app.getAssets().open(NodeBundle.ASSET_DIR + "/bundle.json")) {
                i = info(new JSONObject(readAll(in)));
            } catch (Exception e) {
                Log.w(TAG, "Sin bundle.json en el APK", e);
            }
            apk = i != null ? i : new BundlePolicy.Info("apk", 0, 0);
        }
        return apk;
    }

    /** { version, build, minApp } of a bundle.json (inner or the published manifest), or null. */
    static BundlePolicy.Info info(JSONObject o) {
        if (o == null) return null;
        String v = o.optString("version", null);
        long build = o.optLong("build", 0);
        if (!BundlePolicy.validVersion(v) || build <= 0) return null;
        return new BundlePolicy.Info(v, build, o.optInt("minApp", 0));
    }

    synchronized BundlePolicy.State load() {
        Properties p = new Properties();
        File f = new File(root, STATE);
        if (f.isFile()) {
            try (InputStream in = new FileInputStream(f)) {
                p.load(in);
            } catch (IOException e) {
                Log.w(TAG, "No se pudo leer " + f, e);
            }
        }
        return BundlePolicy.State.from(p);
    }

    private void save(BundlePolicy.State s) {
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        File tmp = new File(root, STATE + ".tmp");
        try (FileOutputStream os = new FileOutputStream(tmp)) {
            s.toProperties().store(os, "Juegos del Salón: paquetes de juegos descargados (BundlePolicy)");
            os.getFD().sync();
        } catch (IOException e) {
            Log.w(TAG, "No se pudo guardar el estado de las actualizaciones", e);
            return;
        }
        if (!tmp.renameTo(new File(root, STATE))) Log.w(TAG, "No se pudo renombrar " + tmp);
    }

    /** Which bundle to start now (BundlePolicy.choose); counts a trial and tidies the folder. */
    synchronized BundlePolicy.Choice choose() {
        BundlePolicy.State s = load();
        BundlePolicy.Choice c = BundlePolicy.choose(s, apk(), appCode, dirs);
        if (c.trial) BundlePolicy.startedTrial(s);
        save(s);
        prune(s);
        Log.i(TAG, "Paquete de juegos: " + c + (c.trial ? " · intento " + s.candidateTries + " de " + BundlePolicy.MAX_TRIES : ""));
        return c;
    }

    synchronized String whyNotDownload(BundlePolicy.Info remote) {
        return BundlePolicy.whyNotDownload(remote, appCode, apk(), load());
    }

    /** /info answered with this bundle version: a candidate becomes the good one. */
    synchronized boolean confirm(String running) {
        BundlePolicy.State s = load();
        if (!BundlePolicy.confirm(s, running)) return false;
        save(s);
        prune(s);
        Log.i(TAG, "Actualización confirmada: los juegos " + running + " funcionan");
        return true;
    }

    synchronized void markBad(String version, String why) {
        BundlePolicy.State s = load();
        BundlePolicy.markBad(s, version);
        save(s);
        prune(s);
        Log.w(TAG, "El paquete de juegos " + version + " ha fallado (" + why + "): no se volverá a usar");
    }

    /**
     * A verified download: unzips it to files/bundles/<version>/ (through a
     * .tmp folder, so a half-written bundle is never used), checks that it is
     * the announced version and stages it as the candidate.
     */
    synchronized void install(BundlePolicy.Info info, File zip) throws IOException {
        if (!BundlePolicy.validVersion(info.version)) throw new IOException("Versión no válida: " + info.version);
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        File tmp = new File(root, info.version + ".tmp");
        BundleFiles.deleteTree(tmp);
        try {
            int n = BundleFiles.unzip(zip, tmp);
            if (!new File(tmp, "main.js").isFile()) throw new IOException("Al paquete le falta main.js");
            BundlePolicy.Info inner;
            try {
                inner = info(new JSONObject(NodeBundle.readText(new File(tmp, "bundle.json"))));
            } catch (Exception e) {
                throw new IOException("bundle.json del paquete no válido: " + e.getMessage());
            }
            if (inner == null || !inner.version.equals(info.version)) {
                throw new IOException("El paquete dice ser " + (inner != null ? inner.version : "?") + " y se esperaba " + info.version);
            }
            File dest = dir(info.version);
            BundleFiles.deleteTree(dest);
            if (!tmp.renameTo(dest)) throw new IOException("No se pudo mover " + tmp + " a " + dest);
            BundlePolicy.State s = load();
            BundlePolicy.stage(s, info);
            save(s);
            Log.i(TAG, "Paquete de juegos " + info.version + " listo (" + n + " archivos): se probará al arrancar el servidor");
        } finally {
            BundleFiles.deleteTree(tmp);
        }
    }

    /** Deletes every downloaded bundle that BundlePolicy.keep does not want (never the APK's). */
    private void prune(BundlePolicy.State s) {
        Set<String> keep = BundlePolicy.keep(s, apk());
        File[] kids = root.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            String name = k.getName();
            if (name.equals(STATE) || keep.contains(name)) continue;
            Log.i(TAG, "Borrando el paquete de juegos viejo " + name);
            BundleFiles.deleteTree(k);
        }
    }

    static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
}
