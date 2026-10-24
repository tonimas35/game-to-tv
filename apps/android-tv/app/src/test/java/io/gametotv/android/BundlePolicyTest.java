package io.gametotv.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Properties;
import java.util.Set;

public class BundlePolicyTest {
    private static final int APP = 80000;
    private static final BundlePolicy.Info APK = info("0.8.0+20261024100000", 20261024100000L, 80000);
    private static final BundlePolicy.Info V1 = info("0.8.0+20261025100000", 20261025100000L, 80000);
    private static final BundlePolicy.Info V2 = info("0.8.1+20261026100000", 20261026100000L, 80000);
    private static final BundlePolicy.Info V3 = info("0.8.2+20261027100000", 20261027100000L, 80000);

    private static BundlePolicy.Info info(String v, long build, int minApp) { return new BundlePolicy.Info(v, build, minApp); }

    /** Every folder is there. */
    private static final BundlePolicy.Dirs ALL = new BundlePolicy.Dirs() {
        @Override public boolean ready(String version) { return true; }
    };

    private static BundlePolicy.Dirs only(String... versions) {
        final Set<String> set = new HashSet<>(Arrays.asList(versions));
        return new BundlePolicy.Dirs() {
            @Override public boolean ready(String version) { return set.contains(version); }
        };
    }

    // ------------------------------------------------------------------ download or not

    @Test
    public void downloadsANewerBundleForThisApp() {
        BundlePolicy.State s = new BundlePolicy.State();
        assertNull(BundlePolicy.whyNotDownload(V1, APP, APK, s));
    }

    @Test
    public void neverDownloadsOlderOrSameAsWhatItHas() {
        BundlePolicy.State s = new BundlePolicy.State();
        assertNotNull("igual que el del APK", BundlePolicy.whyNotDownload(APK, APP, APK, s));
        assertNotNull("más viejo que el del APK", BundlePolicy.whyNotDownload(info("0.7.0+20261001000000", 20261001000000L, 0), APP, APK, s));
        s.good = V2;
        assertNotNull("ya tiene V2", BundlePolicy.whyNotDownload(V2, APP, APK, s));
        assertNotNull("V1 < V2", BundlePolicy.whyNotDownload(V1, APP, APK, s));
        assertNull(BundlePolicy.whyNotDownload(V3, APP, APK, s));
        BundlePolicy.stage(s, V3);
        assertNotNull("V3 ya descargada", BundlePolicy.whyNotDownload(V3, APP, APK, s));
    }

    @Test
    public void respectsMinApp() {
        BundlePolicy.State s = new BundlePolicy.State();
        BundlePolicy.Info needsNewApp = info("0.9.0+20261101000000", 20261101000000L, 90000);
        assertTrue(BundlePolicy.whyNotDownload(needsNewApp, APP, APK, s).contains("app más nueva"));
        assertNull(BundlePolicy.whyNotDownload(needsNewApp, 90000, APK, s));
    }

    @Test
    public void neverDownloadsABadVersionAgain() {
        BundlePolicy.State s = new BundlePolicy.State();
        BundlePolicy.markBad(s, V2.version);
        assertTrue(BundlePolicy.whyNotDownload(V2, APP, APK, s).contains("ya falló"));
        assertNull("una más nueva sí", BundlePolicy.whyNotDownload(V3, APP, APK, s));
    }

    @Test
    public void rejectsVersionsThatAreNotSafeFolderNames() {
        assertTrue(BundlePolicy.validVersion("0.8.0+20261024153012"));
        assertTrue(BundlePolicy.validVersion("1.0.0-beta_2"));
        assertFalse(BundlePolicy.validVersion(null));
        assertFalse(BundlePolicy.validVersion(""));
        assertFalse(BundlePolicy.validVersion(".."));
        assertFalse(BundlePolicy.validVersion("../datos"));
        assertFalse(BundlePolicy.validVersion("a/b"));
        assertFalse(BundlePolicy.validVersion(".oculto"));
        assertFalse(BundlePolicy.validVersion("a,b"));
        assertNotNull(BundlePolicy.whyNotDownload(info("../../x", 29990101000000L, 0), APP, APK, new BundlePolicy.State()));
        assertNotNull(BundlePolicy.whyNotDownload(info("0.8.0+0", 0, 0), APP, APK, new BundlePolicy.State()));
    }

    // ------------------------------------------------------------------ what to start

