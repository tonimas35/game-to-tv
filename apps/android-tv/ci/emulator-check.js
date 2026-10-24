'use strict';
/*
 * CI only: checks the app on an Android emulator (Android 12, «Android TV
 * (1080p)» profile) through adb and the WebView's DevTools (CDP):
 *  - the :node process starts and http://127.0.0.1:8090/info answers (mode tele, android)
 *  - the TV page loads in the WebView and its 1920x1080 stage fits the screen
 *  - remote keys: D-pad moves the menu, OK opens a section, Back = Escape
 *    (closes it), at the main menu one Back stays and two Backs exit
 *  - after exiting, the server keeps running (no TV page) and a new launch reuses it
 * Screenshots go to OUT_DIR.  node apps/android-tv/ci/emulator-check.js OUT_DIR
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const cdp = require('../../../src/drivers/webos/cdp');

const OUT = path.resolve(process.argv[2] || 'emulador');
const APP = 'io.gametotv.android';
const SERVER = 'http://127.0.0.1:18090';
const DEVTOOLS_PORT = 19222;
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
function key(k) { adb(['shell', 'input', 'keyevent'].concat(k.split(' '))); }
function shot(name) { try { fs.writeFileSync(path.join(OUT, name + '.png'), adb(['exec-out', 'screencap', '-p'], true)); } catch (e) { console.log('  (captura ' + name + ': ' + e.message + ')'); } }
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
    await sleep(500);
  }
  console.log('  (tiempo agotado: ' + label + (last ? ' · ' + last.message : '') + ')');
  return null;
}
function foreground() {
  const a = sh('dumpsys activity activities | grep -E "ResumedActivity"');
  return a.indexOf(APP + '/.MainActivity') >= 0;
}

let wsUrl = null;
async function page() {
  const pid = sh('pidof ' + APP).split(/\s+/)[0];
  if (!pid) return null;
  try { adb(['forward', '--remove', 'tcp:' + DEVTOOLS_PORT]); } catch (e) { /* none yet */ }
  adb(['forward', 'tcp:' + DEVTOOLS_PORT, 'localabstract:webview_devtools_remote_' + pid]);
  const targets = await cdp.getJson('http://127.0.0.1:' + DEVTOOLS_PORT + '/json');
  const t = (targets || []).filter(function (x) { return x.type === 'page' && /^http:\/\/127\.0\.0\.1:8090\//.test(x.url || ''); })[0];
  if (!t) return null;
  wsUrl = t.webSocketDebuggerUrl;
  return (await ev('!!(window.__tv && window.__tv.menu)')) ? t : null;
}
function ev(expr) { return cdp.evaluate(wsUrl, expr, 15000); }
async function menu() { return ev('window.__tv.menu()'); }

(async function () {
  console.log('\n=== Juegos del Salón en un emulador de tele (Android ' + sh('getprop ro.build.version.release') + ', ' + sh('wm size') + ', ' + sh('wm density') + ') ===');
  adb(['shell', 'am', 'start', '-n', APP + '/.MainActivity']);
  await sleep(1500);
  shot('1-arranque');
  adb(['forward', 'tcp:18090', 'tcp:8090']);
  const info = await waitFor(function () { return getJson(SERVER + '/info'); }, 150000, '/info');
  if (!check(!!info, 'El servidor de dentro de la app responde en :8090/info')) { finish(); return; }
  const t = info.tele || {};
  console.log('    ' + JSON.stringify({ ip: info.ip, version: info.version, node: t.node, abi: t.abi, sdk: t.sdk, device: t.device, net: t.net, rssMB: t.rssMB, gallery: t.galleryDir }));
  check(info.mode === 'tele' && t.platform === 'android' && /^v18\./.test(t.node || ''), 'Modo tele, plataforma android, Node 18 (nodejs-mobile): ' + t.node);
  check(/^\d+\.\d+\.\d+\.\d+$/.test(info.ip) && info.ip !== '127.0.0.1', 'IP para el QR desde ConnectivityManager: ' + info.ip + ' (' + t.net + ')');
  check(t.gallerySaving && /\/files\/datos\/galeria$/.test(t.galleryDir || ''), 'Galería en la carpeta de la app: ' + t.galleryDir);
  const pidMain = sh('pidof ' + APP);
  const pidNode = sh('pidof ' + APP + ':node');
  check(pidMain && pidNode && pidMain !== pidNode, 'Dos procesos: la app (' + pidMain + ') y :node (' + pidNode + ')');

  if (!check(!!(await waitFor(page, 60000, 'página de la tele en el WebView')), 'El WebView abre http://127.0.0.1:8090/')) { finish(); return; }
  await sleep(1500);
  shot('2-menu');
  const env = await ev('(function(){var r=document.getElementById("stage").getBoundingClientRect();var vv=window.visualViewport;' +
    'return {w:innerWidth,h:innerHeight,dpr:devicePixelRatio,vw:vv?vv.width:null,vh:vv?vv.height:null,ua:navigator.userAgent,maxw:G2T.MAXW,' +
    'stage:{x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)},screen:__tv.screen(),atMain:__tv.atMainMenu()};})()');
  console.log('    ' + JSON.stringify(env));
  check(env.stage.w <= env.w + 1 && env.stage.h <= env.h + 1 && (env.stage.w >= env.w - 2 || env.stage.h >= env.h - 2), 'El escenario 1920x1080 cabe en la pantalla (' + env.stage.w + 'x' + env.stage.h + ' en ' + env.w + 'x' + env.h + ' CSS, dpr ' + env.dpr + ')');
  check(/JuegosDelSalon-Android\//.test(env.ua) && env.maxw === 1280, 'User agent con JuegosDelSalon-Android y canvas limitados a 1280 px');
  check(env.screen === 'menu' && env.atMain === true, 'En el menú principal (window.__tv.atMainMenu)');

  // D-pad
  let m = await menu();
  const i0 = m.index;
  key('KEYCODE_DPAD_RIGHT');
  check(!!(await waitFor(async function () { return (await menu()).index === i0 + 1; }, 8000, 'flecha derecha')), 'D-pad derecha mueve el menú (' + i0 + ' → ' + (i0 + 1) + ')');
  key('KEYCODE_DPAD_LEFT');
  check(!!(await waitFor(async function () { return (await menu()).index === i0; }, 8000, 'flecha izquierda')), 'D-pad izquierda vuelve');

  // OK opens a section; Back (Escape) closes it
  m = await menu();
  const sec = (m.cards || []).filter(function (c) { return /^card-sec-/.test(c); })[0];
  if (check(!!sec, 'Hay una tarjeta de sección (' + sec + ')')) {
    const id = sec.replace(/^card-/, '');
    for (let n = 0; n < 20; n++) {
      const step = await ev('window.__tv.menuStep(' + JSON.stringify(id) + ')');
      if (!step) break;
      key(step === 'ArrowLeft' ? 'KEYCODE_DPAD_LEFT' : step === 'ArrowRight' ? 'KEYCODE_DPAD_RIGHT' : 'KEYCODE_DPAD_CENTER');
      await sleep(400);
    }
    key('KEYCODE_DPAD_CENTER');
    check(!!(await waitFor(async function () { return (await menu()).row !== 'main'; }, 8000, 'abrir sección')), 'OK (centro del D-pad) abre la sección');
    shot('3-seccion');
    check(!(await ev('__tv.atMainMenu()')), 'Dentro de una sección no es el menú principal');
    key('KEYCODE_BACK');
    check(!!(await waitFor(async function () { return (await menu()).row === 'main'; }, 8000, 'cerrar sección')), 'Atrás llega a la página como Escape y cierra la sección');
    check(foreground(), 'La app sigue delante');
  }

  // Media key: play/pause = OK (opens the section card that has the focus again)
  if (sec) {
    key('KEYCODE_MEDIA_PLAY_PAUSE');
    check(!!(await waitFor(async function () { return (await menu()).row !== 'main'; }, 8000, 'play/pausa')), 'Play/pausa del mando hace de OK');
    key('KEYCODE_MEDIA_STOP');
    check(!!(await waitFor(async function () { return (await menu()).row === 'main'; }, 8000, 'stop')), 'Stop del mando hace de Atrás');
  }

  // Two phones join (through the forwarded port, like phones on the Wi-Fi),
  // a game starts and Back on the remote asks before leaving it
  const WebSocket = require('ws');
  function phone(name) {
    return new Promise(function (resolve, reject) {
      const ws = new WebSocket(SERVER.replace('http', 'ws') + '/ws');
      ws.on('open', function () { ws.send(JSON.stringify({ t: 'join', name: name, cid: 'cid-' + name })); resolve(ws); });
      ws.on('error', reject);
    });
  }
  const p1 = await phone('Ana');
  const p2 = await phone('Luis');
  check(!!(await waitFor(async function () { return (await getJson(SERVER + '/info')).actividad.players === 2; }, 10000, 'dos móviles')), 'Dos móviles se unen por el puerto 8090');
  p1.send(JSON.stringify({ t: 'pick', game: 'ejemplo-reflejos' }));
  check(!!(await waitFor(async function () { return (await ev('__tv.screen()')) !== 'menu'; }, 10000, 'empieza el juego')), 'Un móvil elige «Reflejos» y la tele cambia al juego');
  await sleep(1500);
  shot('3b-juego');
  key('KEYCODE_BACK');
  check(!!(await waitFor(function () { return ev('document.getElementById("confirm").classList.contains("on")'); }, 8000, 'confirmación')), 'En un juego, Atrás pregunta «¿Volver al menú?» (Escape en la página)');
  check(foreground(), 'Y la app sigue delante');
  key('KEYCODE_DPAD_LEFT');
  await sleep(400);
  key('KEYCODE_DPAD_CENTER');
  check(!!(await waitFor(async function () { return (await ev('__tv.screen()')) === 'menu'; }, 10000, 'vuelta al menú')), '◀ y OK en «Sí, al menú» vuelven al menú');
  p1.close();
  p2.close();

  // At the main menu: one Back stays, two Backs within 2 s exit
  key('KEYCODE_BACK');
  await sleep(2600);
  check(foreground(), 'En el menú principal, un Atrás no sale (avisa «Pulsa Atrás otra vez para salir»)');
  key('KEYCODE_BACK KEYCODE_BACK');
  check(!!(await waitFor(function () { return !foreground(); }, 8000, 'salir')), 'Dos Atrás seguidos salen de la app');
  shot('4-fuera');

  // The server stays (15 min without players) with no TV page connected
  const after = await waitFor(async function () { const i = await getJson(SERVER + '/info'); return i.actividad && i.actividad.tvs === 0 ? i : null; }, 20000, 'sin pantallas');
  check(!!after, 'Fuera de la app: el servidor sigue y ya no cuenta ninguna pantalla (la página se descarga)');
  check(sh('pidof ' + APP + ':node') === pidNode, 'El proceso :node sigue vivo (se apaga solo tras 15 min sin uso)');

  // Launch again: reuses the server
  adb(['shell', 'am', 'start', '-n', APP + '/.MainActivity']);
  check(!!(await waitFor(page, 30000, 'volver a abrir')), 'Al volver a abrir, carga la página otra vez');
  check(sh('pidof ' + APP + ':node') === pidNode, 'Y reutiliza el mismo servidor (mismo proceso :node)');
  await sleep(1000);
  shot('5-otra-vez');

  // Idle shutdown end to end, with a fresh server that shuts down after 1 min
  // (`--ei idleMin 1`, only for this test; the app uses 15)
  adb(['shell', 'am', 'force-stop', APP]);
  await waitFor(function () { return !sh('pidof ' + APP + ':node'); }, 15000, 'force-stop');
  adb(['shell', 'am', 'start', '-n', APP + '/.MainActivity', '--ei', 'idleMin', '1']);
  const fresh = await waitFor(page, 90000, 'arranque con idleMin 1');
  const info1 = fresh ? await getJson(SERVER + '/info') : {};
  const pidIdle = sh('pidof ' + APP + ':node');
  check(!!fresh && info1.tele && info1.tele.idleMinutes === 1 && pidIdle && pidIdle !== pidNode, 'Servidor nuevo (proceso ' + pidIdle + ') que se apaga tras 1 min sin uso');
  key('KEYCODE_HOME');
  check(!!(await waitFor(function () { return !foreground(); }, 8000, 'Inicio')), 'Botón Inicio: la app queda detrás');
  const t0 = Date.now();
  const gone = await waitFor(function () { return !sh('pidof ' + APP + ':node'); }, 180000, 'apagado por inactividad');
  check(!!gone, 'Sin pantalla ni jugadores, el proceso :node termina solo (' + Math.round((Date.now() - t0) / 1000) + ' s)');
  adb(['shell', 'am', 'start', '-n', APP + '/.MainActivity']);
  const again = await waitFor(page, 90000, 'volver a abrir tras el apagado');
  const pidNew = sh('pidof ' + APP + ':node');
  check(!!again && pidNew && pidNew !== pidIdle, 'Al volver a abrir la app, arranca otro servidor (proceso ' + pidNew + ')');
  await sleep(1000);
  shot('6-tras-apagado');
  finish();
})().catch(function (e) {
  console.log(e && e.stack || e);
  failed++;
  finish();
});

function finish() {
  console.log('\nResultado: ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}
