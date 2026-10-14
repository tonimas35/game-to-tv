#!/bin/bash
# End-to-end rehearsal of the one-click installers on Linux (manual, not part
# of `npm test`: it downloads ~50 MB from the npm registry and uses port 3000).
#
#   bash test/instalar/simular.sh
#
# nodejs.org is replaced by a local server with the SAME layout:
#  - node-vX-linux-x64.tar.gz  built from the official binary of the pinned
#    version (npm package node-linux-x64@X) + the local npm
#  - node-vX-win-x64.zip       node.exe (that same Linux binary) + node_modules/npm
#  - the app: `git archive HEAD` (commit your changes first)
# Mac: a copy of the .command with a Linux-x64 entry and the local URLs.
# Windows (if pwsh is installed): test/instalar/simular-windows.ps1.
# The «user» folders have spaces and accents («José Mª»).
# Checks: download + SHA-256 + extract + npm install + start, the TV page (/)
# and the phones' page (/m) answer, and a second run says «ya estaba en marcha».
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"
SRV_PID=""
FAILS=0
# shellcheck disable=SC2317  # called by the trap
cleanup() {
  pkill -f "game-to-tv[.]js start --navegador" 2>/dev/null
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$T"
}
trap cleanup EXIT
ok()   { printf '  OK     %s\n' "$1"; }
bad()  { printf '  FALLO  %s\n' "$1"; FAILS=$((FAILS + 1)); }
wait_port() { for _ in $(seq 1 90); do curl -fs -o /dev/null "http://127.0.0.1:$1/info" && return 0; sleep 1; done; return 1; }
check_pages() { # label
  local a b
  a="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/)"
  b="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/m)"
  if [ "$a" = 200 ] && [ "$b" = 200 ]; then ok "$1: la tele (/) y los móviles (/m) responden"; else bad "$1: / -> $a, /m -> $b"; fi
}
stop_server() { pkill -f "game-to-tv[.]js start --navegador" 2>/dev/null; sleep 1; }

if curl -fs -o /dev/null http://127.0.0.1:3000/info; then echo "El puerto 3000 está ocupado: cierra game-to-tv antes."; exit 2; fi
V="$(sed -n "s/^\$NodeVersion = '\(.*\)'.*/\1/p" "$ROOT/instalar/Juegos-del-Salon-Windows.bat" | tr -d '\r')"
echo "Node.js fijado: $V · carpeta temporal: $T"

# ---- fixtures ----
mkdir -p "$T/dl/dist/v$V" "$T/work"
(cd "$T/work" && npm pack "node-linux-x64@$V" --silent >/dev/null && tar -xzf "node-linux-x64-$V.tgz") || { echo "No se pudo descargar node-linux-x64@$V"; exit 2; }
NPM_DIR="$(cd "$(dirname "$(readlink -f "$(command -v npm)")")/.." && pwd)"
N="node-v$V-linux-x64"
mkdir -p "$T/work/$N/bin" "$T/work/$N/lib/node_modules"
cp "$T/work/package/bin/node" "$T/work/$N/bin/node"
cp -r "$NPM_DIR" "$T/work/$N/lib/node_modules/npm"
ln -s ../lib/node_modules/npm/bin/npm-cli.js "$T/work/$N/bin/npm"
(cd "$T/work" && tar -czf "$T/dl/dist/v$V/$N.tar.gz" "$N")
W="node-v$V-win-x64"
mkdir -p "$T/work/$W/node_modules"
cp "$T/work/package/bin/node" "$T/work/$W/node.exe"
cp -r "$NPM_DIR" "$T/work/$W/node_modules/npm"
(cd "$T/work" && zip -qr "$T/dl/dist/v$V/$W.zip" "$W") || echo "(sin «zip»: no se simula Windows)"
(cd "$ROOT" && git archive --format=tar.gz --prefix=game-to-tv-main/ -o "$T/dl/app.tar.gz" HEAD && git archive --format=zip --prefix=game-to-tv-main/ -o "$T/dl/app.zip" HEAD)
SHA_TGZ="$(sha256sum "$T/dl/dist/v$V/$N.tar.gz" | awk '{print $1}')"
SHA_ZIP="$(sha256sum "$T/dl/dist/v$V/$W.zip" 2>/dev/null | awk '{print $1}')"

node -e "
const http=require('http'),fs=require('fs'),path=require('path');const dir=process.argv[1];
http.createServer(function(q,r){const f=path.join(dir,decodeURIComponent(q.url.split('?')[0]));
fs.readFile(f,function(e,b){if(e){r.writeHead(404);return r.end();}r.writeHead(200);r.end(b);});}).listen(8765,'127.0.0.1');" "$T/dl" &
SRV_PID=$!
sleep 1
BASE="http://127.0.0.1:8765"