    @Test
    public void factoryBundleWhenNothingWasDownloaded() {
        BundlePolicy.Choice c = BundlePolicy.choose(new BundlePolicy.State(), APK, APP, ALL);
        assertSame(APK, c.info);
        assertEquals(BundlePolicy.APK, c.source);
        assertFalse(c.trial);
        assertFalse(c.downloaded());
    }

    @Test
    public void aCandidateIsTriedThenConfirmed() {
        BundlePolicy.State s = new BundlePolicy.State();
        BundlePolicy.stage(s, V1);
        BundlePolicy.Choice c = BundlePolicy.choose(s, APK, APP, ALL);
        assertEquals(V1.version, c.info.version);
        assertTrue(c.trial);
        assertTrue(c.downloaded());
        BundlePolicy.startedTrial(s);

        assertFalse("otra versión en /info no confirma", BundlePolicy.confirm(s, APK.version));
        assertTrue(BundlePolicy.confirm(s, V1.version));
        assertNull(s.candidate);
        assertEquals(V1.version, s.good.version);
        assertNull(s.previous);
        c = BundlePolicy.choose(s, APK, APP, ALL);
        assertEquals(V1.version, c.info.version);
        assertFalse("ya no es a prueba", c.trial);

        // The next one: V1 becomes «previous»
        BundlePolicy.stage(s, V2);
        assertTrue(BundlePolicy.choose(s, APK, APP, ALL).trial);
        assertTrue(BundlePolicy.confirm(s, V2.version));
        assertEquals(V2.version, s.good.version);
        assertEquals(V1.version, s.previous.version);
        assertEquals(new HashSet<>(Arrays.asList(V1.version, V2.version)), BundlePolicy.keep(s, APK));
    }

    @Test
    public void aFailedCandidateRollsBackToTheLastGoodOne() {
        BundlePolicy.State s = new BundlePolicy.State();
        s.good = V1;
        BundlePolicy.stage(s, V2);
        assertTrue(BundlePolicy.choose(s, APK, APP, ALL).trial);
        BundlePolicy.markBad(s, V2.version);
        BundlePolicy.Choice c = BundlePolicy.choose(s, APK, APP, ALL);
        assertEquals(V1.version, c.info.version);
        assertFalse(c.trial);
        assertTrue(s.bad.contains(V2.version));
        assertNull(s.candidate);
        assertFalse(BundlePolicy.keep(s, APK).contains(V2.version));
    }

    @Test
    public void aFailedCandidateWithNoGoodOneFallsBackToTheApk() {
        BundlePolicy.State s = new BundlePolicy.State();
        BundlePolicy.stage(s, V1);
        BundlePolicy.markBad(s, V1.version);
        assertEquals(BundlePolicy.APK, BundlePolicy.choose(s, APK, APP, ALL).source);
    }

    @Test
    public void aGoodBundleThatFailsFallsBackToThePreviousThenTheApk() {
        BundlePolicy.State s = new BundlePolicy.State();
        s.good = V2;
        s.previous = V1;
        BundlePolicy.markBad(s, V2.version);
        assertEquals(V1.version, BundlePolicy.choose(s, APK, APP, ALL).info.version);
        BundlePolicy.markBad(s, V1.version);
        assertEquals(BundlePolicy.APK, BundlePolicy.choose(s, APK, APP, ALL).source);
        assertTrue(BundlePolicy.keep(s, APK).isEmpty());
    }

    @Test
    public void aCandidateStartedTooOftenWithoutVerdictIsBad() {
        BundlePolicy.State s = new BundlePolicy.State();
        s.good = V1;
        BundlePolicy.stage(s, V2);
        for (int i = 0; i < BundlePolicy.MAX_TRIES; i++) {
            BundlePolicy.Choice c = BundlePolicy.choose(s, APK, APP, ALL);
            assertTrue("intento " + (i + 1), c.trial);
            BundlePolicy.startedTrial(s);
        }
        BundlePolicy.Choice c = BundlePolicy.choose(s, APK, APP, ALL);
        assertEquals(V1.version, c.info.version);
        assertTrue(s.bad.contains(V2.version));
    }

