#!/usr/bin/env bash
# Downloads nodejs-mobile's prebuilt libnode for Android (Node.js 18) into
# apps/android-tv/app/libnode/ (headers + libnode.so for armeabi-v7a,
# arm64-v8a and x86_64; the APKs only use the ARM ones, x86_64 is for the
# emulator test in CI). Used by .github/workflows/android.yml; also works locally.
# https://github.com/nodejs-mobile/nodejs-mobile/releases
set -euo pipefail

VERSION="${NODEJS_MOBILE_VERSION:-v18.20.4}"
SHA256="${NODEJS_MOBILE_SHA256:-bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af}"
URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${VERSION}/nodejs-mobile-${VERSION}-android.zip"

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/app/libnode"
if [ -f "$DEST/include/node/node.h" ] && [ -f "$DEST/VERSION" ] && [ "$(cat "$DEST/VERSION")" = "$VERSION" ]; then
  echo "nodejs-mobile $VERSION ya está en $DEST"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Descargando $URL"
curl -fsSL --retry 3 -o "$TMP/libnode.zip" "$URL"
echo "$SHA256  $TMP/libnode.zip" | sha256sum -c -
rm -rf "$DEST"
mkdir -p "$DEST"
unzip -q "$TMP/libnode.zip" 'include/*' 'bin/*' -d "$DEST"
echo "$VERSION" > "$DEST/VERSION"
ls -la "$DEST/bin"/*
