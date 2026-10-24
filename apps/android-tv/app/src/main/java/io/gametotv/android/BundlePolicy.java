package io.gametotv.android;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Properties;
import java.util.Set;

/**
 * Automatic game updates: which game bundle to run, when to download a new
 * one and what to do when one fails. Pure Java (no Android calls), unit
 * tested on the JVM (src/test/.../BundlePolicyTest.java); BundleStore keeps the
 * state on disk and does the file work.
 *
 * Bundles are ordered by their «build» (UTC time of the commit,
 * YYYYMMDDHHMMSS, see src/drivers/android/bundle.js). There are always two
 * sources: the bundle inside the APK (factory fallback, never deleted) and
 * the ones downloaded to files/bundles/<version>/:
 *
 *  candidate  downloaded and verified (SHA-256), not run yet. The next start
 *             runs it as a trial: if /info answers with its version it
 *             becomes «good»; if Node dies or does not answer in time it is
 *             «bad» forever and the app falls back.
 *  good       the last downloaded bundle that worked; «previous» the one before.
 *  bad        versions that failed once: never downloaded or run again.
 *
 * Whatever is newest wins: a newer APK (whose own bundle is newer than the
 * downloaded ones) runs its own bundle, and the old downloads are deleted.
 */
final class BundlePolicy {
    private BundlePolicy() {}

    static final String APK = "apk";
    static final String DOWNLOADED = "descargado";
    /** Starts of a candidate without a verdict (app closed while waiting) before it counts as bad. */
    static final int MAX_TRIES = 3;
    static final int MAX_BAD = 20;

    /** A game bundle: version (0.8.0+20261024153012), build (20261024153012), minApp (versionCode). */
    static final class Info {
        final String version;
        final long build;
        final int minApp;

        Info(String version, long build, int minApp) {
            this.version = version;
            this.build = build;
            this.minApp = minApp;
        }

        @Override public String toString() { return version + " (build " + build + ", minApp " + minApp + ")"; }
    }

    /** What is on disk (files/bundles/estado.properties). */
    static final class State {
        Info good;
        Info previous;
        Info candidate;
        int candidateTries;
        final LinkedHashSet<String> bad = new LinkedHashSet<>();

        Properties toProperties() {
            Properties p = new Properties();
            put(p, "good", good);
            put(p, "previous", previous);
            put(p, "candidate", candidate);
            p.setProperty("candidate.tries", String.valueOf(candidateTries));
            StringBuilder b = new StringBuilder();
            for (String v : bad) { if (b.length() > 0) b.append(','); b.append(v); }
            p.setProperty("bad", b.toString());
            return p;
        }

        static State from(Properties p) {
            State s = new State();
            if (p == null) return s;
            s.good = get(p, "good");
            s.previous = get(p, "previous");
            s.candidate = get(p, "candidate");
            s.candidateTries = (int) num(p.getProperty("candidate.tries"));
            String bad = p.getProperty("bad", "");
            for (String v : bad.split(",")) if (validVersion(v.trim())) s.bad.add(v.trim());
            return s;
        }

        private static void put(Properties p, String k, Info i) {
            if (i == null) return;
            p.setProperty(k + ".version", i.version);
            p.setProperty(k + ".build", String.valueOf(i.build));
            p.setProperty(k + ".minApp", String.valueOf(i.minApp));
        }

        private static Info get(Properties p, String k) {
            String v = p.getProperty(k + ".version");
            if (!validVersion(v)) return null;
            return new Info(v, num(p.getProperty(k + ".build")), (int) num(p.getProperty(k + ".minApp")));
        }

        private static long num(String s) {
            try { return s == null ? 0 : Long.parseLong(s.trim()); } catch (NumberFormatException e) { return 0; }
        }
    }

    /** What to start. */
    static final class Choice {
        final Info info;
        final String source;     // APK or DOWNLOADED
        final boolean trial;     // a candidate: confirm or roll back

        Choice(Info info, String source, boolean trial) {
            this.info = info;
            this.source = source;
            this.trial = trial;
        }

        boolean downloaded() { return DOWNLOADED.equals(source); }

        @Override public String toString() { return info.version + " (" + source + (trial ? ", a prueba" : "") + ")"; }
    }

    /** Is files/bundles/<version>/ there with its main.js? */
    interface Dirs { boolean ready(String version); }

