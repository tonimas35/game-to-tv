package io.gametotv.android;

/** nodejs-mobile's JNI entry point (src/main/cpp/native-lib.cpp). Only used in the :node process. */
final class NodeJni {
    private NodeJni() {}

    private static boolean loaded;

    static synchronized void load() {
        if (loaded) return;
        System.loadLibrary("c++_shared");
        System.loadLibrary("node");
        System.loadLibrary("native-lib");
        loaded = true;
    }

    /** Runs Node with argv (argv[0] = "node"). Only returns when Node ends. Once per process. */
    static native int startNodeWithArguments(String[] argv);
}
