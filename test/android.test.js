'use strict';
/*
 * Android TV / Google TV / Fire TV: the server entry that runs inside the app
 * (src/tv-service/android.js), the Node project bundled into the APK, the
 * artifact helpers (APK per ABI, unzip, GitHub download against a FAKE API)
 * and the «android» driver end to end with a FAKE adb (a shell script that
 * logs its arguments), like the ares-* tests of webOS.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const H_ = require('./helpers');
const android = require('../src/tv-service/android');
const bundleMod = require('../src/drivers/android/bundle');
const { buildAndroidBundle } = bundleMod;
const artifact = require('../src/drivers/android/artifact');
const adb = require('../src/drivers/android/adb');
const PKG = require('../package.json');

const check = H_.checker('Android TV: servidor dentro de la app, paquete, APKs y driver «android» (adb falso)');
const TMP = H_.tmpHome('g2t-android-');
const PORT = 18190;

function readConfig(home) { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); }

const { makeZip } = require('../src/drivers/android/zip');

function get(port, p) { return H_.httpGet('http://127.0.0.1:' + port, p); }

// ---------------------------------------------------------------- android.js
async function serverTests() {
  console.log('\n[src/tv-service/android.js: el servidor dentro de la app]');
  const a = android.parseArgs(['--host-ip', '192.168.1.77', '--port=8091', '--flag', '--device', 'Philips 50PUS7354/12']);
  check(a['host-ip'] === '192.168.1.77' && a.port === '8091' && a.flag === true && a.device === 'Philips 50PUS7354/12', 'Argumentos --x valor, --x=valor y banderas');
  check(android.validIp('192.168.1.77') && !android.validIp('192.168.1.777') && !android.validIp('fe80::1') && !android.validIp(true), 'Solo IPv4 válidas como --host-ip');

  const data = path.join(TMP, 'datos');
  let exited = 0;
  const app = android.main(['--host-ip', '192.168.1.77', '--port', String(PORT), '--data-dir', data, '--tmp-dir', path.join(TMP, 'cache'),
    '--idle-min', '0.004', '--sdk', '31', '--abi', 'armeabi-v7a', '--device', 'Philips 50PUS7354/12', '--net', 'ethernet', '--app-version', '9.9.9'],
  { console: null, exit: function () { exited++; } });
  const r = await app.ready;
  check(r.returnValue === true && r.ip === '192.168.1.77' && r.port === PORT && r.url === 'http://192.168.1.77:' + PORT + '/', 'Arranca en el puerto pedido con la IP que da Java: ' + r.url);
  const info = JSON.parse((await get(PORT, '/info')).body);
  check(info.mode === 'tele' && info.version === '9.9.9' && info.ip === '192.168.1.77' && info.movil === 'http://192.168.1.77:' + PORT + '/m', '/info: modo tele, versión de la app y la IP de Java para los móviles');
  const t = info.tele || {};
  check(t.platform === 'android' && t.sdk === 31 && t.abi === 'armeabi-v7a' && t.device === 'Philips 50PUS7354/12' && t.net === 'ethernet' && t.service === 'io.gametotv.android' && t.rssMB > 0,
    '/info.tele: plataforma android, API 31, ABI, aparato, red y memoria');
  check(t.galleryDir === path.join(data, 'galeria') && t.gallerySaving && info.actividad.slots === 6, 'Galería (y récords) dentro de la carpeta de datos de la app; 6 huecos');
  const expected = await QRCode.toString('http://192.168.1.77:' + PORT + '/m', { type: 'svg', margin: 2, width: 600, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  const qr = await get(PORT, '/qr.svg');
  check(qr.status === 200 && qr.body === expected, 'El QR apunta a http://192.168.1.77:' + PORT + '/m (la IP pasada, no la del PC)');
  const st = JSON.parse(fs.readFileSync(path.join(data, 'estado.json'), 'utf8'));
  check(st.state === 'running' && st.url === r.url && st.pid === process.pid, 'estado.json: running, con la URL');
  check(process.env.TMPDIR === path.join(TMP, 'cache'), '--tmp-dir pone TMPDIR (Android no tiene /tmp)');
  const logs = (await get(PORT, '/logs')).body;
  check(/Servidor io\.gametotv\.android cargado/.test(logs) && !/activityManager/.test(logs), 'Registro en /logs, sin avisos de webOS (keepAlive)');
  // Idle: no TV page and no players for idle-min -> stop + end of the process
  await H_.waitUntil(function () { return exited; }, 3000, 'apagado por inactividad');
  const st2 = JSON.parse(fs.readFileSync(path.join(data, 'estado.json'), 'utf8'));
  check(exited === 1 && st2.state === 'stopped' && st2.reason === 'inactividad', 'Sin tele ni jugadores: se apaga y pide terminar el proceso :node');
  let refused = false;
  try { await get(PORT, '/info'); } catch (e) { refused = true; }
  check(refused, 'Después, el puerto queda libre');

  // No usable IP from Java: falls back to os.networkInterfaces(), never crashes
  const app2 = android.main(['--host-ip', 'nada', '--port', String(PORT + 1), '--data-dir', path.join(TMP, 'datos2'), '--idle-min', '0'], { console: null, exit: function () {} });
  const r2 = await app2.ready;
  check(r2.returnValue === true && android.validIp(r2.ip) && /Sin --host-ip válida/.test(app2.tvService.logs().join('\n')), 'Sin IP válida de Java: usa la de las interfaces (' + r2.ip + ') y lo apunta en el registro');
  await app2.tvService.stop('prueba');

  // Port taken: error in estado.json, the process is not killed
  const blocker = http.createServer().listen(PORT + 2, '0.0.0.0');
  await new Promise(function (res) { blocker.once('listening', res); });
  let exited3 = 0;
  const app3 = android.main(['--host-ip', '192.168.1.77', '--port', String(PORT + 2), '--data-dir', path.join(TMP, 'datos3')], { console: null, exit: function () { exited3++; } });
  const r3 = await app3.ready;
  const st3 = JSON.parse(fs.readFileSync(path.join(TMP, 'datos3', 'estado.json'), 'utf8'));
  check(r3.returnValue === false && st3.state === 'error' && /ocupado/.test(st3.error) && exited3 === 0, 'Puerto ocupado: estado.json con el error («' + st3.error + '»)');
  blocker.close();
}

// ---------------------------------------------------------------- bundle
async function bundleTests() {
  console.log('\n[Proyecto de Node dentro del APK (assets/nodejs-project)]');
  const out = path.join(TMP, 'bundle', 'nodejs-project');
  const b = buildAndroidBundle({ outDir: out, commit: 'abc123' });
  const files = fs.readFileSync(path.join(out, 'files.txt'), 'utf8').trim().split('\n');
  check(files.length === b.files.length && files.every(function (f) { return fs.statSync(path.join(out, f)).isFile(); }), 'files.txt lista los ' + files.length + ' archivos y todos existen');
  check(files.indexOf('main.js') >= 0 && files.indexOf('src/tv-service/android.js') >= 0 && files.indexOf('src/tv-service/core.js') >= 0 && files.indexOf('public/tv.html') >= 0 &&
    files.indexOf('node_modules/ws/package.json') >= 0 && files.indexOf('node_modules/qrcode/package.json') >= 0 && files.indexOf('node_modules/pngjs/package.json') >= 0,
    'Lleva main.js, el servidor, los juegos, public/ y ws, qrcode y pngjs');
  check(!files.some(function (f) { return /^(src\/cli|src\/drivers|test|docs|apps|bin)\//.test(f) || /^node_modules\/(acorn|yargs)\//.test(f); }), 'Sin CLI, drivers, pruebas, documentación ni dependencias de desarrollo');
  check(!files.some(function (f) { return f.split('/').some(function (s) { return s.charAt(0) === '.'; }); }), 'Ningún archivo oculto (aapt los descartaría)');
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'bundle.json'), 'utf8'));
  const minApp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'android-tv', 'bundle-contract.json'), 'utf8')).minApp;
  check(pkg.name === 'io.gametotv.android' && pkg.version === PKG.version && pkg.main === 'main.js' && meta.commit === 'abc123' && meta.files === files.length - 1 &&
    meta.pkg === PKG.version && meta.version === PKG.version + '+' + meta.build && meta.minApp === minApp && minApp >= 80000,
    'package.json (io.gametotv.android ' + PKG.version + ') y bundle.json (' + meta.version + ', minApp ' + meta.minApp + ')');
  const git = bundleMod.gitBuild();
  check(git.build === null || (meta.build === git.build && /^\d{14}$/.test(String(meta.build))), 'build = hora UTC del commit (AAAAMMDDhhmmss): ' + meta.build);
  check(bundleMod.buildNumber('2026-10-24T15:30:12Z') === 20261024153012 && bundleMod.buildNumber(Date.UTC(2027, 0, 1)) > 20261231235959, 'Los builds crecen con la fecha del commit');
  check(b.bytes < 4 * 1024 * 1024, 'Pequeño: ' + Math.round(b.bytes / 1024) + ' KB');

  // Boot it like the app does (node main.js --host-ip … --data-dir …)
  const p = spawn(process.execPath, [path.join(out, 'main.js'), '--host-ip', '10.0.0.42', '--port', String(PORT + 3), '--data-dir', path.join(TMP, 'datos-bundle'), '--idle-min', '0.01',
    '--bundle-source', 'apk', '--app-version', '0.7.9', '--app-code', '70900'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', function (d) { log += d; });
  p.stderr.on('data', function (d) { log += d; });
  const exited = new Promise(function (res) { p.on('exit', function (code, sig) { res(sig || code); }); });
  await H_.waitUntil(function () { return /Servidor listo/.test(log); }, 8000, 'arranque del paquete');
  const info = JSON.parse((await get(PORT + 3, '/info')).body);
  check(info.ip === '10.0.0.42' && info.tele && info.tele.platform === 'android' && info.version === PKG.version, 'node main.js arranca el servidor del paquete (IP 10.0.0.42, versión ' + info.version + ')');
  const tb = info.tele.bundle || {};
  check(tb.version === meta.version && tb.build === meta.build && tb.commit === 'abc123' && tb.source === 'apk' && info.tele.app && info.tele.app.version === '0.7.9' && info.tele.app.code === 70900,
    '/info.tele.bundle: versión del paquete (' + tb.version + '), origen apk; tele.app: versión del APK');
  const tvPage = await get(PORT + 3, '/');
  check(tvPage.status === 200 && /atMainMenu/.test(tvPage.body) && /G2T_BOOT/.test(tvPage.body), 'La página de la tele del paquete tiene window.__tv.atMainMenu (lo usa «Atrás»)');
  const sig = await Promise.race([exited, H_.sleep(6000).then(function () { return 'sigue vivo'; })]);
  check(sig === 'SIGKILL', 'Tras el apagado por inactividad el proceso se mata a sí mismo (SIGKILL, como Process.killProcess): ' + sig);
  if (sig !== 'SIGKILL') { try { p.kill('SIGKILL'); } catch (e) { /* noop */ } }
}

