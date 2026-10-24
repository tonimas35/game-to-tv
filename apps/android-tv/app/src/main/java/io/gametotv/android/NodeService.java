package io.gametotv.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Process;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Runs the game server (Node.js 18 on nodejs-mobile) inside the TV.
 *
 * Lives in its own process (android:process=":node") because Node can only be
 * started ONCE per process: when the server ends (idle shutdown after 15 min
 * without TV page or players, see src/tv-service/android.js) the whole process
 * goes away, and the next launch of the app starts a fresh one.
 *
 * It is a foreground service so Android does not stop it while the app is in
 * the background (Android 8+ stops background services after about a minute).
 * On Android TV the notification is not normally visible.
 *
 * Intents:
 *   ACTION_START  (extras: hostIp, net, idleMin, bundleDir, bundleVersion) start Node if it
 *                 is not running yet (idempotent). bundleDir: a downloaded game bundle
 *                 (files/bundles/<version>, chosen by MainActivity through BundleStore);
 *                 without it, the APK's own one (NodeBundle)
 *   ACTION_STOP   stop: the app asks for it when the TV's IP changed or to retry
 */
public class NodeService extends Service {
    static final String TAG = "g2t";
    static final String ACTION_START = "io.gametotv.android.START";
    static final String ACTION_STOP = "io.gametotv.android.STOP";
    static final String EXTRA_HOST_IP = "hostIp";
    static final String EXTRA_NET = "net";
    static final String EXTRA_IDLE_MIN = "idleMin";
    static final String EXTRA_BUNDLE_DIR = "bundleDir";
    static final String EXTRA_BUNDLE_VERSION = "bundleVersion";
    static final int PORT = 8090;
    static final int IDLE_MINUTES = 15;
    static final int MAX_OLD_SPACE_MB = 128;   // the Philips TV has ~350 MB free in total
    private static final String CHANNEL = "servidor";
    private static final int NOTIFICATION_ID = 8090;

    /** Node was started in this process (it cannot be started twice). */
    private static volatile boolean started;

    @Override
    public void onCreate() {
        super.onCreate();
        goForeground();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            Log.i(TAG, "Parando el proceso :node a petición de la app");
            stopForegroundCompat();
            stopSelf();
            new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                @Override public void run() { Process.killProcess(Process.myPid()); }
            }, 150);
            return START_NOT_STICKY;
        }
        goForeground();
        if (!started) {
            started = true;
            String ip = intent != null ? intent.getStringExtra(EXTRA_HOST_IP) : null;
            String net = intent != null ? intent.getStringExtra(EXTRA_NET) : null;
            if (ip == null) {
                Net.Result r = Net.lanIp(this);
                ip = r.ip;
                net = r.kind;
            }
            final String hostIp = ip;
            final String netKind = net;
            int idle = intent != null ? intent.getIntExtra(EXTRA_IDLE_MIN, IDLE_MINUTES) : IDLE_MINUTES;
            final int idleMin = idle >= 1 && idle <= 1440 ? idle : IDLE_MINUTES;
            final String bundleDir = intent != null ? intent.getStringExtra(EXTRA_BUNDLE_DIR) : null;
            final String bundleVersion = intent != null ? intent.getStringExtra(EXTRA_BUNDLE_VERSION) : null;
            // node::Start blocks until Node ends: its own thread with a big stack
            Thread t = new Thread(null, new Runnable() {
                @Override public void run() { runNode(hostIp, netKind, idleMin, bundleDir, bundleVersion); }
            }, "nodejs", 16L * 1024 * 1024);
            t.start();
        }
        return START_NOT_STICKY;
    }

    private void runNode(String hostIp, String net, int idleMin, String bundleDir, String bundleVersion) {
        Context c = getApplicationContext();
        File data = NodeBundle.dataDir(c);
        //noinspection ResultOfMethodCallIgnored
        data.mkdirs();
        File main;
        String source;
        try {
            File downloaded = bundleDir != null ? new File(bundleDir, "main.js") : null;
            if (downloaded != null && downloaded.isFile()) {
                main = downloaded;
                source = BundlePolicy.DOWNLOADED;
                Log.i(TAG, "Juegos descargados " + bundleVersion + " (" + bundleDir + ")");
            } else {
                if (bundleDir != null) Log.w(TAG, "No está el paquete " + bundleDir + ": se usa el del APK");
                NodeBundle.ensureExtracted(c);
                main = NodeBundle.mainScript(c);
                source = BundlePolicy.APK;
            }
            NodeJni.load();
        } catch (Throwable e) {
            Log.e(TAG, "No se pudo preparar Node", e);
            writeStatus(data, "error", "No se pudo preparar el servidor: " + e);
            return;   // the process stays: the app shows the error and retries with ACTION_STOP + START
        }
        List<String> argv = new ArrayList<>();
        argv.add("node");
        argv.add("--max-old-space-size=" + MAX_OLD_SPACE_MB);
        argv.add(main.getAbsolutePath());
        argv.add("--port"); argv.add(String.valueOf(PORT));
        argv.add("--idle-min"); argv.add(String.valueOf(idleMin));
        if (hostIp != null) { argv.add("--host-ip"); argv.add(hostIp); }
        if (net != null) { argv.add("--net"); argv.add(net); }
        argv.add("--data-dir"); argv.add(data.getAbsolutePath());
        argv.add("--tmp-dir"); argv.add(getCacheDir().getAbsolutePath());
        argv.add("--app-version"); argv.add(versionName());
        argv.add("--app-code"); argv.add(String.valueOf(BuildConfig.VERSION_CODE));
        argv.add("--bundle-source"); argv.add(source);
        argv.add("--sdk"); argv.add(String.valueOf(Build.VERSION.SDK_INT));
        argv.add("--abi"); argv.add(Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "?");
        argv.add("--device"); argv.add((Build.MANUFACTURER + " " + Build.MODEL).trim());
        Log.i(TAG, "Arrancando Node: " + argv);
        int code;
        try {
            code = NodeJni.startNodeWithArguments(argv.toArray(new String[0]));
        } catch (Throwable e) {
            Log.e(TAG, "Node ha fallado", e);
            writeStatus(data, "error", "Node ha fallado: " + e);
            code = -1;
        }
        // Node ended on its own (nothing left in its event loop): end the process too
        Log.i(TAG, "Node ha terminado (código " + code + "): fin del proceso :node");
        if (code != 0) writeStatus(data, "error", "El servidor terminó con el código " + code + " (adb logcat -s g2t g2t-node)");
        stopSelf();
        Process.killProcess(Process.myPid());
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0.0.0";
        }
    }

    static void writeStatus(File dataDir, String state, String error) {
        try (FileOutputStream os = new FileOutputStream(new File(dataDir, "estado.json"))) {
            JSONObject o = new JSONObject();
            o.put("state", state);
            o.put("error", error);
            o.put("pid", Process.myPid());
            os.write((o.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.w(TAG, "No se pudo escribir estado.json", e);
        }
    }

    private void goForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = b.setSmallIcon(R.drawable.ic_stat_tv)
                .setContentTitle(getString(R.string.notif_title))
                .setContentText(getString(R.string.notif_text))
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
