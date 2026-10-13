'use strict';
/*
 * Smoke test with headless Chromium (Playwright, optional). Ported from
 * «Juegos del Salón» and extended (3rd game, webOS emulation, ambient mode).
 * Prueba de humo con Chromium sin pantalla (Playwright, opcional):
 *  - tele a 1920x1080 (capturas) y otra a 1280x720 (comprobación de desbordes)
 *  - dos iPhone simulados que se unen, eligen juego, dibujan con eventos táctiles
 *    reales (CDP) y adivinan escribiendo en el campo de texto
 *  - comprueba que el canvas de la tele recibe píxeles, la galería y el mando de la tele
 *
 *   node test/browser-smoke.js [carpeta-de-capturas]
 * Si Playwright no está instalado, se omite sin fallar.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const H_ = require('./helpers');

let pw = null;
const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/npm-tools/node_modules/playwright'].filter(Boolean);
for (const c of candidates) { try { pw = require(c); break; } catch (e) { /* sigue */ } }
if (!pw) { console.log('Playwright no está disponible: se omite la prueba con navegador.'); process.exit(0); }

const PORT = parseInt(process.env.TEST_PORT, 10) || 3997;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots'));
const HOME = H_.tmpHome('g2t-browser-');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  OK     ' + label); }
  else { failed++; console.log('  FALLO  ' + label); }
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