// ---------------------------------------------------------------- automatic updates (bundle.zip + bundle.json)
async function otaTests() {
  console.log('\n[Actualizaciones automáticas: bundle.zip + bundle.json para la rama «apk»]');
  const proj = path.join(TMP, 'bundle', 'nodejs-project');
  const meta = JSON.parse(fs.readFileSync(path.join(proj, 'bundle.json'), 'utf8'));
  const outDir = path.join(TMP, 'ota');
  const m = bundleMod.packOta({ projectDir: proj, outDir: outDir });
  const zipFile = path.join(outDir, 'bundle.zip');
  const body = fs.readFileSync(zipFile);
  const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'bundle.json'), 'utf8'));
  check(m.version === meta.version && m.build === meta.build && m.minApp === meta.minApp && m.pkg === PKG.version && m.commit === 'abc123' && typeof m.built === 'string' &&
    JSON.stringify(onDisk) === JSON.stringify(m), 'bundle.json: { version, build, built, sha256, size, minApp } del mismo proyecto que va en el APK (' + m.version + ')');
  check(m.sha256 === crypto.createHash('sha256').update(body).digest('hex') && m.size === body.length, 'sha256 y tamaño del zip (' + Math.round(m.size / 1024) + ' KB)');
  const again = bundleMod.packOta({ projectDir: proj, outDir: path.join(TMP, 'ota2') });
  check(again.sha256 === m.sha256, 'El mismo proyecto da exactamente el mismo zip (fechas fijas)');

  const unz = path.join(TMP, 'ota-unzip');
  artifact.unzip(zipFile, unz);
  const files = bundleMod.listFiles(proj).sort();
  const same = files.every(function (f) { return fs.readFileSync(path.join(proj, f)).equals(fs.readFileSync(path.join(unz, f))); });
  check(same && bundleMod.listFiles(unz).length === files.length && files.indexOf('main.js') >= 0 && files.indexOf('bundle.json') >= 0, 'El zip tiene exactamente el proyecto (' + files.length + ' archivos, main.js y bundle.json incluidos)');
  let sys = null;
  try { sys = execFileSync('unzip', ['-tq', zipFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { sys = e.code === 'ENOENT' ? 'sin unzip' : 'ERROR ' + (e.stdout || e.message); }
  check(sys === 'sin unzip' || /No errors/.test(sys), 'unzip -t lo da por bueno (' + String(sys).trim() + ')');

  // The CLI form used by CI
  const cli = path.join(TMP, 'ota-cli');
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'android-bundle.js'), '--ota', cli, '--from', proj], { encoding: 'utf8' });
  check(/Paquete de juegos para actualizar la app/.test(out) && JSON.parse(fs.readFileSync(path.join(cli, 'bundle.json'), 'utf8')).sha256 === m.sha256, 'node scripts/android-bundle.js --ota SALIDA --from PROYECTO');
  const fake = path.join(TMP, 'np-fake');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'android-bundle.js'), fake, '--build', '29990101000000', '--min-app', '123', '--commit', 'fff'], { encoding: 'utf8' });
  const fm = JSON.parse(fs.readFileSync(path.join(fake, 'bundle.json'), 'utf8'));
  check(fm.version === PKG.version + '+29990101000000' && fm.build === 29990101000000 && fm.minApp === 123 && fm.commit === 'fff', '--build, --min-app y --commit (paquetes falsos para la prueba del emulador)');
  let bad = null;
  try { bundleMod.packOta({ projectDir: path.join(TMP, 'nada'), outDir: path.join(TMP, 'ota3') }); } catch (e) { bad = e; }
  check(!!bad, 'Sin proyecto no publica nada');

  // android.js: bundle info
  check(android.bundleInfo(null, 'apk') === null && android.bundleInfo({ version: '1+2', build: 2 }, 'otro').source === null && android.bundleInfo({ version: '1+2', build: 2, commit: '0123456789abcdef' }, 'descargado').commit === '0123456789ab',
    'tele.bundle: nulo sin bundle.json; origen solo apk/descargado');
}

