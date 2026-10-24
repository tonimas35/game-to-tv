'use strict';
/*
 * CI only: automatic game updates on the Android emulator (after
 * emulator-check.js). A local HTTP server on this machine plays the part of
 * the «apk» branch (the emulator reaches it at 10.0.2.2) with fake bundles
 * newer than the APK's, and the app is pointed at it with a property that
 * only adb can set (Updater.java):
 *
 *   adb shell setprop debug.g2t.update_url http://10.0.2.2:8765/<caso>/
 *
 *  ok          a newer bundle: downloaded (progress on screen), tried, kept
 *  ok again    no second download
 *  roto        main.js throws: Node dies, back to «ok», never downloaded again
 *  cuelga      main.js never answers /info: back to «ok» after 30 s
 *  corrupto    wrong sha256: not installed, «ok» starts
 *  nueva-app   minApp above this app: not downloaded
 *  sin red     GitHub unreachable (address that never answers): starts at once
 *
 *   node apps/android-tv/ci/ota-check.js OUT_DIR
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const cdp = require('../../../src/drivers/webos/cdp');
const { buildAndroidBundle, packOta } = require('../../../src/drivers/android/bundle');

const OUT = path.resolve(process.argv[2] || 'emulador');
const APP = 'io.gametotv.android';
const SERVER = 'http://127.0.0.1:18090';
const HOST_PORT = 8765;
const BASE = 'http://10.0.2.2:' + HOST_PORT + '/';
const DEVTOOLS_PORT = 19223;
fs.mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  OK     ' + label); } else { failed++; console.log('  FALLO  ' + label); }
  return cond;
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function adb(args, binary) {
  return execFileSync('adb', args, { encoding: binary ? null : 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
}
function sh(cmd) { try { return adb(['shell', cmd]).trim(); } catch (e) { return ''; } }
function shot(name) { try { fs.writeFileSync(path.join(OUT, name + '.png'), adb(['exec-out', 'screencap', '-p'], true)); } catch (e) { /* noop */ } }
function saveLog() { try { fs.appendFileSync(path.join(OUT, 'logcat-ota.txt'), logcat()); } catch (e) { /* noop */ } }
function logcat() { try { return adb(['logcat', '-d', '-s', 'g2t', 'g2t-node']); } catch (e) { return ''; } }
function getJson(url) {
  return new Promise(function (resolve, reject) {
    const req = http.get(url, { timeout: 3000 }, function (res) {
      let b = '';
      res.on('data', function (d) { b += d; });
      res.on('end', function () { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(400);
  }
  console.log('  (tiempo agotado: ' + label + (last ? ' · ' + last.message : '') + ')');
  return null;
}

// ---------------------------------------------------------------- fake «apk» branch
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'g2t-ota-'));
const B = { ok: 29990101000000, roto: 29990201000000, corrupto: 29990301000000, cuelga: 29990401000000, nuevaApp: 29990501000000 };
function make(name, build, opts) {
  opts = opts || {};
  const proj = path.join(TMP, name + '-proyecto');
  const meta = buildAndroidBundle({ outDir: proj, build: build, commit: 'prueba-' + name, minApp: opts.minApp }).meta;
  if (opts.main) fs.writeFileSync(path.join(proj, 'main.js'), opts.main);
  const m = packOta({ projectDir: proj, outDir: path.join(TMP, name) });
  if (opts.badSha) {
    m.sha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(TMP, name, 'bundle.json'), JSON.stringify(m, null, 2));
  }
  return meta.version;
}
const V = {
  ok: make('ok', B.ok),
  roto: make('roto', B.roto, { main: "'use strict';\nthrow new Error('Paquete roto a propósito (prueba de CI)');\n" }),
  corrupto: make('corrupto', B.corrupto, { badSha: true }),
  cuelga: make('cuelga', B.cuelga, { main: "'use strict';\n// Never answers /info (CI test)\nsetInterval(function () {}, 1000);\n" }),
  nuevaApp: make('nueva-app', B.nuevaApp, { minApp: 99999999 })
};
const hits = {};
let throttle = false;
const server = http.createServer(function (req, res) {
  const p = req.url.split('?')[0];
  hits[p] = (hits[p] || 0) + 1;
  const file = path.join(TMP, path.normalize(p).replace(/^([/\\])+/, ''));
  if (file.indexOf(TMP) !== 0 || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': /\.json$/.test(file) ? 'application/json' : 'application/zip', 'Content-Length': body.length });
  if (!throttle || !/\.zip$/.test(file)) { res.end(body); return; }
  // Slowly (about 4 s), so the progress can be seen on the loading screen
  let off = 0;
  const step = Math.ceil(body.length / 40);
  (function next() {
    if (off >= body.length) { res.end(); return; }
    res.write(body.slice(off, off + step));
    off += step;
    setTimeout(next, 100);
  })();
});
function count(p) { return hits[p] || 0; }

// ---------------------------------------------------------------- app
async function launch(url) {
  adb(['shell', 'am', 'force-stop', APP]);
  await waitFor(function () { return !sh('pidof ' + APP + ':node') && !sh('pidof ' + APP); }, 15000, 'force-stop');
  adb(['shell', 'setprop', 'debug.g2t.update_url', url]);
  if (sh('getprop debug.g2t.update_url') !== url) throw new Error('No se pudo poner debug.g2t.update_url = ' + url);
  saveLog();
  adb(['logcat', '-c']);
  const t0 = Date.now();
  adb(['shell', 'am', 'start', '-n', APP + '/.MainActivity']);
  adb(['forward', 'tcp:18090', 'tcp:8090']);
  return t0;
}
async function serving(version, ms) {
  return waitFor(async function () {
    const i = await getJson(SERVER + '/info');
    return i.tele && i.tele.bundle && i.tele.bundle.version === version ? i : null;
  }, ms || 120000, 'servidor con ' + version);
}
async function loadingTitle() {
  const pid = sh('pidof ' + APP).split(/\s+/)[0];
  if (!pid) return null;
  try { adb(['forward', '--remove', 'tcp:' + DEVTOOLS_PORT]); } catch (e) { /* none */ }
  adb(['forward', 'tcp:' + DEVTOOLS_PORT, 'localabstract:webview_devtools_remote_' + pid]);
  const t = ((await cdp.getJson('http://127.0.0.1:' + DEVTOOLS_PORT + '/json', 2000)) || []).filter(function (x) { return x.type === 'page' && /loading\.html/.test(x.url || ''); })[0];
  return t ? cdp.evaluate(t.webSocketDebuggerUrl, 'document.getElementById("title").textContent', 3000) : null;
}
async function footer() {
  const pid = sh('pidof ' + APP).split(/\s+/)[0];
  if (!pid) return null;
  try { adb(['forward', '--remove', 'tcp:' + DEVTOOLS_PORT]); } catch (e) { /* none */ }
  adb(['forward', 'tcp:' + DEVTOOLS_PORT, 'localabstract:webview_devtools_remote_' + pid]);
  const t = ((await cdp.getJson('http://127.0.0.1:' + DEVTOOLS_PORT + '/json', 2000)) || []).filter(function (x) { return x.type === 'page' && /^http:\/\/127\.0\.0\.1:8090\//.test(x.url || ''); })[0];
  return t ? cdp.evaluate(t.webSocketDebuggerUrl, '(function(){var e=document.getElementById("verTag");return e&&e.classList.contains("on")?e.textContent:"";})()', 3000) : null;
}

(async function () {
  await new Promise(function (r) { server.listen(HOST_PORT, '0.0.0.0', r); });
  console.log('\n=== Actualizaciones automáticas (paquetes falsos en ' + BASE + ') ===');
  console.log('    ' + JSON.stringify(V));

  // 1. A newer bundle: downloaded with progress, tried and kept
  throttle = true;
  await launch(BASE + 'ok/');
  const seen = [];
  let shotTaken = false;
  let info = await waitFor(async function () {
    const t = await loadingTitle().catch(function () { return null; });
    if (t && seen.indexOf(t) < 0) seen.push(t);
    if (t && !shotTaken && /Actualizando los juegos… \d+ %/.test(t)) { shotTaken = true; shot('ota-1-descargando'); }
    const i = await getJson(SERVER + '/info').catch(function () { return null; });
    return i && i.tele && i.tele.bundle && i.tele.bundle.version === V.ok ? i : null;
  }, 150000, 'servidor con ' + V.ok);
  throttle = false;
  console.log('    pantalla de carga: ' + JSON.stringify(seen.slice(0, 6)) + (seen.length > 6 ? ' … ' + JSON.stringify(seen.slice(-3)) : ''));
  check(seen.some(function (t) { return /^Actualizando los juegos… \d+ %$/.test(t); }), 'La pantalla de carga enseña «Actualizando los juegos… N %»');
  check(!!info && info.tele.bundle.source === 'descargado', 'Actualización aplicada: el servidor corre ' + V.ok + ' (descargado)');
  check(count('/ok/bundle.json') >= 1 && count('/ok/bundle.zip') === 1, 'Pidió bundle.json y bajó bundle.zip una vez');
  check(!!(await waitFor(function () { return /Actualización confirmada: los juegos 0\.\d+\.\d+\+29990101000000 funcionan/.test(logcat()); }, 15000, 'confirmación')), 'La app la confirma (respondió /info con esa versión)');
  const ft = await waitFor(function () { return footer().catch(function () { return null; }); }, 30000, 'versión en el menú');
  check(/^v\d+\.\d+\.\d+ · 01\/01\/2999 ↓$/.test(ft || ''), 'Pie del menú: «' + ft + '»');
  shot('ota-2-actualizada');

  // 2. Same version again: no second download
  let t0 = await launch(BASE + 'ok/');
  info = await serving(V.ok, 90000);
  const okSecs = (Date.now() - t0) / 1000;
  check(!!info && count('/ok/bundle.zip') === 1, 'Al volver a abrir sigue con ' + V.ok + ' sin descargar otra vez (' + okSecs.toFixed(1) + ' s)');

  // 3. A bundle whose Node dies at start: rollback, never retried
  await launch(BASE + 'roto/');
  info = await serving(V.ok, 120000);
  let log = logcat();
  check(!!info && count('/roto/bundle.zip') === 1, 'Paquete roto (Node termina con error): vuelve a ' + V.ok);
  check(/El paquete de juegos [^ ]+29990201000000 ha fallado \(el servidor se ha cerrado\)/.test(log), 'Lo marca como malo («el servidor se ha cerrado»)');
  await launch(BASE + 'roto/');
  info = await serving(V.ok, 90000);
  check(!!info && count('/roto/bundle.zip') === 1 && /ya falló en esta tele/.test(logcat()), 'Y no lo vuelve a descargar ni a probar');

  // 4. A bundle that never answers /info: rollback after 30 s
  t0 = await launch(BASE + 'cuelga/');
  info = await serving(V.ok, 150000);
  log = logcat();
  check(!!info && count('/cuelga/bundle.zip') === 1 && /29990401000000 ha fallado \(no responde en 30 s\)/.test(log), 'Paquete que no responde: a los 30 s vuelve a ' + V.ok + ' (' + Math.round((Date.now() - t0) / 1000) + ' s)');
  shot('ota-3-tras-fallo');

  // 5. Wrong sha256: not installed
  await launch(BASE + 'corrupto/');
  info = await serving(V.ok, 90000);
  check(!!info && count('/corrupto/bundle.zip') === 1 && /no coincide con bundle\.json/.test(logcat()), 'SHA-256 incorrecto: no se instala y arranca ' + V.ok);

  // 6. Needs a newer app: not downloaded
  await launch(BASE + 'nueva-app/');
  info = await serving(V.ok, 90000);
  check(!!info && count('/nueva-app/bundle.json') >= 1 && count('/nueva-app/bundle.zip') === 0 && /necesita una app más nueva/.test(logcat()), 'minApp mayor que la app: no se descarga');

  // 7. GitHub unreachable (an address that never answers): starts anyway, quickly
  t0 = await launch('http://10.255.255.1/');
  info = await serving(V.ok, 90000);
  const offSecs = (Date.now() - t0) / 1000;
  check(!!info && offSecs < okSecs + 8 && /sin respuesta de http:\/\/10\.255\.255\.1\//.test(logcat()), 'Sin conexión con GitHub arranca igual: ' + offSecs.toFixed(1) + ' s (con respuesta: ' + okSecs.toFixed(1) + ' s; espera máxima 4 s)');
  shot('ota-4-sin-red');

  // Leave updates off for whatever comes next
  adb(['shell', 'setprop', 'debug.g2t.update_url', 'off']);
  finish();
})().catch(function (e) {
  console.log(e && e.stack || e);
  failed++;
  finish();
});

function finish() {
  saveLog();
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log('\nResultado: ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}
