package io.gametotv.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class BundleFilesTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private File zip(String... namesAndContents) throws IOException {
        File f = tmp.newFile();
        try (ZipOutputStream z = new ZipOutputStream(new FileOutputStream(f))) {
            for (int i = 0; i < namesAndContents.length; i += 2) {
                z.putNextEntry(new ZipEntry(namesAndContents[i]));
                z.write(namesAndContents[i + 1].getBytes(StandardCharsets.UTF_8));
                z.closeEntry();
            }
        }
        return f;
    }

    private static String read(File f) throws IOException {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    @Test
    public void sha256OfAFile() throws IOException {
        File f = tmp.newFile();
        Files.write(f.toPath(), "abc".getBytes(StandardCharsets.UTF_8));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", BundleFiles.sha256(f));
    }

    @Test
    public void unzipsABundle() throws IOException {
        File z = zip("main.js", "require('./src/tv-service/android.js')", "bundle.json", "{}", "src/tv-service/android.js", "// hola", "node_modules/ws/package.json", "{\"name\":\"ws\"}");
        File out = new File(tmp.getRoot(), "b");
        assertEquals(4, BundleFiles.unzip(z, out));
        assertEquals("// hola", read(new File(out, "src/tv-service/android.js")));
        assertTrue(new File(out, "node_modules/ws/package.json").isFile());
    }

    @Test
    public void rejectsEntriesOutsideTheFolder() throws IOException {
        for (String bad : new String[] { "../fuera.js", "a/../../fuera.js", "/etc/passwd", "..\\fuera.js", "C:/x.js" }) {
            File z = zip("main.js", "x", bad, "malo");
            File out = new File(tmp.getRoot(), "z" + Math.abs(bad.hashCode()));
            try {
                BundleFiles.unzip(z, out);
                fail("debía rechazar " + bad);
            } catch (IOException expected) {
                assertFalse(new File(tmp.getRoot(), "fuera.js").exists());
            }
        }
    }

    @Test
    public void rejectsAnEmptyOrBrokenZip() throws IOException {
        File empty = zip();
        try {
            BundleFiles.unzip(empty, new File(tmp.getRoot(), "vacio"));
            fail("zip vacío");
        } catch (IOException expected) { /* ok */ }
        File junk = tmp.newFile();
        Files.write(junk.toPath(), "esto no es un zip".getBytes(StandardCharsets.UTF_8));
        try {
            BundleFiles.unzip(junk, new File(tmp.getRoot(), "basura"));
            fail("no es un zip");
        } catch (IOException expected) { /* ok */ }
    }

    @Test
    public void cleanNames() {
        assertEquals("a/b.js", BundleFiles.cleanName("a/b.js"));
        assertEquals("a/b.js", BundleFiles.cleanName("./a//b.js"));
        assertNull(BundleFiles.cleanName("../a"));
        assertNull(BundleFiles.cleanName("/a"));
        assertNull(BundleFiles.cleanName(""));
        assertNull(BundleFiles.cleanName("./"));
    }

    @Test
    public void deleteTree() throws IOException {
        File d = tmp.newFolder("borrar");
        Files.write(new File(d, "x").toPath(), new byte[] { 1 });
        assertTrue(new File(d, "sub").mkdirs());
        Files.write(new File(d, "sub/y").toPath(), new byte[] { 2 });
        BundleFiles.deleteTree(d);
        assertFalse(d.exists());
        BundleFiles.deleteTree(d);
    }
}