// ---------------------------------------------------------------- artifact helpers
async function artifactTests() {
  console.log('\n[APKs: elegir por ABI, descomprimir, descargar de GitHub (API falsa)]');
  const apks = ['juegos-del-salon-0.7.0-arm64-v8a.apk', 'juegos-del-salon-0.7.0-armeabi-v7a.apk', 'juegos-del-salon-0.7.0-universal.apk'].map(function (f) { return '/x/' + f; });
  check(path.basename(artifact.pickApk(apks, ['armeabi-v7a', 'armeabi']).apk) === 'juegos-del-salon-0.7.0-armeabi-v7a.apk', 'Philips (armeabi-v7a,armeabi) → APK armeabi-v7a');
  check(path.basename(artifact.pickApk(apks, ['arm64-v8a', 'armeabi-v7a', 'armeabi']).apk) === 'juegos-del-salon-0.7.0-arm64-v8a.apk', 'Fire TV de 64 bits → APK arm64-v8a');
  check(artifact.pickApk(apks, ['x86_64']).abi === 'universal' && artifact.pickApk([], ['x86']) === null, 'ABI sin APK propio → universal; sin APKs → null');
  check(artifact.versionOf('/a/juegos-del-salon-0.7.0-armeabi-v7a.apk') === '0.7.0' && artifact.versionOf('x.apk') === null, 'Versión desde el nombre del APK');

  const zipFile = path.join(TMP, 'artefacto.zip');
  fs.writeFileSync(zipFile, makeZip([
    { name: 'juegos-del-salon-0.7.0-armeabi-v7a.apk', data: Buffer.alloc(5000, 7) },
    { name: 'juegos-del-salon-0.7.0-arm64-v8a.apk', data: 'arm64', store: true },
    { name: '../../fuera.txt', data: 'no' }
  ]));
  const dir = path.join(TMP, 'unzip');
  const written = artifact.unzip(zipFile, dir);
  check(written.length === 3 && fs.readFileSync(path.join(dir, 'juegos-del-salon-0.7.0-armeabi-v7a.apk')).equals(Buffer.alloc(5000, 7)) &&
    fs.readFileSync(path.join(dir, 'juegos-del-salon-0.7.0-arm64-v8a.apk'), 'utf8') === 'arm64', 'unzip: deflate y sin comprimir');
  check(fs.existsSync(path.join(dir, 'fuera.txt')) && !fs.existsSync(path.join(TMP, 'fuera.txt')), 'unzip no escribe fuera de la carpeta («../»)');
  check(artifact.findApks(dir).length === 2, 'findApks encuentra los .apk');

  // Fake GitHub: API (needs the token to download) + blob storage (must NOT get the token)
  const zipBody = makeZip([{ name: 'juegos-del-salon-0.7.0-armeabi-v7a.apk', data: 'v7a' }, { name: 'juegos-del-salon-0.7.0-universal.apk', data: 'uni' }]);
  const seen = { blobAuth: null, apiAuth: null, lists: 0 };
  const blob = http.createServer(function (req, res) { seen.blobAuth = req.headers.authorization || null; res.end(zipBody); });
  await new Promise(function (r) { blob.listen(0, '127.0.0.1', r); });
  const api = http.createServer(function (req, res) {
    if (/^\/repos\/tonimas35\/game-to-tv\/actions\/artifacts\?name=juegos-del-salon-android/.test(req.url)) {
      seen.lists++;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ artifacts: [
        { id: 1, name: 'juegos-del-salon-android', expired: false, created_at: '2026-10-01T10:00:00Z', archive_download_url: 'http://127.0.0.1:' + api.address().port + '/dl/1', workflow_run: { id: 10, head_branch: 'main' }, size_in_bytes: 100 },
        { id: 3, name: 'juegos-del-salon-android', expired: true, created_at: '2026-10-23T10:00:00Z', archive_download_url: 'http://127.0.0.1:' + api.address().port + '/dl/3', workflow_run: { id: 30, head_branch: 'main' } },
        { id: 2, name: 'juegos-del-salon-android', expired: false, created_at: '2026-10-20T10:00:00Z', archive_download_url: 'http://127.0.0.1:' + api.address().port + '/dl/2', workflow_run: { id: 20, head_branch: 'main' }, size_in_bytes: 100 }
      ] }));
    }
    if (req.url === '/dl/2') {
      seen.apiAuth = req.headers.authorization || null;
      if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{}'); }
      res.statusCode = 302;
      res.setHeader('Location', 'http://localhost:' + blob.address().port + '/blob/2.zip');
      return res.end();
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(function (r) { api.listen(0, '127.0.0.1', r); });
  process.env.GAME_TO_TV_GITHUB_API = 'http://127.0.0.1:' + api.address().port;
  const dl = await artifact.downloadLatest({ destRoot: path.join(TMP, 'gh'), token: 'tok' });
  check(dl.artifact.id === 2 && dl.apks.length === 2 && fs.readFileSync(artifact.pickApk(dl.apks, ['armeabi-v7a']).apk, 'utf8') === 'v7a', 'Descarga el artefacto más nuevo sin caducar (el 2) y lo descomprime');
  check(seen.apiAuth === 'Bearer tok' && seen.blobAuth === null, 'El token va a la API de GitHub, nunca al almacenamiento al que redirige');
  let noTok = null;
  try { await artifact.downloadLatest({ destRoot: path.join(TMP, 'gh2'), token: null }); } catch (e) { noTok = e; }
  check(noTok && noTok.code === 'ENOTOKEN' && /actions\/workflows\/android\.yml/.test(noTok.message) && /--apk/.test(noTok.message), 'Sin token: explica cómo descargarla a mano y usar --apk');
  return { api: api, blob: blob };
}

