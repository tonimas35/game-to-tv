#!/usr/bin/env bash
# CI only (.github/workflows/android.yml, job «emulador»): installs the x86_64
# build on a running emulator and runs emulator-check.js (Node, CDP, keys)
# and ota-check.js (automatic game updates against a local fake server).
#   bash apps/android-tv/ci/emulator-test.sh APK OUT_DIR
set -uo pipefail
APK="$1"
OUT="${2:-emulador}"
mkdir -p "$OUT"
HERE="$(cd "$(dirname "$0")" && pwd)"

adb wait-for-device
adb shell getprop ro.build.version.release
adb shell wm size
adb shell wm density
adb shell dumpsys package com.google.android.webview | grep -m1 versionName || true
adb logcat -c || true
adb install -r "$APK"
# The first part tests the APK's own games: no automatic updates (ota-check.js
# points the app at its own fake server)
adb shell setprop debug.g2t.update_url off

node "$HERE/emulator-check.js" "$OUT" 2>&1 | tee "$OUT/resultado.txt"
code=${PIPESTATUS[0]}
node "$HERE/ota-check.js" "$OUT" 2>&1 | tee "$OUT/resultado-ota.txt"
code_ota=${PIPESTATUS[0]}
[ "$code" -eq 0 ] && code=$code_ota

adb exec-out screencap -p > "$OUT/final.png" || true
adb logcat -d -s g2t g2t-node chromium AndroidRuntime ActivityManager:W > "$OUT/logcat.txt" || true
adb shell dumpsys meminfo io.gametotv.android > "$OUT/meminfo-app.txt" || true
adb shell dumpsys meminfo io.gametotv.android:node > "$OUT/meminfo-node.txt" || true
echo "---- logcat (g2t) ----"
grep -E " (g2t|g2t-node)" "$OUT/logcat.txt" | tail -n 25 || true
# Last: a compact result (CI turns the tail into an annotation of at most 4 KB)
echo "---- resultado ----"
cat "$OUT/resultado.txt" "$OUT/resultado-ota.txt" | grep -E "^  (OK|FALLO)|^Resultado" | sed -e 's/^  OK     /OK /' -e 's/^  FALLO  /FALLO /' | cut -c1-90
exit $code