    @Test
    public void aNewerApkWinsOverOlderDownloads() {
        // The app was updated with an APK whose own bundle is newer than the downloads
        BundlePolicy.State s = new BundlePolicy.State();
        s.good = V2;
        s.previous = V1;
        BundlePolicy.stage(s, V3);
        BundlePolicy.Info newApk = info("0.9.0+20261101000000", 20261101000000L, 90000);
        BundlePolicy.Choice c = BundlePolicy.choose(s, newApk, 90000, ALL);
        assertEquals(BundlePolicy.APK, c.source);
        assertSame(newApk, c.info);
        assertNull("el candidato viejo se descarta", s.candidate);
        assertTrue("y se borran todos", BundlePolicy.keep(s, newApk).isEmpty());
        // ... but a download newer than that APK is used again
        BundlePolicy.Info v4 = info("0.9.1+20261102000000", 20261102000000L, 90000);
        assertNull(BundlePolicy.whyNotDownload(v4, 90000, newApk, s));
    }

    @Test
    public void aNewerDownloadWinsOverAnOlderApk() {
        BundlePolicy.State s = new BundlePolicy.State();
        s.good = V2;
        assertEquals(V2.version, BundlePolicy.choose(s, APK, APP, ALL).info.version);
    }

    @Test
    public void bundlesForANewerAppAreNotRun() {
        // e.g. the APK was downgraded by hand
        BundlePolicy.State s = new BundlePolicy.State();
        s.good = info("0.9.0+20261101000000", 20261101000000L, 90000);
        assertEquals(BundlePolicy.APK, BundlePolicy.choose(s, APK, APP, ALL).source);
    }

    @Test
    public void missingFoldersAreSkipped() {
        BundlePolicy.State s = new BundlePolicy.State();
        s.good = V2;
        s.previous = V1;
        BundlePolicy.stage(s, V3);
        BundlePolicy.Choice c = BundlePolicy.choose(s, APK, APP, only(V1.version));
        assertEquals(V1.version, c.info.version);
        assertNull(s.candidate);
        assertEquals(BundlePolicy.APK, BundlePolicy.choose(s, APK, APP, only()).source);
    }

    @Test
    public void anOlderCandidateThanTheGoodOneIsDropped() {
        BundlePolicy.State s = new BundlePolicy.State();
        s.good = V2;
        s.candidate = V1;
        BundlePolicy.Choice c = BundlePolicy.choose(s, APK, APP, ALL);
        assertEquals(V2.version, c.info.version);
        assertFalse(c.trial);
        assertNull(s.candidate);
    }

    @Test
    public void theBadListIsCapped() {
        BundlePolicy.State s = new BundlePolicy.State();
        for (int i = 0; i < BundlePolicy.MAX_BAD + 5; i++) BundlePolicy.markBad(s, "0.8.0+" + (20261024000000L + i));
        assertEquals(BundlePolicy.MAX_BAD, s.bad.size());
        assertFalse("se olvidan las más viejas", s.bad.contains("0.8.0+20261024000000"));
        assertTrue(s.bad.contains("0.8.0+" + (20261024000000L + BundlePolicy.MAX_BAD + 4)));
    }

    // ------------------------------------------------------------------ on disk

    @Test
    public void stateSurvivesARoundTrip() {
        BundlePolicy.State s = new BundlePolicy.State();
        s.good = V2;
        s.previous = V1;
        BundlePolicy.stage(s, V3);
        BundlePolicy.startedTrial(s);
        BundlePolicy.markBad(s, "0.7.9+20261020000000");
        Properties p = s.toProperties();
        BundlePolicy.State r = BundlePolicy.State.from(p);
        assertEquals(V2.version, r.good.version);
        assertEquals(V2.build, r.good.build);
        assertEquals(V2.minApp, r.good.minApp);
        assertEquals(V1.version, r.previous.version);
        assertEquals(V3.version, r.candidate.version);
        assertEquals(1, r.candidateTries);
        assertTrue(r.bad.contains("0.7.9+20261020000000"));
        assertEquals(1, r.bad.size());
    }

    @Test
    public void emptyOrBrokenStateMeansNothingDownloaded() {
        BundlePolicy.State r = BundlePolicy.State.from(new Properties());
        assertNull(r.good);
        assertNull(r.candidate);
        assertTrue(r.bad.isEmpty());
        Properties p = new Properties();
        p.setProperty("good.version", "../x");
        p.setProperty("good.build", "nope");
        p.setProperty("candidate.tries", "x");
        p.setProperty("bad", ",,../y, 0.8.0+1 ");
        r = BundlePolicy.State.from(p);
        assertNull(r.good);
        assertEquals(0, r.candidateTries);
        assertEquals(new HashSet<>(Arrays.asList("0.8.0+1")), r.bad);
        assertNull(BundlePolicy.State.from(null).good);
    }
}
