#!/usr/bin/env bash
# CI: copies the release APKs to dist/ with their final names, checks what is
# inside (libnode, the Node project, the signature) and prints a summary.
#   bash apps/android-tv/ci/package-apks.sh VERSION
set -eu
V="$1"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUTDIR="$ROOT/apps/android-tv/app/build/outputs/apk/release"
DIST="$ROOT/dist"
mkdir -p "$DIST"
ls -la "$OUTDIR"
for abi in armeabi-v7a arm64-v8a universal; do
  cp "$OUTDIR/app-$abi-release.apk" "$DIST/juegos-del-salon-$V-$abi.apk"
done
BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
echo "build-tools: $BT"
for f in "$DIST"/*.apk; do
  echo "== $(basename "$f") $(du -h "$f" | cut -f1) ($(stat -c %s "$f") bytes)"
  unzip -l "$f" > "$DIST/.list"
  grep -E 'lib/|assets/nodejs-project/(main\.js|files\.txt|bundle\.json)' "$DIST/.list" || true
  grep -c 'assets/nodejs-project/' "$DIST/.list" | sed 's/^/   archivos del proyecto de Node: /'
  grep 'assets/nodejs-project/main.js' "$DIST/.list" > /dev/null
  grep 'libnode.so' "$DIST/.list" > /dev/null
  "$BT/apksigner" verify --print-certs "$f" | grep -E 'Signer #1 certificate (DN|SHA-256)' || true
  "$BT/aapt2" dump badging "$f" | grep -E "^(package|sdkVersion|targetSdkVersion|native-code|application-label:|leanback)" || true
done
rm -f "$DIST/.list"
(cd "$DIST" && sha256sum ./*.apk | sed 's# \./# #' > SHA256SUMS.txt && cat SHA256SUMS.txt)
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Juegos del Salón $V para Android TV"
    echo
    echo "| APK | Tamaño |"
    echo "|---|---|"
    for f in "$DIST"/*.apk; do echo "| $(basename "$f") | $(du -h "$f" | cut -f1) |"; done
  } >> "$GITHUB_STEP_SUMMARY"
fi
