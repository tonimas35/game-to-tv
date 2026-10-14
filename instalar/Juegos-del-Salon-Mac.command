#!/bin/bash
# Juegos del Salón (game-to-tv): instalador y lanzador para Mac. Haz doble clic.
#
# La primera vez macOS puede decir que «no se puede abrir porque es de un
# desarrollador no identificado». Entonces: clic derecho (o Control + clic)
# sobre el archivo > «Abrir» > «Abrir». En macOS 15 o posterior: intenta
# abrirlo una vez, ve a Ajustes del Sistema > Privacidad y seguridad y pulsa
# «Abrir igualmente». Solo hace falta la primera vez.
#
# What it does (no admin rights, no Homebrew):
#  1. Node.js 18+ already installed? Use it. Otherwise download the official
#     Node.js (pinned version, SHA-256 checked) into
#     ~/Library/Application Support/game-to-tv/node
#  2. Download game-to-tv (GitHub tarball of the main branch) into
#     ~/Library/Application Support/game-to-tv/app and run `npm install`.
#     On re-runs, update it the same way (the user's ~/.game-to-tv is
#     untouched; the old version stays if anything fails or there is no
#     Internet).
#  3. `game-to-tv start --navegador --sencillo`: server + TV page full screen.
# Written for the bash 3.2 that comes with macOS. Keep it LF + executable.

set -u

NODE_VERSION="22.23.3"
# SHA-256 from https://nodejs.org/dist/v22.23.3/SHASUMS256.txt
NODE_SHA256_DARWIN_ARM64="23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53"
NODE_SHA256_DARWIN_X64="8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8"
NODE_DIST_URL="https://nodejs.org/dist"
REPO_TARBALL_URL="https://codeload.github.com/tonimas35/game-to-tv/tar.gz/refs/heads/main"
PORT=3000
PHOTO_HINT="Haz una foto de esta pantalla y envíasela a quien te pasó el archivo."

BASE="$HOME/Library/Application Support/game-to-tv"
NODE_DIR="$BASE/node"
APP_DIR="$BASE/app"
TMP_DIR="$BASE/tmp"

# ------------------------------------------------------------------ messages --

say()  { printf '  %s\n' "$1"; }
step() { printf '\n  \033[36m>> %s\033[0m\n' "$1"; }
good() { printf '     \033[32mHecho: %s\033[0m\n' "$1"; }
warn() { printf '     \033[33mOjo: %s\033[0m\n' "$1"; }

wait_enter() {
  printf '\n'
  read -r -p "  Pulsa Enter para cerrar esta ventana " _ || true
}

fail() {
  printf '\n  \033[31m%s\033[0m\n\n' "$1"
  printf '  \033[33m%s\033[0m\n' "$PHOTO_HINT"
  wait_enter
  exit 1
}

banner() {
  printf '\n'
  printf '  \033[35m╔════════════════════════════════════════════════════╗\033[0m\n'
  printf '  \033[35m║          JUEGOS DEL SALÓN  ·  game-to-tv           ║\033[0m\n'
  printf '  \033[35m╚════════════════════════════════════════════════════╝\033[0m\n'
  say "La tele es la pantalla y los móviles son los mandos."
  if [ ! -d "$APP_DIR" ]; then say "La primera vez tarda unos minutos: descarga unos 50 MB de Internet."; fi
}

# ------------------------------------------------------------------ helpers --

download() { # url file
  curl -fL --retry 3 --connect-timeout 20 --progress-bar -o "$2" "$1"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

node_major() { # node binary -> major version (0 if it does not run)
  local v
  v="$("$1" -v 2>/dev/null)" || { echo 0; return; }
  v="${v#v}"
  case "${v%%.*}" in ''|*[!0-9]*) echo 0 ;; *) echo "${v%%.*}" ;; esac
}

port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
}

# -------------------------------------------------------------------- Node ---

NODE=""
NPM=""

use_node_dir() { # bin dir with node and npm
  NODE="$1/node"
  NPM="$1/npm"
  export PATH="$1:$PATH"   # npm runs with this same node
}

portable_ok() {
  [ -x "$NODE_DIR/bin/node" ] && [ -e "$NODE_DIR/bin/npm" ] && [ "$(node_major "$NODE_DIR/bin/node")" -ge 18 ]
}

