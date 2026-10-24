package io.gametotv.android;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The Node.js project (server, games, public/, node_modules) travels in the
 * APK as assets/nodejs-project/ and is copied to <files>/nodejs-project on the
 * first run and whenever the APK changes (version or install time). The list
 * of files comes from assets/nodejs-project/files.txt (written by
 * src/drivers/android/bundle.js): listing assets recursively is slow.
 *
 * Gallery drawings, 2048 records and estado.json live in <files>/datos, which
 * is never touched here (it survives updates).
 */
final class NodeBundle {
    private NodeBundle() {}

    private static final String TAG = "g2t";
    static final String ASSET_DIR = "nodejs-project";

    static File projectDir(Context c) { return new File(c.getFilesDir(), ASSET_DIR); }
    static File dataDir(Context c) { return new File(c.getFilesDir(), "datos"); }
    static File mainScript(Context c) { return new File(projectDir(c), "main.js"); }

    static String stamp(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return pi.versionName + "/" + pi.versionCode + "/" + pi.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            return "unknown";
        }
    }

    /** Copies the project out of the APK if needed. Returns true if it copied. */
    static synchronized boolean ensureExtracted(Context c) throws IOException {
        File dir = projectDir(c);
        File stampFile = new File(c.getFilesDir(), ASSET_DIR + ".stamp");
        String want = stamp(c);
        if (new File(dir, "main.js").isFile() && want.equals(readText(stampFile))) return false;

        long t0 = System.currentTimeMillis();
        AssetManager am = c.getAssets();
        List<String> files = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(am.open(ASSET_DIR + "/files.txt"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim();
                if (!line.isEmpty() && !line.contains("..")) files.add(line);
            }
        }
        File tmp = new File(c.getFilesDir(), ASSET_DIR + ".new");
        deleteTree(tmp);
        byte[] buf = new byte[64 * 1024];
        for (String rel : files) {
            File out = new File(tmp, rel);
            File parent = out.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("No se pudo crear " + parent);
            try (InputStream in = am.open(ASSET_DIR + "/" + rel); OutputStream os = new FileOutputStream(out)) {
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
        }
        File old = new File(c.getFilesDir(), ASSET_DIR + ".old");
        deleteTree(old);
        if (dir.exists() && !dir.renameTo(old)) deleteTree(dir);
        if (!tmp.renameTo(dir)) throw new IOException("No se pudo mover " + tmp + " a " + dir);
        deleteTree(old);
        try (OutputStream os = new FileOutputStream(stampFile)) { os.write(want.getBytes(StandardCharsets.UTF_8)); }
        Log.i(TAG, "Proyecto de Node copiado (" + files.size() + " archivos, " + (System.currentTimeMillis() - t0) + " ms): " + want);
        return true;
    }

    static String readText(File f) {
        if (!f.isFile()) return null;
        try (InputStream in = new java.io.FileInputStream(f)) {
            byte[] b = new byte[(int) Math.min(f.length(), 1 << 20)];
            int off = 0, n;
            while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
            return new String(b, 0, off, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