    /** Also a folder name: letters, digits and . _ + - only. */
    static boolean validVersion(String v) {
        if (v == null || v.isEmpty() || v.length() > 64 || v.charAt(0) == '.' || v.contains("..")) return false;
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            boolean ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '.' || c == '_' || c == '+' || c == '-';
            if (!ok) return false;
        }
        return true;
    }

    /** null if «remote» should be downloaded now; otherwise why not (for the log). */
    static String whyNotDownload(Info remote, int appCode, Info apk, State s) {
        if (remote == null) return "sin datos";
        if (!validVersion(remote.version) || remote.build <= 0) return "versión no válida (" + remote.version + ")";
        if (remote.minApp > appCode) return "necesita una app más nueva (versionCode " + remote.minApp + ", esta es " + appCode + ")";
        if (s.bad.contains(remote.version)) return "la versión " + remote.version + " ya falló en esta tele";
        if (apk != null && remote.build <= apk.build) return "la app ya trae esa versión o una más nueva (" + apk.version + ")";
        if (s.good != null && remote.build <= s.good.build) return "ya está al día (" + s.good.version + ")";
        if (s.candidate != null && remote.build <= s.candidate.build) return "ya está descargada (" + s.candidate.version + ")";
        return null;
    }

    /** Usable downloaded bundle: not bad, runs on this app, newer than the APK's and on disk. */
    static boolean usable(Info i, State s, Info apk, int appCode, Dirs dirs) {
        return i != null && validVersion(i.version) && !s.bad.contains(i.version) && i.minApp <= appCode &&
                (apk == null || i.build > apk.build) && dirs.ready(i.version);
    }

    /**
     * Which bundle to start now (may tidy the state: a candidate that is no
     * longer usable is dropped; one started MAX_TRIES times without verdict is bad).
     * The caller saves the state and, for a trial, calls startedTrial first.
     */
    static Choice choose(State s, Info apk, int appCode, Dirs dirs) {
        if (s.candidate != null && s.candidateTries >= MAX_TRIES) markBad(s, s.candidate.version);
        if (s.candidate != null) {
            boolean newer = s.good == null || s.candidate.build > s.good.build;
            if (newer && usable(s.candidate, s, apk, appCode, dirs)) return new Choice(s.candidate, DOWNLOADED, true);
            s.candidate = null;
            s.candidateTries = 0;
        }
        if (usable(s.good, s, apk, appCode, dirs)) return new Choice(s.good, DOWNLOADED, false);
        if (usable(s.previous, s, apk, appCode, dirs)) return new Choice(s.previous, DOWNLOADED, false);
        return new Choice(apk, APK, false);
    }

    static void startedTrial(State s) { s.candidateTries++; }

    /** A verified download: the next start tries it. */
    static void stage(State s, Info i) {
        s.candidate = i;
        s.candidateTries = 0;
    }

    /** /info answered with «running»: if it is the candidate, it becomes the good one. */
    static boolean confirm(State s, String running) {
        if (s.candidate == null || running == null || !running.equals(s.candidate.version)) return false;
        if (s.good != null && !s.good.version.equals(s.candidate.version)) s.previous = s.good;
        s.good = s.candidate;
        s.candidate = null;
        s.candidateTries = 0;
        return true;
    }

    /** It failed: never again. The next choose() falls back to good, previous or the APK. */
    static void markBad(State s, String version) {
        if (!validVersion(version)) return;
        s.bad.remove(version);
        s.bad.add(version);
        while (s.bad.size() > MAX_BAD) {
            Iterator<String> it = s.bad.iterator();
            it.next();
            it.remove();
        }
        if (s.candidate != null && version.equals(s.candidate.version)) { s.candidate = null; s.candidateTries = 0; }
        if (s.good != null && version.equals(s.good.version)) { s.good = s.previous; s.previous = null; }
        if (s.previous != null && version.equals(s.previous.version)) s.previous = null;
    }

    /** Downloaded versions worth keeping on disk (everything else in files/bundles/ is deleted). */
    static Set<String> keep(State s, Info apk) {
        Set<String> out = new LinkedHashSet<>();
        List<Info> all = new ArrayList<>();
        all.add(s.candidate);
        all.add(s.good);
        all.add(s.previous);
        for (Info i : all) {
            if (i != null && validVersion(i.version) && !s.bad.contains(i.version) && (apk == null || i.build > apk.build)) out.add(i.version);
        }
        return out;
    }
}