find_node() {
  step "Comprobando Node.js, el motor de los juegos..."
  local sys
  sys="$(command -v node 2>/dev/null || true)"
  if [ -n "$sys" ] && [ "$(node_major "$sys")" -ge 18 ] && [ -x "$(dirname "$sys")/npm" ]; then
    use_node_dir "$(dirname "$sys")"
    good "Uso el Node.js que ya tenías instalado ($("$sys" -v))."
    return
  fi
  if portable_ok && [ "$("$NODE_DIR/bin/node" -v)" = "v$NODE_VERSION" ]; then
    use_node_dir "$NODE_DIR/bin"
    return
  fi

  local arch platform sha
  arch="$(uname -m)"
  # A Terminal running under Rosetta says x86_64 on an Apple Silicon Mac
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then arch="arm64"; fi
  case "$(uname -s)-$arch" in
    Darwin-arm64)  platform="darwin-arm64"; sha="$NODE_SHA256_DARWIN_ARM64" ;;
    Darwin-x86_64) platform="darwin-x64";   sha="$NODE_SHA256_DARWIN_X64" ;;
    *) fail "Este archivo es para Mac. En Windows, usa «Juegos-del-Salon-Windows.bat»." ;;
  esac
  local name="node-v$NODE_VERSION-$platform"
  local url="$NODE_DIST_URL/v$NODE_VERSION/$name.tar.gz"
  local file="$TMP_DIR/$name.tar.gz"
  step "Descargando Node.js $NODE_VERSION, el motor de los juegos (unos 50 MB)..."
  mkdir -p "$TMP_DIR" || fail "No puedo crear la carpeta $TMP_DIR."
  if ! download "$url" "$file"; then
    if portable_ok; then
      warn "No he podido descargar Node.js (¿sin Internet?). Sigo con el que ya tenías."
      use_node_dir "$NODE_DIR/bin"
      return
    fi
    fail "No he podido descargar Node.js. ¿Tiene Internet este Mac? ($url)"
  fi
  if [ "$(sha256_of "$file")" != "$sha" ]; then
    rm -f "$file"
    fail "El Node.js descargado no es el oficial (la comprobación de seguridad no coincide), así que no lo instalo."
  fi
  say "Descomprimiendo..."
  rm -rf "$TMP_DIR/node-nuevo"
  mkdir -p "$TMP_DIR/node-nuevo"
  tar -xzf "$file" -C "$TMP_DIR/node-nuevo" || fail "No he podido descomprimir Node.js."
  [ -x "$TMP_DIR/node-nuevo/$name/bin/node" ] || fail "El archivo de Node.js descargado no tiene lo que esperaba."
  rm -rf "$NODE_DIR"
  mv "$TMP_DIR/node-nuevo/$name" "$NODE_DIR" || fail "No he podido instalar Node.js en $NODE_DIR."
  rm -rf "$TMP_DIR/node-nuevo" "$file"
  portable_ok || fail "Node.js no arranca en este Mac."
  use_node_dir "$NODE_DIR/bin"
  good "Node.js $NODE_VERSION ($platform) listo."
}

# --------------------------------------------------------------------- app ---

update_app() {
  local has_app=0
  if [ -f "$APP_DIR/bin/game-to-tv.js" ] && [ -d "$APP_DIR/node_modules/ws" ]; then has_app=1; fi
  if [ "$has_app" = 1 ]; then step "Buscando la última versión de los juegos..."; else step "Descargando los juegos..."; fi
  mkdir -p "$TMP_DIR" || fail "No puedo crear la carpeta $TMP_DIR."
  local file="$TMP_DIR/game-to-tv.tar.gz"
  if ! download "$REPO_TARBALL_URL" "$file"; then
    if [ "$has_app" = 1 ]; then warn "No he podido buscar la última versión (¿sin Internet?). Sigo con la que ya tenías."; return; fi
    fail "No he podido descargar los juegos. ¿Tiene Internet este Mac? ($REPO_TARBALL_URL)"
  fi
  local x="$TMP_DIR/app-nueva"
  rm -rf "$x"
  mkdir -p "$x"
  tar -xzf "$file" -C "$x" || fail "No he podido descomprimir los juegos."
  rm -f "$file"
  local inner
  inner="$(find "$x" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -z "$inner" ] || [ ! -f "$inner/bin/game-to-tv.js" ]; then fail "Lo descargado no tiene los juegos que esperaba."; fi
  say "Preparando los juegos (npm install)..."
  if ! (cd "$inner" && npm_config_update_notifier=false "$NPM" install --omit=dev --no-audit --no-fund --loglevel=error); then
    rm -rf "$x"
    if [ "$has_app" = 1 ]; then warn "No he podido preparar la versión nueva. Sigo con la que ya tenías."; return; fi
    fail "No he podido preparar los juegos (npm install ha fallado). ¿Tiene Internet este Mac?"
  fi
  # Swap only now: if anything above failed, the old version is still there
  rm -rf "$BASE/app-vieja"
  if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$BASE/app-vieja" || fail "No he podido cambiar a la versión nueva."; fi
  mv "$inner" "$APP_DIR" || fail "No he podido instalar los juegos en $APP_DIR."
  rm -rf "$x" "$BASE/app-vieja"
  good "Juegos listos (versión $("$NODE" -p "require(process.argv[1]).version" "$APP_DIR/package.json" 2>/dev/null || echo '?'))."
}

# -------------------------------------------------------------------- main ---

main() {
  banner
  mkdir -p "$BASE" || fail "No puedo crear la carpeta $BASE."
  if port_open && [ -f "$APP_DIR/bin/game-to-tv.js" ]; then
    # Already running in another window: do not touch the files it is using
    say "Parece que Juegos del Salón ya está en marcha en otra ventana."
    if [ -x "$NODE_DIR/bin/node" ]; then use_node_dir "$NODE_DIR/bin"; else find_node; fi
  else
    find_node
    update_app
  fi
  say ""
  say "Si el Mac pregunta si «node» puede aceptar conexiones entrantes, pulsa «Permitir»."
  step "Arrancando los juegos..."
  cd "$APP_DIR" || fail "No encuentro los juegos en $APP_DIR."
  "$NODE" bin/game-to-tv.js start --navegador --sencillo
  local code=$?
  # 130/143: closed with Ctrl+C or the window was closed
  if [ "$code" != 0 ] && [ "$code" != 130 ] && [ "$code" != 143 ]; then
    printf '\n  \033[31mLos juegos se han parado (código %s).\033[0m\n' "$code"
    printf '  \033[33m%s\033[0m\n' "$PHOTO_HINT"
  fi
  wait_enter
}

main "$@"
