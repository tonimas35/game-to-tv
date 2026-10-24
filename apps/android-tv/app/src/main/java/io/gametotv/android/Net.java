package io.gametotv.android;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.Enumeration;

/**
 * The TV's LAN IPv4, for the QR the phones scan. Node's
 * os.networkInterfaces() is not reliable on Android (it may fail or come back
 * empty), so Java asks ConnectivityManager for the active network's
 * LinkProperties: Ethernet first, then Wi-Fi, never VPNs, loopback or
 * link-local (169.254) addresses.
 */
final class Net {
    private Net() {}

    static final class Result {
        final String ip;      // null when there is no usable network
        final String kind;    // ethernet | wifi | other | interface
        Result(String ip, String kind) { this.ip = ip; this.kind = kind; }
        @Override public String toString() { return ip + " (" + kind + ")"; }
    }

    static Result lanIp(Context ctx) {
        Result best = null;
        int bestScore = Integer.MIN_VALUE;
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network active = cm.getActiveNetwork();
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                LinkProperties lp = cm.getLinkProperties(n);
                if (caps == null || lp == null) continue;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
                String kind = caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ? "ethernet"
                        : caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi" : "other";
                for (LinkAddress la : lp.getLinkAddresses()) {
                    String ip = usable(la.getAddress());
                    if (ip == null) continue;
                    int s = score(ip, kind, n.equals(active));
                    if (s > bestScore) { bestScore = s; best = new Result(ip, kind); }
                }
            }
        } catch (RuntimeException e) {
            // SecurityException or a vendor bug: fall back to the interfaces
        }
        if (best != null) return best;
        return fromInterfaces();
    }

    /** Fallback: java.net.NetworkInterface (eth0 before wlan0). */
    static Result fromInterfaces() {
        Result best = null;
        int bestScore = Integer.MIN_VALUE;
        try {
            Enumeration<NetworkInterface> all = NetworkInterface.getNetworkInterfaces();
            if (all == null) return new Result(null, "none");
            for (NetworkInterface ni : Collections.list(all)) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String name = ni.getName();
                if (name.startsWith("p2p") || name.startsWith("tun") || name.startsWith("dummy") || name.startsWith("rmnet")) continue;
                String kind = name.startsWith("eth") ? "ethernet" : name.startsWith("wlan") ? "wifi" : "interface";
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    String ip = usable(a);
                    if (ip == null) continue;
                    int s = score(ip, kind, false);
                    if (s > bestScore) { bestScore = s; best = new Result(ip, kind); }
                }
            }
        } catch (Exception e) {
            // no network at all
        }
        return best != null ? best : new Result(null, "none");
    }

    private static String usable(InetAddress a) {
        if (!(a instanceof Inet4Address)) return null;
        if (a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress()) return null;
        return a.getHostAddress();
    }

    static int score(String ip, String kind, boolean active) {
        int s = 0;
        if (active) s += 400;
        if ("ethernet".equals(kind)) s += 300;
        else if ("wifi".equals(kind)) s += 250;
        if (ip.startsWith("192.168.")) s += 30;
        else if (ip.startsWith("10.")) s += 20;
        else if (ip.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*")) s += 10;
        return s;
    }
}