// Comprueba en la página de la tele que ningún texto visible se desborda
const OVERFLOW_CHECK = function () {
  var stage = document.getElementById('stage');
  var sr = stage.getBoundingClientRect();
  var bad = [];
  var all = stage.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!el.getClientRects().length) continue;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || el.id === 'kaPixel') continue;
    var hasText = false;
    for (var k = 0; k < el.childNodes.length; k++) if (el.childNodes[k].nodeType === 3 && el.childNodes[k].textContent.trim()) hasText = true;
    if (!hasText) continue;
    var r = el.getBoundingClientRect();
    var s = sr.width / 1920;
    var label = (el.id || el.className || el.tagName) + ': «' + el.textContent.trim().slice(0, 40) + '»';
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible') bad.push('recortado ' + label);
    if (r.left < sr.left - 1 || r.right > sr.right + 1 || r.top < sr.top - 1 || r.bottom > sr.bottom + 1) bad.push('fuera de pantalla ' + label);
    if (r.width > 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflow === 'visible' && cs.whiteSpace === 'nowrap') bad.push('desborda ' + label);
    void s;
  }
  return bad;
};

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Arrancando servidor en el puerto ' + PORT + ' (capturas en ' + SHOTS + ')');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', DIBUJA_DEBUG_SPEED: '4', REFLEJOS_DEBUG_SPEED: '4', SLOT_HOLD_MS: '30000' });

  const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  function watch(page, name) {
    page.on('pageerror', function (e) { errors.push(name + ': ' + e.message); });
    page.on('console', function (m) { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  }
  try {
    // ---------------- Tele ----------------
    const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const tv = await tvCtx.newPage(); watch(tv, 'tele');
    await tv.goto(BASE + '/');
    const tv720Ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const tv720 = await tv720Ctx.newPage(); watch(tv720, 'tele720');
    await tv720.goto(BASE + '/tv'); // alias antiguo: redirige a /
    check(new URL(tv720.url()).pathname === '/', '/tv redirige a / en el navegador');
    await waitFor(function () { return tv.evaluate(function () { var i = document.getElementById('qrImg'); return i.complete && i.naturalWidth > 0 && document.getElementById('conn').className.indexOf('on') < 0; }); }, 5000, 'QR');
    check(!(await tv.isVisible('#conn')) && !(await tv.isVisible('#oPause')) && !(await tv.isVisible('#confirm')), 'La tele conecta y carga el QR (sin capas superpuestas visibles)');

    // ---------------- Móviles ----------------
    const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
    const ph = [];
    for (let i = 0; i < 2; i++) {
      const ctx = await browser.newContext(iphone);
      const p = await ctx.newPage(); watch(p, 'móvil' + (i + 1));
      await p.goto(BASE + '/m');
      ph.push(p);
    }
    await ph[0].fill('#name', 'Ana');
    await ph[0].click('#joinBtn');
    await waitFor(function () { return ph[0].isVisible('#scrMenu'); }, 3000, 'menú móvil 1');
    await waitFor(function () { return tv.evaluate(function () { return /Ana/.test(document.getElementById('chip1').textContent); }); }, 3000, 'chip Ana');
    await sleep(300);
    await tv.screenshot({ path: path.join(SHOTS, 'tv-menu.png') });
    check(await tv.isVisible('#qrBox'), 'Menú de la tele con QR visible mientras falta un jugador (tv-menu.png)');

    await ph[1].fill('#name', 'Berto');
    await ph[1].click('#joinBtn');
    await waitFor(function () { return ph[1].isVisible('#scrMenu'); }, 3000, 'menú móvil 2');
    // Palabra secreta desde la interfaz
    await ph[1].fill('#wInput', 'la siesta del domingo');
    await ph[1].click('#wAdd');
    await waitFor(function () { return ph[1].evaluate(function () { return document.getElementById('wCount').textContent === '1/10'; }); }, 2000, 'palabra secreta');
    check(await ph[1].evaluate(function () { return /siesta/.test(document.getElementById('wList').textContent); }), 'Se añade una palabra secreta desde el móvil');
    await waitFor(function () { return tv.evaluate(function () { return document.getElementById('qrBox').style.display === 'none'; }); }, 3000, 'qr oculto');
    check(true, 'Con 2 jugadores el QR desaparece');
    await sleep(300);
    await tv.screenshot({ path: path.join(SHOTS, 'tv-menu-listos.png') });
    await ph[1].screenshot({ path: path.join(SHOTS, 'movil-menu.png') });
    let ov = await tv.evaluate(OVERFLOW_CHECK);
    let ov720 = await tv720.evaluate(OVERFLOW_CHECK);
    check(!ov.length && !ov720.length, 'Menú sin desbordes a 1920x1080 ni a 1280x720' + (ov.concat(ov720).length ? ': ' + ov.concat(ov720).join(' | ') : ''));

    // El mando de la tele mueve el foco
    await tv.keyboard.press('ArrowRight');
    check(await tv.evaluate(function () { return document.getElementById('card-pong').className.indexOf('focus') >= 0; }), 'Flecha derecha enfoca «Pong» en la tele');
    await tv.keyboard.press('ArrowLeft');

    // ---------------- Dibuja y adivina desde el móvil ----------------
    await ph[0].click('#gameList .game[data-game="dibuja"]');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'dibuja'; }); }, 3000, 'tele en dibuja');
    check(await tv.evaluate(function () { return /Ana ha elegido/.test(document.getElementById('toast').textContent); }), 'La tele muestra quién eligió el juego');

    const cdp = [await ph[0].context().newCDPSession(ph[0]), await ph[1].context().newCDPSession(ph[1])];
    async function touchPath(i, pts) {
      // pts en 0..1 del lienzo
      const r = await ph[i].evaluate(function () { var b = document.getElementById('dcv').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
      const P = function (p) { return { x: r.x + p[0] * r.w, y: r.y + p[1] * r.h }; };
      await cdp[i].send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [P(pts[0])] });
      for (let k = 1; k < pts.length; k++) {
        await cdp[i].send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [P(pts[k])] });
        if (k % 4 === 0) await sleep(8);
      }
      await cdp[i].send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(30);
    }
    function circle(cx, cy, r, n) { const a = []; for (let k = 0; k <= n; k++) a.push([cx + r * Math.cos(k / n * Math.PI * 2), cy + r * 1.333 * Math.sin(k / n * Math.PI * 2)]); return a; }
    function line(x0, y0, x1, y1, n) { const a = []; for (let k = 0; k <= n; k++) a.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]); return a; }
    async function color(i, idx) { await ph[i].click('#colors .sw:nth-child(' + (idx + 1) + ')'); }
    async function size(i, idx) { await ph[i].click('.tb.size[data-s="' + idx + '"]'); }
    async function doodle(i, round) {
      if (round === 1) {
        // Casa con sol
        await size(i, 1); await color(i, 0);
        await touchPath(i, line(0.25, 0.55, 0.25, 0.9, 12).concat(line(0.25, 0.9, 0.6, 0.9, 12), line(0.6, 0.9, 0.6, 0.55, 12), line(0.6, 0.55, 0.25, 0.55, 12)));
        await color(i, 1);
        await touchPath(i, line(0.22, 0.56, 0.425, 0.3, 14).concat(line(0.425, 0.3, 0.63, 0.56, 14)));
        await color(i, 7); await size(i, 2);
        await touchPath(i, line(0.38, 0.9, 0.38, 0.72, 8).concat(line(0.38, 0.72, 0.47, 0.72, 4), line(0.47, 0.72, 0.47, 0.9, 8)));
        await color(i, 3);
        await touchPath(i, circle(0.82, 0.2, 0.08, 30));
        await size(i, 0); await color(i, 4);
        await touchPath(i, line(0.05, 0.95, 0.95, 0.95, 20));
        await color(i, 5);
        for (let k = 0; k < 4; k++) await touchPath(i, line(0.7 + k * 0.06, 0.38, 0.73 + k * 0.06, 0.45, 3));
      } else {
        const c = [1, 5, 4, 6, 2, 0, 7][round % 7];
        await color(i, c); await size(i, round % 3);
        const pts = [];
        for (let k = 0; k <= 60; k++) {
          const t = k / 60;
          pts.push([0.15 + 0.7 * t, 0.5 + 0.3 * Math.sin(t * Math.PI * (2 + round))]);
        }
        await touchPath(i, pts);
        await color(i, (c + 3) % 8);
        await touchPath(i, circle(0.5, 0.45, 0.05 + round * 0.012, 24));
      }
    }
    async function tvMeta() { return tv.evaluate(function () { return window.__tv.view('dibuja').state().meta; }); }

    let shotRound = false;
    for (let round = 1; round <= 8; round++) {
      const m = await waitFor(async function () { const x = await tvMeta(); return x && x.round === round && x.phase === 'choose' ? x : null; }, 15000, 'elegir ronda ' + round);
      if (!check(!!m, 'Ronda ' + round + ': fase de elegir palabra')) break;
      const d = m.drawer - 1, g = 1 - d;
      await ph[d].waitForSelector('#chOpts .opt', { state: 'visible', timeout: 5000 });
      if (round === 1) {
        const tags = await ph[d].evaluate(function () { return Array.prototype.map.call(document.querySelectorAll('#chOpts .tag'), function (t) { return t.textContent; }); });
        check(tags.length === 3, 'El que dibuja ve 3 palabras con etiqueta: ' + tags.join(' / '));
        check(await ph[g].isVisible('#pnWait'), 'El que adivina ve «… está eligiendo palabra»');
      }
      await ph[d].click('#chOpts .opt >> nth=0');
      await ph[d].waitForSelector('#pnDraw', { state: 'visible', timeout: 5000 });
      await sleep(150);
      const word = await ph[d].textContent('#dwWord');
      await doodle(d, round);
      if (round === 1) {
        const px = await waitFor(function () {
          return tv.evaluate(function () {
            var c = document.getElementById('dc');
            var data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            var n = 0;
            for (var i = 0; i < data.length; i += 16) if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) n++;
            return n > 500 ? n : 0;
          });
        }, 3000, 'píxeles en la tele');
        check(!!px, 'El canvas de la tele recibe el dibujo hecho con el dedo (' + px + ' píxeles muestreados con tinta)');
        const phonePx = await ph[d].evaluate(function () {
          var c = document.getElementById('dcv');
          var data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          var n = 0;
          for (var i = 0; i < data.length; i += 16) if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) n++;
          return n;
        });
        check(phonePx > 500, 'El lienzo del móvil también muestra el dibujo');
        const ratio = await ph[d].evaluate(function () { var r = document.getElementById('dcv').getBoundingClientRect(); return r.width / r.height; });
        check(Math.abs(ratio - 4 / 3) < 0.02, 'El lienzo del móvil es 4:3 (' + ratio.toFixed(3) + ')');
        check(await ph[g].evaluate(function () { return !document.getElementById('dcv').offsetParent; }), 'El que adivina NO ve el dibujo en el móvil');
        // Intentos desde el teclado del que adivina
        await ph[g].fill('#gInput', 'zzzz qqqq');
        await ph[g].press('#gInput', 'Enter');
        await sleep(250);
        const n = word.replace(/[^A-Za-zÀ-ÿ]/g, '');
        const casi = n.length >= 5 ? n.slice(0, n.length - (n.length >= 9 ? 3 : 2)) + 'xx'.slice(0, n.length >= 9 ? 3 : 2) : n.slice(0, -1) + 'q';
        await ph[g].fill('#gInput', casi);
        await ph[g].press('#gInput', 'Enter');
        await sleep(300);
        check(await ph[g].evaluate(function () { return document.activeElement && document.activeElement.id === 'gInput' && document.getElementById('gInput').value === ''; }), 'Tras Enviar el campo se vacía y conserva el foco (teclado abierto)');
        const fb = await ph[g].textContent('#gFb');
        check(/Casi|No/.test(fb), 'El que adivina ve la respuesta: «' + fb + '»');
        // Espera a la pista del 50 % para la captura
        await waitFor(function () { return tv.evaluate(function () { return document.querySelectorAll('#dHint .ch.rv').length > 0; }); }, 12000, 'pista en la tele');
        check(await tv.evaluate(function () { return document.querySelectorAll('#dHint .ch.rv').length > 0; }), 'La tele muestra una letra desvelada (pista)');
        const visibleOv = await tv.evaluate(function () { return ['conn', 'oIntro', 'oChoose', 'oReveal', 'oEnd', 'oPause', 'confirm'].filter(function (id) { return document.getElementById(id).getClientRects().length > 0; }); });
        check(!visibleOv.length, 'Durante la ronda no hay capas superpuestas en la tele' + (visibleOv.length ? ': ' + visibleOv.join(', ') : ''));
        await sleep(400);
        await tv.screenshot({ path: path.join(SHOTS, 'tv-ronda.png') });
        await tv720.screenshot({ path: path.join(SHOTS, 'tv-ronda-720p.png') });
        await ph[d].screenshot({ path: path.join(SHOTS, 'movil-dibuja.png') });
        await ph[g].screenshot({ path: path.join(SHOTS, 'movil-adivina.png') });
        ov = await tv.evaluate(OVERFLOW_CHECK);
        ov720 = await tv720.evaluate(OVERFLOW_CHECK);
        check(!ov.length && !ov720.length, 'Ronda sin desbordes a 1920x1080 ni a 1280x720' + (ov.concat(ov720).length ? ': ' + ov.concat(ov720).join(' | ') : ''));
        check(await tv.evaluate(function () { var f = document.querySelectorAll('#dFeed li'); return f.length === 2 && /casi/.test(f[0].className); }), 'La tele muestra los intentos y resalta el «¡Casi!»');
        shotRound = true;
      }
      // Acierto
      await ph[g].fill('#gInput', word);
      await ph[g].press('#gInput', 'Enter');
      const rv = await waitFor(async function () { const x = await tvMeta(); return x && x.round === round && x.phase === 'reveal' ? x : null; }, 5000, 'reveal');
      check(rv && rv.last && rv.last.ok, 'Ronda ' + round + ': acierto con «' + word + '» (+' + (rv && rv.last ? rv.last.points : '?') + ')');
      if (round === 1) {
        await sleep(450);
        await tv.screenshot({ path: path.join(SHOTS, 'tv-acierto.png') });
        ov = await tv.evaluate(OVERFLOW_CHECK);
        check(!ov.length, 'Pantalla de acierto sin desbordes' + (ov.length ? ': ' + ov.join(' | ') : ''));
      }
    }
    void shotRound;

    // ---------------- Galería ----------------
    const end = await waitFor(function () { return tv.evaluate(function () { return document.getElementById('oEnd').className.indexOf('on') >= 0 && document.querySelectorAll('#gGrid canvas').length; }); }, 10000, 'galería');
    check(end === 8, 'La tele muestra la galería con 8 dibujos');
    const inked = await tv.evaluate(function () {
      return Array.prototype.map.call(document.querySelectorAll('#gGrid canvas'), function (c) {
        var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, n = 0;
        for (var i = 0; i < d.length; i += 16) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++;
        return n;
      });
    });
    check(inked.every(function (n) { return n > 20; }), 'Las 8 miniaturas tienen dibujo (' + inked.join(', ') + ')');
    await sleep(500);
    await tv.screenshot({ path: path.join(SHOTS, 'tv-galeria.png') });
    await tv720.screenshot({ path: path.join(SHOTS, 'tv-galeria-720p.png') });
    await ph[0].screenshot({ path: path.join(SHOTS, 'movil-final.png') });
    ov = await tv.evaluate(OVERFLOW_CHECK);
    ov720 = await tv720.evaluate(OVERFLOW_CHECK);
    check(!ov.length && !ov720.length, 'Galería sin desbordes a 1920x1080 ni a 1280x720' + (ov.concat(ov720).length ? ': ' + ov.concat(ov720).join(' | ') : ''));
    check(await ph[0].isVisible('#enAgain') && await ph[1].isVisible('#pnEnd'), 'Los móviles muestran «Jugar otra vez» / «Menú»');

    // ---------------- Mando de la tele: galería -> menú -> Pong -> Atrás ----------------
    await tv.keyboard.press('ArrowRight');
    await tv.keyboard.press('Enter');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú');
    check(await tv.evaluate(function () { return window.__tv.screen() === 'menu'; }), 'Con el mando: «Menú» desde la galería');
    check(await ph[0].isVisible('#scrMenu'), 'Los móviles vuelven a su menú');
    await tv.keyboard.press('ArrowRight');
    await tv.keyboard.press('Enter');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'pong'; }); }, 3000, 'pong');
    check(await tv.evaluate(function () { return window.__tv.screen() === 'pong'; }), 'Con el mando: flecha + OK abre el Pong');
    check(await ph[1].isVisible('#pad'), 'Los móviles muestran la pala del Pong');
    // Mover la pala con el dedo en el móvil 1
    const padBox = await ph[0].evaluate(function () { var b = document.getElementById('pad').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 30, h: b.height }; });
    await sleep(3300);
    await cdp[0].send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: padBox.x, y: padBox.y }] });
    for (let k = 1; k <= 10; k++) { await cdp[0].send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: padBox.x, y: padBox.y + k * 4 }] }); await sleep(16); }
    await cdp[0].send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    await tv.screenshot({ path: path.join(SHOTS, 'tv-pong.png') });
    const fps = await tv.evaluate(function () {
      return new Promise(function (res) { var n = 0, t0 = performance.now(); function f() { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); } requestAnimationFrame(f); });
    });
    check(fps > 30, 'El Pong se dibuja con fluidez en Chromium (' + fps + ' FPS sin GPU)');
    const pcW = await tv.evaluate(function () { return document.getElementById('pc').width; });
    check(pcW <= 1920, 'Canvas del Pong limitado (' + pcW + ' px de ancho)');
    await tv.keyboard.press('Escape');
    check(await tv.evaluate(function () { return document.getElementById('confirm').className.indexOf('on') >= 0; }), 'Atrás/Escape pide confirmación');
    await tv.screenshot({ path: path.join(SHOTS, 'tv-confirmar.png') });
    await tv.keyboard.press('Enter'); // foco por defecto: «No, seguir»
    check(await tv.evaluate(function () { return window.__tv.screen() === 'pong' && document.getElementById('confirm').className.indexOf('on') < 0; }), '«No, seguir» mantiene la partida');
    await tv.keyboard.press('Escape');
    await tv.keyboard.press('ArrowLeft');
    await tv.keyboard.press('Enter');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú tras atrás');
    check(await tv.evaluate(function () { return window.__tv.screen() === 'menu'; }), '«Sí, al menú» vuelve al menú');

    // ?debug=1
    const dbgPage = await tvCtx.newPage(); watch(dbgPage, 'tele-debug');
    await dbgPage.goto(BASE + '/?debug=1');
    await sleep(1200);
    const dbgText = await dbgPage.textContent('#dbg');
    check(/FPS \d+/.test(dbgText) && /último msg/.test(dbgText), 'Superposición ?debug=1: ' + dbgText.trim().slice(0, 80));
    await dbgPage.close();

    // ---------------- Reflejos (the example game) ----------------
    await ph[1].click('#gameList .game[data-game="ejemplo-reflejos"]');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'ejemplo-reflejos'; }); }, 3000, 'reflejos');
    check(await tv.evaluate(function () { return window.__tv.screen() === 'ejemplo-reflejos'; }), 'Reflejos se elige desde el móvil');
    let rxShot = false;
    for (let r = 0; r < 3; r++) {
      const go = await waitFor(function () { return tv.evaluate(function () { return document.getElementById('rxBig').textContent === '¡YA!'; }); }, 6000, 'YA ' + r);
      if (!go) break;
      if (!rxShot) {
        await tv.screenshot({ path: path.join(SHOTS, 'tv-reflejos.png') });
        await ph[0].screenshot({ path: path.join(SHOTS, 'movil-reflejos.png') });
        rxShot = true;
      }
      const box = await ph[0].evaluate(function () { var b = document.getElementById('rxPad').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 40 }; });
      await cdp[0].send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [box] });
      await cdp[0].send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitFor(function () { return tv.evaluate(function () { return /Punto para|Gana/.test(document.getElementById('rxBig').textContent); }); }, 3000, 'punto ' + r);
    }
    const rxEnd = await waitFor(function () { return tv.evaluate(function () { return /^¡Gana Ana!$/.test(document.getElementById('rxBig').textContent); }); }, 6000, 'fin reflejos');
    check(!!rxEnd, 'Reflejos: Ana toca primero 3 veces y gana');
    await sleep(400);
    await tv.screenshot({ path: path.join(SHOTS, 'tv-reflejos-fin.png') });
    ov = await tv.evaluate(OVERFLOW_CHECK);
    check(!ov.length, 'Reflejos sin desbordes' + (ov.length ? ': ' + ov.join(' | ') : ''));
    check(await ph[0].isVisible('#rxAgain'), 'El móvil ofrece «Otra partida»');
    await tv.keyboard.press('Escape');
    await tv.keyboard.press('ArrowLeft');
    await tv.keyboard.press('Enter');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú tras reflejos');

    // ---------------- Emulated LG webOS TV: dpr 2, canvas cap, FPS ----------------
    const lgCtx = await browser.newContext({
      viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager'
    });
    const lg = await lgCtx.newPage(); watch(lg, 'tele-webos');
    await lg.goto(BASE + '/');
    await waitFor(function () { return lg.evaluate(function () { return document.getElementById('conn').className.indexOf('on') < 0; }); }, 5000, 'lg conectada');
    await lg.keyboard.press('ArrowRight');
    await lg.keyboard.press('Enter');
    await waitFor(function () { return lg.evaluate(function () { return window.__tv.screen() === 'pong'; }); }, 3000, 'pong en lg');
    await sleep(3500);
    const measure = function () {
      return new Promise(function (res) {
        var n = 0, t0 = performance.now();
        function f() { n++; if (performance.now() - t0 < 4000) requestAnimationFrame(f); else res(Math.round(n * 1000 / (performance.now() - t0))); }
        requestAnimationFrame(f);
      });
    };
    const lgInfo = await lg.evaluate(function () { var c = document.getElementById('pc'); return { w: c.width, h: c.height, dpr: window.devicePixelRatio }; });
    check(lgInfo.dpr === 2 && lgInfo.w === 1280 && lgInfo.h === 720, 'webOS (dpr 2, 1920x1080): canvas limitado a ' + lgInfo.w + 'x' + lgInfo.h + ' (sin límite serían 3840x2160)');
    const [fpsLg, fps1080] = await Promise.all([lg.evaluate(measure), tv.evaluate(measure)]);
    check(fpsLg >= 50, 'FPS del Pong en la tele webOS emulada: ' + fpsLg + ' (4 s, objetivo ≈60)');
    check(fps1080 >= 50, 'FPS del Pong a 1920x1080: ' + fps1080 + ' (4 s, objetivo ≈60)');
    await lg.screenshot({ path: path.join(SHOTS, 'tv-pong-webos.png') });
    const lgRes = await lgCtx.newPage();
    await lgRes.goto(BASE + '/?res=960');
    await sleep(500);
    const w960 = await lgRes.evaluate(function () { return window.G2T.MAXW; });
    check(w960 === 960, '?res=960 cambia el límite del canvas (' + w960 + ')');
    await lgRes.close();
    await lg.keyboard.press('Escape');
    await lg.keyboard.press('ArrowLeft');
    await lg.keyboard.press('Enter');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú tras lg');
    await lgCtx.close();

    // ---------------- Ambient mode ----------------
    const amb = await tvCtx.newPage(); watch(amb, 'ambiente');
    await amb.goto(BASE + '/ambiente');
    await sleep(800);
    const ambInfo = await amb.evaluate(function () { return { empty: document.getElementById('empty').className.indexOf('on') >= 0, time: document.getElementById('time').textContent }; });
    check(ambInfo.empty && /^\d{2}:\d{2}$/.test(ambInfo.time), 'Modo ambiente sin fotos: aviso y reloj (' + ambInfo.time + ')');
    await amb.screenshot({ path: path.join(SHOTS, 'tv-ambiente.png') });
    await amb.close();

    check(!errors.length, 'Sin errores de JavaScript en las páginas' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
  } catch (e) {
    failed++;
    console.log('  FALLO  Excepción: ' + (e && e.stack || e));
  } finally {
    await browser.close().catch(function () {});
    await srv.stop();
    H_.rmrf(HOME);
  }
  console.log('\nResultado (navegador): ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

main();