// ---------------------------------------------------------------- fake adb + CLI
function makeFakeAdb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'adb.log');
  const f = path.join(dir, 'adb');
  fs.writeFileSync(f, [
    '#!/bin/sh',
    'D="' + dir + '"',
    'n=0; line=""; for a in "$@"; do if [ $n -gt 0 ]; then line="$line|"; fi; line="$line$a"; n=$((n+1)); done',
    'echo "$line" >> "$D/adb.log"',
    'case "$*" in',
    '  "start-server") exit 0;;',
    '  "connect "*) if [ -f "$D/offline" ]; then echo "failed to connect to $2"; exit 1; fi; touch "$D/connected"; echo "connected to $2";;',
    '  *" get-state") if [ ! -f "$D/connected" ] || [ -f "$D/offline" ]; then echo "error: device \'$2\' not found" >&2; exit 1; fi; if [ -f "$D/unauth" ]; then echo "error: device unauthorized." >&2; exit 1; fi; echo device;;',
    '  *"shell getprop ro.product.cpu.abilist") echo "armeabi-v7a,armeabi";;',
    '  *" install -r "*) echo "Performing Streamed Install"; if [ -f "$D/badsig" ]; then echo "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package io.gametotv.android signatures do not match newer version]"; exit 1; fi; echo "Success";;',
    '  *"shell am start"*) echo "Starting: Intent { cmp=io.gametotv.android/.MainActivity }";;',
    '  *"shell input keyevent"*) ;;',
    '  *"exec-out screencap -p") printf "\\211PNG\\r\\n\\032\\nDATOS";;',
    '  *"shell getprop") echo "[ro.product.manufacturer]: [Philips]"; echo "[ro.product.model]: [50PUS7354/12]"; echo "[ro.build.version.release]: [12]"; echo "[ro.build.version.sdk]: [31]"; echo "[ro.product.cpu.abilist]: [armeabi-v7a,armeabi]";;',
    '  *"shell dumpsys package io.gametotv.android") echo "    versionName=0.7.0"; echo "    lastUpdateTime=2026-10-24 12:00:00";;',
    '  *"shell cat /proc/meminfo") echo "MemTotal:        2048000 kB"; echo "MemAvailable:     358400 kB";;',
    '  *"shell wm size") echo "Physical size: 1920x1080";;',
    '  *"shell wm density") echo "Physical density: 320";;',
    '  *"shell pidof io.gametotv.android:node") echo 4321;;',
    '  *"shell pidof io.gametotv.android") echo 1234;;',
    '  *) echo "adb falso: no sé hacer $*" >&2; exit 1;;',
    'esac',
    ''
  ].join('\n'));
  fs.chmodSync(f, 0o755);
  return { bin: f, dir: dir, log: log, lines: function () { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } } };
}