# ---- Mac ----
echo; echo "[Mac: Juegos-del-Salon-Mac.command]"
COPY="$T/Juegos del Salón (copia).command"
sed -e "s|^NODE_DIST_URL=.*|NODE_DIST_URL=\"$BASE/dist\"|" \
    -e "s|^REPO_TARBALL_URL=.*|REPO_TARBALL_URL=\"$BASE/app.tar.gz\"|" \
    -e "s|^    Darwin-arm64)  platform=|    Linux-x86_64) platform=\"linux-x64\"; sha=\"$SHA_TGZ\" ;;\n    Darwin-arm64)  platform=|" \
    "$ROOT/instalar/Juegos-del-Salon-Mac.command" > "$COPY"
chmod +x "$COPY"
# PATH without node, so the portable download is exercised
mkdir -p "$T/bin"
for t in bash sh curl tar gzip awk sha256sum shasum find head dirname mkdir rm mv sed uname cat env grep cp ln chmod printf sleep; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$T/bin/$t"
done
MH="$T/Users/José Mª"
mkdir -p "$MH"
run_mac() { HOME="$MH" PATH="$T/bin" G2T_NAVEGADOR=0 NO_COLOR=1 "$COPY" < /dev/null; }
run_mac > "$T/mac1.log" 2>&1 &
if wait_port 3000; then ok "Mac: instala Node.js $V y los juegos, y arranca"; check_pages "Mac"; else bad "Mac: no arranca"; cat "$T/mac1.log"; fi
if [ -x "$MH/Library/Application Support/game-to-tv/node/bin/node" ]; then ok "Mac: Node.js en ~/Library/Application Support/game-to-tv/node"; else bad "Mac: falta node"; fi
if grep -q "Deja esta ventana abierta mientras jugáis" "$T/mac1.log" && grep -q "Para salir, cierra esta ventana" "$T/mac1.log"; then ok "Mac: instrucciones sencillas"; else bad "Mac: faltan las instrucciones"; fi
if run_mac > "$T/mac2.log" 2>&1 && grep -q "ya estaba en marcha" "$T/mac2.log"; then ok "Mac: abrirlo otra vez con los juegos en marcha"; else bad "Mac: segunda vez"; cat "$T/mac2.log"; fi
stop_server
run_mac > "$T/mac3.log" 2>&1 &
if wait_port 3000 && grep -q "Buscando la última versión" "$T/mac3.log"; then ok "Mac: volver a abrirlo actualiza los juegos"; else bad "Mac: actualizar"; fi
stop_server

# ---- Windows ----
if command -v pwsh >/dev/null 2>&1 && [ -n "$SHA_ZIP" ]; then
  echo; echo "[Windows: Juegos-del-Salon-Windows.bat (con pwsh)]"
  WL="$T/Users/José Mª/AppData/Local"
  PWSH="$(command -v pwsh)"
  # PATH without node, so the portable download is exercised
  run_win() { PATH=/usr/bin:/bin "$PWSH" -NoProfile -File "$ROOT/test/instalar/simular-windows.ps1" -LocalAppData "$WL" -DistUrl "$BASE/dist" -RepoZip "$BASE/app.zip" -Sha "$SHA_ZIP" -Mode "${1:-}" < /dev/null; }
  run_win > "$T/win1.log" 2>&1 &
  if wait_port 3000; then ok "Windows: instala Node.js $V y los juegos, y arranca"; check_pages "Windows"; else bad "Windows: no arranca"; cat "$T/win1.log"; fi
  if [ -f "$WL/game-to-tv/Juegos-del-Salon.bat" ]; then ok "Windows: copia del lanzador para el icono del escritorio"; else bad "Windows: falta el lanzador"; fi
  if [ -s "$WL/game-to-tv/juegos.ico" ]; then ok "Windows: icono .ico"; else bad "Windows: falta el icono"; fi
  if run_win jugar > "$T/win2.log" 2>&1 && grep -q "ya estaba en marcha" "$T/win2.log"; then ok "Windows: abrirlo otra vez con los juegos en marcha"; else bad "Windows: segunda vez"; cat "$T/win2.log"; fi
  stop_server
else
  echo; echo "(sin pwsh o sin zip: no se simula Windows)"
fi

echo; echo "Fallos: $FAILS"
exit "$FAILS"
