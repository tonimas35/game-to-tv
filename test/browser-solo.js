'use strict';
/*
 * Headless Chromium (Playwright, optional): «Solo con el móvil» (/solo), the
 * phone as screen AND controller, held sideways (844x390). From the menu it
 * adds a rival bot and plays Tanques against it. Checks, by hiding the TV
 * layer and comparing screenshots:
 *   - in the menu only the phone shows (opaque);
 *   - in a game the arena is visible behind the controls (hiding the TV
 *     layer changes the pixels under the stick and «¡Fuego!»), the controls
 *     are translucent and the top bar is compact and half transparent;
 *   - help («?») and the end of the duel are phone overlays/panels: opaque,
 *     the TV layer does not show through (only one end screen is readable).
 * Screenshots go to the folder given as argument.
 *
 *   node test/browser-solo.js [carpeta-de-capturas]
 * Without Playwright it is skipped (exit 0).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PNG } = require('pngjs');
const H_ = require('./helpers');

let pw = null;
const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/npm-tools/node_modules/playwright'].filter(Boolean);
for (const c of candidates) { try { pw = require(c); break; } catch (e) { /* sigue */ } }
if (!pw) { console.log('Playwright no está disponible: se omite la prueba con navegador.'); process.exit(0); }

const PORT = parseInt(process.env.TEST_PORT, 10) || 3967;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots-bots'));
const HOME = H_.tmpHome('g2t-browser-solo-');
const LAUNCH = { args: ['--autoplay-policy=no-user-gesture-required'] };
if (fs.existsSync('/opt/pw-browsers')) {
  try {
    const dirs = fs.readdirSync('/opt/pw-browsers').filter(function (d) { return /^chromium-\d+$/.test(d); }).sort();
    const exe = dirs.length ? path.join('/opt/pw-browsers', dirs[dirs.length - 1], 'chrome-linux', 'chrome') : null;
    if (exe && fs.existsSync(exe)) LAUNCH.executablePath = exe;
  } catch (e) { /* the default one */ }
}

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  OK     ' + label); } else { failed++; console.log('  FALLO  ' + label); }
  return cond;
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* sigue */ }
    await sleep(50);
  }
  console.log('    (tiempo agotado: ' + label + ')');
  return null;
}

