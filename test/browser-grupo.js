'use strict';
/*
 * Headless Chromium (Playwright, optional) for groups: the 6-player lobby,
 * Pong for 4 (doubles) and «Dibuja y adivina» for 4 (todos contra todos), on
 * a 1920x1080 TV, a 1280x720 TV and an emulated LG webOS TV (dpr 2: canvas
 * capped at 1280 px, FPS measured). Two real phones (iPhone emulation) and
 * four fake phones over WebSocket.
 *
 *   node test/browser-grupo.js [carpeta-de-capturas]
 * Without Playwright it is skipped (exit 0).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const H_ = require('./helpers');

let pw = null;
const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/npm-tools/node_modules/playwright'].filter(Boolean);
for (const c of candidates) { try { pw = require(c); break; } catch (e) { /* sigue */ } }
if (!pw) { console.log('Playwright no está disponible: se omite la prueba con navegador.'); process.exit(0); }

const PORT = parseInt(process.env.TEST_PORT, 10) || 3996;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots-6p'));
const HOME = H_.tmpHome('g2t-browser6-');
const LAUNCH = { args: ['--autoplay-policy=no-user-gesture-required'] };
if (fs.existsSync('/opt/pw-browsers/chromium')) {
  // Use the preinstalled Chromium when there is one
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

// Same check as browser-smoke.js: no visible text cut or outside the 1920x1080 stage
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
    // Menu cards that peek in or are scrolled out of the row (.cardsWrap clips them;
    // with 4 games the row scrolls to the focused card)
    var card = el.closest ? el.closest('.card') : null;
    if (card) { var cr = card.getBoundingClientRect(); if (cr.left < sr.left - 1 || cr.right > sr.right + 1) continue; }
    var label = (el.id || el.className || el.tagName) + ': «' + el.textContent.trim().slice(0, 40) + '»';
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible') bad.push('recortado ' + label);
    if (r.left < sr.left - 1 || r.right > sr.right + 1 || r.top < sr.top - 1 || r.bottom > sr.bottom + 1) bad.push('fuera de pantalla ' + label);
    if (r.width > 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflow === 'visible' && cs.whiteSpace === 'nowrap') bad.push('desborda ' + label);
    // A child that sticks out of a card / chip / panel with a border
    var p = el.parentElement;
    if (p && p !== stage && /card|pchip|rx-p|gitem/.test(p.className)) {
      var pr = p.getBoundingClientRect();
      if (r.right > pr.right + 2 || r.left < pr.left - 2) bad.push('sale de su caja ' + label);
    }
  }
  return bad;
};
const MEASURE_FPS = function () {
  return new Promise(function (res) {
    var n = 0, t0 = performance.now();
    function f() { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(Math.round(n * 1000 / (performance.now() - t0))); }
    requestAnimationFrame(f);
  });
};

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Arrancando servidor en el puerto ' + PORT + ' (6 huecos; capturas en ' + SHOTS + ')');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', DIBUJA_DEBUG_SPEED: '4', SLOT_HOLD_MS: '30000' });
  const browser = await pw.chromium.launch(LAUNCH);
  const errors = [];
  const fakes = [];
  function watch(page, name) {
    page.on('pageerror', function (e) { errors.push(name + ': ' + e.message); });
    page.on('console', function (m) { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  }
  async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, name) }); }
  try {
    // ---------------- TVs ----------------
    const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage(); watch(tv, 'tele');
    const tv720 = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage(); watch(tv720, 'tele720');
    const lg = await (await browser.newContext({
      viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager'
    })).newPage(); watch(lg, 'tele-webos');
    await Promise.all([tv.goto(BASE + '/'), tv720.goto(BASE + '/'), lg.goto(BASE + '/')]);
    await waitFor(function () { return tv.evaluate(function () { var i = document.getElementById('qrImg'); return i.complete && i.naturalWidth > 0 && document.getElementById('conn').className.indexOf('on') < 0; }); }, 5000, 'QR');
    // Measures FPS with the other TV pages parked on about:blank, then brings them back
    async function measureAlone(page) {
      const others = [tv, tv720, lg].filter(function (p) { return p !== page; });
      const screen = await page.evaluate(function () { return window.__tv.screen(); });
      for (const o of others) await o.goto('about:blank');
      await sleep(300);
      const fps = await page.evaluate(MEASURE_FPS);
      for (const o of others) {
        await o.goto(BASE + '/');
        await waitFor(function () { return o.evaluate(function (s) { return window.__tv && window.__tv.screen() === s; }, screen); }, 5000, 'vuelve la tele');
      }
      await sleep(300);
      return fps;
    }
    async function overflowAll(label) {
      const a = await tv.evaluate(OVERFLOW_CHECK);
      const b = await tv720.evaluate(OVERFLOW_CHECK);
      return check(!a.length && !b.length, label + ' sin desbordes a 1920x1080 ni a 1280x720' + (a.concat(b).length ? ': ' + a.concat(b).slice(0, 6).join(' | ') : ''));
    }

    // ---------------- Lobby: 1, 3 and 6 players ----------------
    console.log('\n[Sala de 6]');
    const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
    const ph = [];
    for (let i = 0; i < 2; i++) {
      const p = await (await browser.newContext(iphone)).newPage(); watch(p, 'móvil' + (i + 1));
      await p.goto(BASE + '/m');
      ph.push(p);
    }
    await ph[0].fill('#name', 'Ana');
    await ph[0].click('#joinBtn');
    await waitFor(function () { return tv.evaluate(function () { return /Ana/.test(document.getElementById('chip1').textContent); }); }, 3000, 'chip Ana');
    await sleep(300);
    const lobby1 = await tv.evaluate(function () {
      return { vis: document.querySelectorAll('.pchip.vis').length, qr: document.getElementById('qrBox').style.display !== 'none', off: document.querySelectorAll('.card.off').length,
        why: document.querySelector('#card-dibuja .why').textContent, solo: document.getElementById('card-2048').className.indexOf('off') < 0,
        status: document.getElementById('menuStatus').textContent };
    });
    check(lobby1.vis === 2 && lobby1.qr && lobby1.off === 4 && lobby1.why === 'Falta 1 jugador', 'Con 1 jugador: su ficha + 1 hueco libre, QR y «Falta 1 jugador» en las tarjetas de 2 o más');
    check(lobby1.solo && lobby1.status === '¡Hola, Ana! Elige juego con el mando o desde el móvil', 'Con 1 jugador, «2048» está disponible: «' + lobby1.status + '»');
    await shot(tv, 'tv-sala-1.png');
    await overflowAll('Sala con 1');
    await ph[1].fill('#name', 'Berto');
    await ph[1].click('#joinBtn');
    const names = ['Carla', 'Dani', 'Eva', 'Fran'];
    for (const n of names.slice(0, 1)) fakes.push(await H_.phone(WS, n, 'b-' + n));
    await waitFor(function () { return tv.evaluate(function () { return document.querySelectorAll('.pchip.in').length === 3; }); }, 3000, '3 fichas');
    await sleep(300);
    await shot(tv, 'tv-sala-3.png');
    await overflowAll('Sala con 3');
    for (const n of names.slice(1)) fakes.push(await H_.phone(WS, n, 'b-' + n));
    await waitFor(function () { return tv.evaluate(function () { return document.querySelectorAll('.pchip.in').length === 6; }); }, 3000, '6 fichas');
    await sleep(400);
    const lobby6 = await tv.evaluate(function () {
      var chips = Array.prototype.map.call(document.querySelectorAll('.pchip.in'), function (c) { var b = c.querySelector('b'); return { name: b.textContent, color: b.style.color, top: c.getBoundingClientRect().top }; });
      return { chips: chips, qr: document.getElementById('qrBox').style.display !== 'none', pongOff: document.getElementById('card-pong').className.indexOf('off') >= 0,
        pongWhy: document.querySelector('#card-pong .why').textContent, dibujaOff: document.getElementById('card-dibuja').className.indexOf('off') >= 0,
        status: document.getElementById('menuStatus').textContent, rows: new Set(chips.map(function (c) { return Math.round(c.top); })).size };
    });
    check(lobby6.chips.length === 6 && lobby6.chips.map(function (c) { return c.name; }).join() === 'Ana,Berto,Carla,Dani,Eva,Fran' && new Set(lobby6.chips.map(function (c) { return c.color; })).size === 6,
      'Con 6: seis fichas con nombre y 6 colores distintos');
    check(!lobby6.qr && lobby6.rows === 2, 'Sala llena: sin QR y las fichas en 2 filas de 3');
    check(lobby6.pongOff && lobby6.pongWhy === 'De 2 a 4 jugadores · sois 6' && !lobby6.dibujaOff, 'Pong en gris con «' + lobby6.pongWhy + '»; Dibuja y Reflejos disponibles');
    check(lobby6.status === '¡Sois 6! Elegid juego con el mando o desde el móvil', 'Mensaje de la tele: «' + lobby6.status + '»');
    await shot(tv, 'tv-sala-6.png');
    await shot(tv720, 'tv-sala-6-720p.png');
    await overflowAll('Sala con 6');
    // Phone menu with 6
    await waitFor(function () { return ph[1].evaluate(function () { return document.querySelectorAll('#mRoom span').length === 6; }); }, 3000, 'sala en el móvil');
    const m6 = await ph[1].evaluate(function () {
      var pong = document.querySelector('#gameList .game[data-game="pong"]');
      return { room: document.querySelectorAll('#mRoom span').length, me: document.querySelector('#mRoom span.me').textContent, pongDisabled: pong.disabled, why: pong.querySelector('.why').textContent,
        rng: pong.querySelector('.rng').textContent, color: getComputedStyle(document.querySelector('.youare')).backgroundColor };
    });
    check(m6.room === 6 && m6.me === 'Berto (tú)' && m6.pongDisabled && /De 2 a 4 jugadores · sois 6/.test(m6.why) && m6.rng === '2 a 4 jugadores' && m6.color === 'rgb(255, 61, 242)',
      'Móvil: los 6 de la sala, «Berto (tú)» en su color (magenta) y Pong desactivado con el motivo');
    await shot(ph[1], 'movil-menu-6.png');
    // Pick Pong anyway with the TV remote: everybody gets the reason
    await tv.keyboard.press('ArrowRight');
    await tv.keyboard.press('Enter');
    const toastTv = await waitFor(function () { return tv.evaluate(function () { var t = document.getElementById('toast'); return t.className.indexOf('on') >= 0 && t.textContent; }); }, 2000, 'aviso tele');
    const toastPh = await waitFor(function () { return ph[0].evaluate(function () { var t = document.getElementById('toast'); return !t.classList.contains('hidden') && t.textContent; }); }, 2000, 'aviso móvil');
    check(toastTv === '«Pong» es de 2 a 4 jugadores y sois 6. Elegid otro juego.' && toastPh === toastTv, 'Elegir Pong con 6: la tele y los móviles lo explican: «' + toastTv + '»');
    await sleep(200);
    await shot(tv, 'tv-sala-6-pong-no.png');
    await overflowAll('Aviso de juego que no encaja');
    await tv.keyboard.press('ArrowLeft');

    // ---------------- Pong for 4 ----------------
    console.log('\n[Pong con 4]');
    fakes[2].send({ t: 'leave' });
    fakes[3].send({ t: 'leave' });
    await waitFor(function () { return tv.evaluate(function () { return document.querySelectorAll('.pchip.in').length === 4; }); }, 3000, '4 fichas');
    await ph[0].click('#gameList .game[data-game="pong"]');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'pong'; }); }, 3000, 'pong');
    await waitFor(function () { return ph[0].evaluate(function () { return !document.getElementById('pMine').classList.contains('hidden'); }); }, 3000, 'mi pala');
    const mine = await ph[0].evaluate(function () { return { txt: document.getElementById('pMineTxt').textContent, pads: document.querySelectorAll('#pField b').length, me: document.querySelectorAll('#pField b.me').length }; });
    const mine2 = await ph[1].evaluate(function () { return document.getElementById('pMineTxt').textContent; });
    check(mine.pads === 4 && mine.me === 1 && /portería, a la izquierda · con Carla/.test(mine.txt) && /portería, a la derecha · con Dani/.test(mine2),
      'Cada móvil ve su pala: «' + mine.txt + '» / «' + mine2 + '»');
    // Fake phones play: Carla and Dani follow the ball
    const bot = setInterval(function () {
      [fakes[0], fakes[1]].forEach(function (f, k) { try { f.send({ t: 'm', y: 0.3 + 0.4 * Math.random() * (k + 1) / 2 }); } catch (e) { /* noop */ } });
    }, 50);
    await waitFor(function () { return lg.evaluate(function () { return window.__tv.screen() === 'pong'; }); }, 3000, 'pong lg');
    await sleep(3300);
    await shot(tv, 'tv-pong-4.png');
    await shot(tv720, 'tv-pong-4-720p.png');
    await shot(ph[0], 'movil-pong-4.png');
    const lgInfo = await lg.evaluate(function () { var c = document.getElementById('pc'); return { w: c.width, h: c.height, dpr: window.devicePixelRatio }; });
    check(lgInfo.dpr === 2 && lgInfo.w === 1280 && lgInfo.h === 720, 'webOS (dpr 2): canvas del Pong limitado a ' + lgInfo.w + 'x' + lgInfo.h);
    // One TV page at a time: three TVs share this machine's CPU (no GPU), the real TV runs one
    const fpsLg = await measureAlone(lg);
    const fpsTv = await measureAlone(tv);
    check(fpsLg >= 50 && fpsTv >= 50, 'Pong a 4: ' + fpsLg + ' FPS en la tele webOS emulada y ' + fpsTv + ' a 1920x1080 (objetivo ≈60)');
    await shot(lg, 'tv-pong-4-webos.png');
    const pongPads = await tv.evaluate(function () { return document.getElementById('pc').getContext('2d') ? true : false; });
    void pongPads;
    clearInterval(bot);
    await overflowAll('Pong a 4');
    await tv.keyboard.press('Escape');
    await tv.keyboard.press('ArrowLeft');
    await tv.keyboard.press('Enter');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú');

    // ---------------- Dibuja for 4 ----------------
    console.log('\n[Dibuja y adivina con 4]');
    const real = { 1: ph[0], 2: ph[1] };
    const fake = { 3: fakes[0], 4: fakes[1] };
    const NAMES = { 1: 'Ana', 2: 'Berto', 3: 'Carla', 4: 'Dani' };
    await ph[1].click('#gameList .game[data-game="dibuja"]');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'dibuja'; }); }, 3000, 'dibuja');
    async function tvMeta() { return tv.evaluate(function () { return window.__tv.view('dibuja').state().meta; }); }
    const cdp = { 1: await ph[0].context().newCDPSession(ph[0]), 2: await ph[1].context().newCDPSession(ph[1]) };
    async function doodle(slot, round) {
      const pts = [];
      for (let k = 0; k <= 40; k++) { const t = k / 40; pts.push([0.15 + 0.7 * t, 0.5 + 0.3 * Math.sin(t * Math.PI * (2 + round))]); }
      if (real[slot]) {
        const p = real[slot];
        const r = await p.evaluate(function () { var b = document.getElementById('dcv').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
        const P = function (q) { return { x: r.x + q[0] * r.w, y: r.y + q[1] * r.h }; };
        await cdp[slot].send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [P(pts[0])] });
        for (let k = 1; k < pts.length; k++) await cdp[slot].send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [P(pts[k])] });
        await cdp[slot].send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        const flat = [];
        pts.forEach(function (q) { flat.push(q[0], q[1]); });
        fake[slot].send({ t: 'd.s', id: 1, c: ['#e53935', '#1e88e5', '#43a047', '#8e24aa'][round % 4], w: 0.02, p: flat, end: 1 });
        fake[slot].send({ t: 'd.s', id: 2, c: '#1a1a1a', w: 0.01, p: [0.4, 0.3, 0.5, 0.2, 0.6, 0.3, 0.5, 0.4, 0.4, 0.3], end: 1 });
      }
    }
    async function guessBy(slot, text) {
      if (real[slot]) { await real[slot].fill('#gInput', text); await real[slot].press('#gInput', 'Enter'); }
      else fake[slot].send({ t: 'd.guess', text: text });
    }
    let rounds = 0, firstRoundDone = false;
    const totalRounds = 8;
    for (let round = 1; round <= totalRounds; round++) {
      const m = await waitFor(async function () { const x = await tvMeta(); return x && x.round === round && x.phase === 'choose' ? x : null; }, 15000, 'elegir ronda ' + round);
      if (!check(!!m, 'Ronda ' + round + ': fase de elegir palabra')) break;
      if (round === 1) check(m.mode === 'ffa' && m.rounds === 8 && m.vueltas === 2, 'Con 4: todos contra todos, 2 vueltas = 8 rondas');
      const d = m.drawer;
      let word;
      if (real[d]) {
        await real[d].waitForSelector('#chOpts .opt', { state: 'visible', timeout: 5000 });
        await real[d].click('#chOpts .opt >> nth=0');
        await real[d].waitForSelector('#pnDraw', { state: 'visible', timeout: 5000 });
        await sleep(150);
        word = await real[d].textContent('#dwWord');
      } else {
        const mk = fake[d].mark();
        const o = await fake[d].wait(function (x) { return x.t === 'd.opts' && x.round === round; }, 3000, 'opts', Math.max(0, mk - 30));
        fake[d].send({ t: 'd.pick', i: 0 });
        const sec = await fake[d].wait(function (x) { return x.t === 'd.secret' && x.round === round; }, 3000, 'secret', Math.max(0, mk - 30));
        void o;
        word = sec.word;
      }
      await waitFor(async function () { const x = await tvMeta(); return x && x.round === round && x.phase === 'draw' ? x : null; }, 5000, 'draw');
      await doodle(d, round);
      const guessers = [1, 2, 3, 4].filter(function (s) { return s !== d; });
      if (!firstRoundDone) {
        // A wrong guess (shown with the name) and the first correct one by a real phone
        const wrongBy = guessers.filter(function (s) { return fake[s]; })[0] || guessers[0];
        await guessBy(wrongBy, 'zzzz qqqq');
        const realG = guessers.filter(function (s) { return real[s]; })[0];
        await sleep(250);
        await guessBy(realG, word);
        const got = await waitFor(function () { return real[realG].evaluate(function () { var p = document.getElementById('pnGot'); return !p.classList.contains('hidden') && document.getElementById('gtTitle').textContent; }); }, 3000, 'acertaste');
        check(got === '¡Acertaste!', NAMES[realG] + ' acierta y su móvil dice «¡Acertaste! Espera a los demás» (sin poder escribir más)');
        const feed = await waitFor(function () {
          return tv.evaluate(function (w) {
            var t = document.getElementById('dFeed').textContent;
            return /ha acertado/.test(t) && /zzzz qqqq/.test(t) && t.toLowerCase().indexOf(w.toLowerCase()) < 0 ? t : null;
          }, word);
        }, 3000, 'feed');
        check(!!feed, 'La tele: «' + NAMES[realG] + ' ha acertado» (sin el texto) y el error con su nombre');
        const board = await tv.evaluate(function () { return Array.prototype.map.call(document.querySelectorAll('#dBoard li'), function (li) { return li.textContent; }); });
        check(board.length === 4 && board.some(function (t) { return /DIBUJA/.test(t); }) && board.some(function (t) { return /1º/.test(t); }), 'Marcador de la tele: 4 jugadores, quién dibuja y quién ha acertado (' + board.join(' | ') + ')');
        await waitFor(function () { return tv.evaluate(function () { return document.querySelectorAll('#dHint .ch.rv').length > 0; }); }, 15000, 'pista');
        await sleep(300);
        await shot(tv, 'tv-dibuja-4.png');
        await shot(tv720, 'tv-dibuja-4-720p.png');
        await shot(real[realG], 'movil-dibuja-acertaste.png');
        const other = real[d] ? real[d] : real[guessers.filter(function (s) { return real[s] && s !== realG; })[0] || 1];
        if (other) await shot(other, real[d] ? 'movil-dibuja-dibujante.png' : 'movil-dibuja-adivina.png');
        await overflowAll('Ronda de Dibuja con 4');
        const fpsLgD = await measureAlone(lg);
        const lgCanvas = await lg.evaluate(function () { var c = document.getElementById('dc'); return { w: c.width, h: c.height }; });
        check(fpsLgD >= 50 && lgCanvas.w <= 1280, 'Dibuja a 4 en la tele webOS emulada: ' + fpsLgD + ' FPS, lienzo de ' + lgCanvas.w + 'x' + lgCanvas.h + ' (≤1280)');
        for (const s of guessers) if (s !== realG) { await sleep(200); await guessBy(s, word); }
        const rv = await waitFor(async function () { const x = await tvMeta(); return x && x.round === round && x.phase === 'reveal' ? x : null; }, 5000, 'reveal');
        check(rv && rv.last && rv.last.results.length === 3 && rv.last.reason === 'all', 'Ronda 1: aciertan los 3 y se desvela «' + word + '»');
        await sleep(450);
        await shot(tv, 'tv-dibuja-4-ronda.png');
        await overflowAll('Resultados de la ronda');
        firstRoundDone = true;
      } else {
        for (const s of guessers) { await guessBy(s, word); await sleep(60); }
        await waitFor(async function () { const x = await tvMeta(); return x && x.round === round && x.phase === 'reveal' ? x : null; }, 6000, 'reveal ' + round);
      }
      rounds++;
    }
    check(rounds === totalRounds, 'Se juegan las ' + totalRounds + ' rondas (cada uno dibuja 2 veces)');
    const end = await waitFor(function () { return tv.evaluate(function () { return document.getElementById('oEnd').className.indexOf('on') >= 0 && document.querySelectorAll('#gGrid canvas').length; }); }, 10000, 'final');
    check(end === 8, 'Final: galería con los 8 dibujos');
    const fin = await tv.evaluate(function () {
      return { rank: Array.prototype.map.call(document.querySelectorAll('#gRank li'), function (li) { return li.textContent; }), medals: document.querySelectorAll('#gRank .medal.m1, #gRank .medal.m2, #gRank .medal.m3').length,
        by: Array.prototype.map.call(document.querySelectorAll('#gGrid .by'), function (b) { return b.textContent; }), title: document.getElementById('gRating').textContent };
    });
    check(fin.rank.length === 4 && fin.medals >= 3 && /^¡(Gana|Empate)/.test(fin.title), 'Clasificación con medallas: ' + fin.rank.join(' | ') + ' · «' + fin.title + '»');
    check(fin.by.length === 8 && fin.by.every(function (b) { return /^de (Ana|Berto|Carla|Dani)$/.test(b); }), 'Cada dibujo de la galería dice quién lo dibujó');
    await sleep(500);
    await shot(tv, 'tv-dibuja-4-final.png');
    await shot(tv720, 'tv-dibuja-4-final-720p.png');
    await shot(ph[0], 'movil-dibuja-final.png');
    await overflowAll('Final de Dibuja con 4');
    check(await ph[0].isVisible('#enAgain') && await ph[0].isVisible('#enRank li'), 'Los móviles: puesto, clasificación, «Jugar otra vez» y «Menú»');
    check(!errors.length, 'Sin errores de JavaScript en las páginas' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
  } catch (e) {
    failed++;
    console.log('  FALLO  Excepción: ' + (e && e.stack || e));
  } finally {
    fakes.forEach(function (f) { try { f.ws.terminate(); } catch (e) { /* noop */ } });
    await browser.close().catch(function () {});
    await srv.stop();
    H_.rmrf(HOME);
  }
  console.log('\nResultado (navegador, grupos): ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

main();
