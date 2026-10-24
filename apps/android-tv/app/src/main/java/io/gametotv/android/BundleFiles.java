package io.gametotv.android;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * File work of the automatic updates, plain JDK (unit tested on the JVM):
 * SHA-256 of the download and a careful unzip of bundle.zip (no paths
 * outside the folder, limits on size and number of files).
 */
final class BundleFiles {
    private BundleFiles() {}

    static final int MAX_FILES = 10000;
    static final long MAX_BYTES = 128L * 1024 * 1024;

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(Character.forDigit((x >> 4) & 0xf, 16)).append(Character.forDigit(x & 0xf, 16));
        return s.toString();
    }

    static String sha256(File f) throws IOException {
        MessageDigest md = sha256();
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        return hex(md.digest());
    }

    /** Safe relative path of a zip entry, or null if it must be rejected. */
    static String cleanName(String name) {
        if (name == null) return null;
        String n = name.replace('\\', '/');
        if (n.isEmpty() || n.startsWith("/") || n.indexOf(':') >= 0 || n.indexOf('\0') >= 0) return null;
        StringBuilder out = new StringBuilder();
        for (String part : n.split("/")) {
            if (part.isEmpty() || part.equals(".")) continue;
            if (part.equals("..")) return null;
            if (out.length() > 0) out.append('/');
            out.append(part);
        }
        return out.length() == 0 ? null : out.toString();
    }

    /**
     * Extracts «zip» into «dir» (created; must be empty or missing). Throws on
     * any entry that would land outside it, or beyond the limits. Returns the
     * number of files written.
     */
    static int unzip(File zip, File dir) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo crear " + dir);
        String root = dir.getCanonicalPath() + File.separator;
        int files = 0;
        long total = 0;
        byte[] buf = new byte[64 * 1024];
        try (ZipInputStream in = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry e;
            while ((e = in.getNextEntry()) != null) {
                String rel = cleanName(e.getName());
                if (rel == null) throw new IOException("Entrada no válida en el zip: " + e.getName());
                File out = new File(dir, rel);
                if (!out.getCanonicalPath().startsWith(root)) throw new IOException("Entrada fuera de la carpeta: " + e.getName());
                if (e.isDirectory()) {
                    if (!out.isDirectory() && !out.mkdirs()) throw new IOException("No se pudo crear " + out);
                    continue;
                }
                if (++files > MAX_FILES) throw new IOException("Demasiados archivos en el zip");
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("No se pudo crear " + parent);
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        total += n;
                        if (total > MAX_BYTES) throw new IOException("El zip descomprimido es demasiado grande");
                        os.write(buf, 0, n);
                    }
                }
            }
        }
        if (files == 0) throw new IOException("El zip está vacío");
        return files;
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.isDirectory() ? f.listFiles() : null;
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