async function driverTests() {
  console.log('\n[Driver «android» con un adb falso]');
  if (process.platform === 'win32') { console.log('  (Windows: se omiten, el adb falso es un script de sh)'); return; }
  const fake = makeFakeAdb(path.join(TMP, 'adb-falso'));
  const HOME = path.join(TMP, 'home');
  const env = { GAME_TO_TV_HOME: HOME, GAME_TO_TV_ADB: fake.bin, GITHUB_TOKEN: '', GH_TOKEN: '', GAME_TO_TV_NO_GH: '1' };

  check(adb.find({ GAME_TO_TV_ADB: fake.bin, PATH: '' }) === fake.bin, 'GAME_TO_TV_ADB manda');
  check(adb.find({ PATH: fake.dir }) === fake.bin, 'Si no, adb del PATH');
  check(adb.find({ GAME_TO_TV_HOME: path.join(TMP, 'nada'), PATH: path.join(TMP, 'nada') }) === null || process.platform !== 'linux' || fs.existsSync(path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', 'adb')),
    'Sin adb en ningún sitio: null');

  let r = await H_.runCli(['tv', 'add', 'philips', '192.168.1.80', '--driver', 'android'], env);
  check(r.code === 0 && /tv pair philips/.test(r.out) && /tv install philips/.test(r.out) && /docs\/tele-android\.md/.test(r.out), 'tv add --driver android: siguientes pasos (pair, install, open)');

  r = await H_.runCli(['tv', 'pair', 'philips'], env);
  let lines = fake.lines();
  check(r.code === 0 && /Emparejada/.test(r.out) && readConfig(HOME).tvs.philips.pairedAt && !readConfig(HOME).tvs.philips.clientKey, 'tv pair: adb connect y autorizada (sin client-key propia)');
  check(lines.join(' ; ') === 'start-server ; -s|192.168.1.80:5555|get-state ; connect|192.168.1.80:5555 ; -s|192.168.1.80:5555|get-state', 'Primero «adb start-server» (servidor aparte), luego get-state, connect IP:5555 y get-state (' + lines.join(' ; ') + ')');
  r = await H_.runCli(['tv', 'list'], env);
  check(/philips\s+192\.168\.1\.80\s+\[Android TV \/ Google TV \/ Fire TV\]\s+emparejada/.test(r.out), 'tv list la muestra emparejada');

  // install from a folder with one APK per ABI
  const apkDir = path.join(TMP, 'apks');
  fs.mkdirSync(apkDir, { recursive: true });
  ['arm64-v8a', 'armeabi-v7a', 'universal'].forEach(function (abi) { fs.writeFileSync(path.join(apkDir, 'juegos-del-salon-0.7.0-' + abi + '.apk'), abi); });
  fs.writeFileSync(fake.log, '');
  r = await H_.runCli(['tv', 'install', 'philips', '--apk', apkDir], env);
  lines = fake.lines();
  const inst = lines.filter(function (l) { return /\|install\|/.test(l); })[0] || '';
  check(r.code === 0 && /App instalada/.test(r.out) && inst === '-s|192.168.1.80:5555|install|-r|' + path.join(apkDir, 'juegos-del-salon-0.7.0-armeabi-v7a.apk'), 'tv install --apk CARPETA: adb install -r con el APK de su ABI (armeabi-v7a)');
  check(lines.indexOf('-s|192.168.1.80:5555|shell|getprop|ro.product.cpu.abilist') >= 0, 'Pregunta la ABI con getprop ro.product.cpu.abilist');
  let tvc = readConfig(HOME).tvs.philips;
  check(tvc.mode === 'tele' && tvc.installedVersion === '0.7.0' && tvc.installedAt, 'Guarda versión y fecha de instalación');

  // install from the artifact zip
  const zip = path.join(TMP, 'juegos-del-salon-android.zip');
  fs.writeFileSync(zip, makeZip([{ name: 'juegos-del-salon-0.7.0-armeabi-v7a.apk', data: 'v7a' }, { name: 'juegos-del-salon-0.7.0-arm64-v8a.apk', data: 'a64' }]));
  fs.writeFileSync(fake.log, '');
  r = await H_.runCli(['tv', 'install', 'philips', '--apk', zip], env);
  const inst2 = fake.lines().filter(function (l) { return /\|install\|/.test(l); })[0] || '';
  check(r.code === 0 && /juegos-del-salon-0\.7\.0-armeabi-v7a\.apk$/.test(inst2) && fs.readFileSync(inst2.split('|').pop(), 'utf8') === 'v7a', 'tv install --apk ARTEFACTO.zip: lo descomprime e instala el armeabi-v7a');

  // install with no --apk: GitHub (fake API), with and without a token
  fs.writeFileSync(fake.log, '');
  r = await H_.runCli(['tv', 'install', 'philips'], Object.assign({}, env, { GAME_TO_TV_GITHUB_API: process.env.GAME_TO_TV_GITHUB_API, GITHUB_TOKEN: 'tok' }));
  const inst3 = fake.lines().filter(function (l) { return /\|install\|/.test(l); })[0] || '';
  check(r.code === 0 && /Descargando la app de GitHub Actions/.test(r.out) && /artefacto-2/.test(inst3) && /armeabi-v7a\.apk$/.test(inst3), 'tv install sin --apk: descarga el último artefacto de GitHub e instala el de su ABI');
  r = await H_.runCli(['tv', 'install', 'philips'], Object.assign({}, env, { GAME_TO_TV_GITHUB_API: process.env.GAME_TO_TV_GITHUB_API }));
  check(r.code === 1 && /sesión iniciada/.test(r.out) && /Artifacts/.test(r.out) && /--apk/.test(r.out), 'Sin token: pasos para descargarla a mano');

  fs.writeFileSync(path.join(fake.dir, 'badsig'), '');
  r = await H_.runCli(['tv', 'install', 'philips', '--apk', apkDir], env);
  fs.unlinkSync(path.join(fake.dir, 'badsig'));
  check(r.code === 1 && /INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(r.out) && /adb -s 192\.168\.1\.80:5555 uninstall io\.gametotv\.android/.test(r.out), 'Firma distinta: explica cómo desinstalar');
  r = await H_.runCli(['tv', 'install', 'philips', '--modo', 'pc', '--apk', apkDir], env);
  check(r.code === 1 && /siempre lleva el servidor dentro/.test(r.out), '--modo pc no tiene sentido en Android');

  // open (with a path that has a space: arrives as ONE word, no local shell)
  fs.writeFileSync(fake.log, '');
  r = await H_.runCli(['tv', 'open', 'philips', '--ruta', '/ambiente'], env);
  lines = fake.lines();
  check(r.code === 0 && lines.indexOf('-s|192.168.1.80:5555|shell|am|start|-n|io.gametotv.android/.MainActivity|--es|path|/ambiente') >= 0 && lines.indexOf('-s|192.168.1.80:5555|shell|input|keyevent|KEYCODE_WAKEUP') >= 0,
    'tv open --ruta /ambiente: despierta la tele y am start -n io.gametotv.android/.MainActivity --es path /ambiente');
  fs.writeFileSync(fake.log, '');
  await H_.runCli(['tv', 'open', 'philips', '--ruta', "/a b'c"], env);
  check(fake.lines().some(function (l) { return l === "-s|192.168.1.80:5555|shell|am|start|-n|io.gametotv.android/.MainActivity|--es|path|'/a b'\\''c'"; }), 'Sin shell local: los argumentos llegan intactos a adb (y entrecomillados para el sh de la tele)');

  fs.writeFileSync(fake.log, '');
  r = await H_.runCli(['tv', 'key', 'philips', 'ENTER'], env);
  check(r.code === 0 && fake.lines().indexOf('-s|192.168.1.80:5555|shell|input|keyevent|KEYCODE_DPAD_CENTER') >= 0, 'tv key ENTER → input keyevent KEYCODE_DPAD_CENTER');

  const shot = path.join(TMP, 'captura.jpg');
  r = await H_.runCli(['tv', 'shot', 'philips', shot], env);
  const png = path.join(TMP, 'captura.png');
  check(r.code === 0 && fs.existsSync(png) && fs.readFileSync(png).readUInt32BE(0) === 0x89504e47 && new RegExp('captura\\.png').test(r.out), 'tv shot: adb exec-out screencap -p, guardada como .png');

  r = await H_.runCli(['tv', 'info', 'philips'], env);
  let info = null;
  try { info = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch (e) { /* noop */ }
  check(info && info.device.model === '50PUS7354/12' && info.android.sdk === 31 && info.abis.join(',') === 'armeabi-v7a,armeabi' && info.memory.available === '350 MB' &&
    info.screen.size === '1920x1080' && info.app.version === '0.7.0' && /4321/.test(info.app.serverProcess), 'tv info: modelo, Android 12 (API 31), ABIs, memoria libre, pantalla, versión de la app y proceso :node');

  // status: the server inside the TV (here, android.js on this PC)
  const app = android.main(['--host-ip', '127.0.0.1', '--port', String(PORT + 4), '--data-dir', path.join(TMP, 'datos-status'), '--idle-min', '0', '--sdk', '31', '--abi', 'armeabi-v7a', '--device', 'Philips 50PUS7354/12',
    '--app-version', '0.8.0', '--app-code', '80000', '--bundle-source', 'descargado'],
  { console: null, exit: function () {}, bundle: { version: '0.8.1+20261101120000', pkg: '0.8.1', build: 20261101120000, commit: 'abcdef1234567890' } });
  await app.ready;
  await H_.runCli(['tv', 'add', 'local', '127.0.0.1', '--driver', 'android'], env);
  r = await H_.runCli(['tv', 'status', 'local', '--puerto', String(PORT + 4), '--logs'], env);
  check(r.code === 0 && /respondiendo/.test(r.out) && /Android \(API 31\)/.test(r.out) && /Philips 50PUS7354\/12/.test(r.out) && /Registro del servidor/.test(r.out), 'tv status: el servidor de dentro de la tele (Android, API, aparato) y su registro');
  check(/Juegos: 0\.8\.1\+20261101120000 · descargado \(actualización automática\) · commit abcdef1 · app 0\.8\.0 \(80000\)/.test(r.out) && /versión 0\.8\.1/.test(r.out),
    'tv status: versión del paquete de juegos y su origen (descargado), y la de la app');
  await app.tvService.stop('prueba');
  r = await H_.runCli(['tv', 'status', 'local', '--puerto', String(PORT + 4)], env);
  check(r.code === 1 && /no responde/.test(r.out) && /15 min/.test(r.out), 'tv status con la app cerrada: explica el apagado tras 15 min');

  // unauthorized / offline
  fs.writeFileSync(path.join(fake.dir, 'unauth'), '');
  r = await H_.runCli(['tv', 'open', 'philips'], env);
  fs.unlinkSync(path.join(fake.dir, 'unauth'));
  check(r.code === 1 && /no ha autorizado/.test(r.out) && /Permitir siempre/.test(r.out), 'Sin autorizar: explica el aviso «¿Permitir la depuración?»');
  fs.writeFileSync(path.join(fake.dir, 'offline'), '');
  r = await H_.runCli(['tv', 'open', 'philips'], env);
  fs.unlinkSync(path.join(fake.dir, 'offline'));
  check(r.code === 1 && /No puedo conectar con «philips» por adb/.test(r.out) && /tele-android\.md/.test(r.out), 'Tele apagada o sin depuración: mensaje útil');

  // no adb at all
  const empty = path.join(TMP, 'vacio');
  fs.mkdirSync(empty, { recursive: true });
  r = await H_.runCli(['tv', 'install', 'philips', '--apk', apkDir], Object.assign({}, env, { GAME_TO_TV_ADB: '', PATH: empty, ANDROID_HOME: '', ANDROID_SDK_ROOT: '', HOME: empty, LOCALAPPDATA: empty }));
  check(r.code === 1 && /No encuentro «adb»/.test(r.out) && /platform-tools/.test(r.out), 'Sin adb: cómo instalar platform-tools');

  // doctor (read-only): adb found, the Android TV listed
  fs.writeFileSync(fake.log, '');
  r = await H_.runCli(['doctor'], env, { timeout: 30000 });
  check(/adb encontrado/.test(r.out) && /Tele «philips» \(Android TV/.test(r.out), 'doctor: adb y la tele Android');
  check(fake.lines().length === 0, 'doctor no ejecuta adb (solo mira si está y prueba los puertos)');
}

(async function () {
  let servers = null;
  try {
    await serverTests();
    await bundleTests();
    await otaTests();
    servers = await artifactTests();
    await driverTests();
  } catch (e) {
    console.log(e && e.stack || e);
    check.fail('Excepción: ' + (e && e.message));
  } finally {
    if (servers) { servers.api.close(); servers.blob.close(); }
    H_.rmrf(TMP);
  }
  check.done();
})();