// Mean difference (0..255) between two screenshots inside a box (CSS px; dpr 1)
function diff(a, b, box) {
  const A = PNG.sync.read(a), B = PNG.sync.read(b);
  const x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(A.width, Math.round(box.x + box.w)), y1 = Math.min(A.height, Math.round(box.y + box.h));
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * A.width + x) * 4;
      sum += Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
      n += 3;
    }
  }
  return n ? sum / n : 0;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Arrancando servidor en el puerto ' + PORT + ' (capturas en ' + SHOTS + ')');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', TANQUES_TO_WIN: '1', TANQUES_DEBUG_SPEED: '2' });
  const browser = await pw.chromium.launch(LAUNCH);
  const errors = [];
  try {
    const page = await (await browser.newContext({
      viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    })).newPage();
    page.on('pageerror', function (e) { errors.push(e.message); });
    page.on('console', function (m) { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE + '/solo');
    const phone = await waitFor(function () { return page.frames().filter(function (f) { return /\/m$/.test(f.url()); })[0]; }, 5000, 'marco del móvil');
    const tele = page.frames().filter(function (f) { return /:\d+\/$/.test(f.url()); })[0];
    await waitFor(function () { return phone.evaluate(function () { return !!document.getElementById('name'); }); }, 5000, 'móvil cargado');
    await phone.fill('#name', 'Ana');
    await phone.click('#joinBtn');
    await waitFor(function () { return phone.evaluate(function () { return window.__phone.slot() === 1; }); }, 3000, 'unirse');
    // The TV layer on and off (to see what it contributes to the screen)
    async function withoutTv() {
      await page.evaluate(function () { document.getElementById('tele').style.opacity = '0'; });
      await sleep(80);
      const b = await page.screenshot();
      await page.evaluate(function () { document.getElementById('tele').style.opacity = ''; });
      await sleep(80);
      return b;
    }
    async function tvShare(box) {
      const a = await page.screenshot();
      const b = await withoutTv();
      return diff(a, b, box || { x: 0, y: 0, w: 844, h: 390 });
    }

    console.log('\n[Menú: solo el móvil]');
    await sleep(500);
    const m0 = await page.evaluate(function () { return window.__solo.controls(); });
    const share0 = await tvShare();
    check(!m0 && share0 < 0.5, 'En el menú no hay capa de la tele (diferencia ' + share0.toFixed(2) + ')');
    await phone.click('#botAddBtn');
    await phone.click('#botSheet .lvl[data-level="imposible"]');
    await waitFor(function () { return phone.evaluate(function () { return !!document.querySelector('#mRoom span.bot'); }); }, 3000, 'rival');
    await shot(page, 'solo-menu.png');
    await phone.click('#gameList .game[data-game="tanques"]');

    console.log('\n[En juego: la arena detrás de los mandos]');
    await waitFor(function () { return tele.evaluate(function () { var v = window.__tv.view('tanques'); return v && v.state().meta && v.state().meta.phase === 'countdown'; }); }, 5000, 'cuenta atrás');
    const on = await waitFor(function () { return page.evaluate(function () { return window.__solo.controls(); }); }, 2000, 'mandos');
    await sleep(600);
    const st = await phone.evaluate(function () {
      function bg(el) { return getComputedStyle(el).backgroundColor; }
      var left = document.querySelector('#scr-tanques .kpLeft'), right = document.querySelector('#scr-tanques .kpRight');
      var bar = document.querySelector('#scr-tanques .bar');
      function box(el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
      return {
        body: bg(document.body), app: bg(document.getElementById('app')), scr: bg(document.getElementById('scr-tanques')),
        left: getComputedStyle(left).opacity, right: getComputedStyle(right).opacity, fireBg: bg(document.getElementById('kpFire')),
        bar: getComputedStyle(bar).opacity, barH: bar.getBoundingClientRect().height, stick: box(document.getElementById('kpStick')), fire: box(document.getElementById('kpFire'))
      };
    });
    check(!!on && st.body === 'rgba(0, 0, 0, 0)' && st.app === 'rgba(0, 0, 0, 0)' && st.scr === 'rgba(0, 0, 0, 0)', 'El móvil se vuelve transparente mientras hay mandos (body, #app y la pantalla del juego)');
    check(Number(st.left) < 0.6 && Number(st.right) < 0.6 && st.fireBg === 'rgb(255, 79, 58)', 'Palanca y «¡Fuego!» medio transparentes, con su aspecto de siempre (opacidad ' + st.left + ')');
    check(Number(st.bar) < 0.7 && st.barH <= 34, 'La barra de arriba, compacta (' + Math.round(st.barH) + ' px) y medio transparente: no tapa el marcador de la tele');
    await waitFor(function () { return tele.evaluate(function () { var m = window.__tv.view('tanques').state().meta; return m && m.phase === 'play'; }); }, 6000, 'en juego');
    await sleep(300);
    const shareStick = await tvShare(st.stick);
    const shareFire = await tvShare(st.fire);
    check(shareStick > 3 && shareFire > 3, 'Se ve la arena a través de los mandos (quitar la capa de la tele cambia la palanca en ' + shareStick.toFixed(1) + ' y el fuego en ' + shareFire.toFixed(1) + ')');
    await shot(page, 'solo-juego.png');
    // Help: a phone overlay, opaque
    await phone.click('#scr-tanques .kpHelpBtn');
    await sleep(400);
    const shareHelp = await tvShare();
    check(!(await page.evaluate(function () { return window.__solo.controls(); })) && shareHelp < 0.5, '«?» (ayuda) tapa la tele: opaca (diferencia ' + shareHelp.toFixed(2) + ')');
    await phone.click('#kpHelpOk');

    console.log('\n[Final del duelo: una sola pantalla legible]');
    const end = await waitFor(function () { return phone.evaluate(function () { var e = document.getElementById('kpEnd'); return !e.classList.contains('hidden') && document.getElementById('kpEndT').textContent; }); }, 40000, 'final');
    await sleep(800);
    const tvEnd = await tele.evaluate(function () { return document.getElementById('kEnd').className.indexOf('on') >= 0; });
    const shareEnd = await tvShare();
    check(!!end && tvEnd, 'Fin del duelo (a 1 en esta prueba): el móvil dice «' + end + '» y la tele tiene su pantalla final');
    check(!(await page.evaluate(function () { return window.__solo.controls(); })) && shareEnd < 0.5, 'Solo se lee la del móvil: la capa de la tele no se ve (diferencia ' + shareEnd.toFixed(2) + ')');
    check(await phone.isVisible('#kpAgain') && await phone.isVisible('#kpEnd .menuBtn'), '«Otra» y «Menú» a mano');
    await shot(page, 'solo-final.png');
    // «Otra»: back to the controls
    await phone.click('#kpAgain');
    const again = await waitFor(function () { return page.evaluate(function () { return window.__solo.controls(); }); }, 4000, 'otra');
    check(!!again, '«Otra»: vuelven los mandos sobre la arena');
    check(!errors.length, 'Sin errores de JavaScript' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
  } catch (e) {
    failed++;
    console.log('  FALLO  Excepción: ' + (e && e.stack || e));
  } finally {
    await browser.close().catch(function () {});
    await srv.stop();
    H_.rmrf(HOME);
  }
  console.log('\nResultado (navegador, solo con el móvil): ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, name) }); }

main();
