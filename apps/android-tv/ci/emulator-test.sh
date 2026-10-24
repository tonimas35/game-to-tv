#!/usr/bin/env bash
# CI only (.github/workflows/android.yml, job «emulador»): installs the x86_64
# build on a running emulator and runs emulator-check.js (Node, CDP, keys).
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

node "$HERE/emulator-check.js" "$OUT"
code=$?

adb exec-out screencap -p > "$OUT/final.png" || true
adb logcat -d -s g2t g2t-node chromium AndroidRuntime ActivityManager:W > "$OUT/logcat.txt" || true
adb shell dumpsys meminfo io.gametotv.android > "$OUT/meminfo-app.txt" || true
adb shell dumpsys meminfo io.gametotv.android:node > "$OUT/meminfo-node.txt" || true
tail -n 60 "$OUT/logcat.txt" || true
exit $code
