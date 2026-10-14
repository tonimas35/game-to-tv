'use strict';
/*
 * Headless Chromium (Playwright, optional): «2048».
 * 1 player with an emulated iPhone, on a 1920x1080 TV, a 1280x720 TV and an
 * emulated LG webOS TV (dpr 2, FPS measured while the tiles slide): the menu
 * with the remote arrows, the TV keyboard moving the board, the phone arrow
 * buttons and swipes (a tiny swipe does nothing), «?», «Sin movimientos» and
 * «Otra». Then a race of 4 (2 iPhones + 2 fake phones): 4 boards in 2x2, the
 * clock, FPS, and the ranking with medals. No text overflow anywhere.
 * Screenshots go to the folder given as argument.
 *
 *   node test/browser-2048.js [carpeta-de-capturas]
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

const PORT = parseInt(process.env.TEST_PORT, 10) || 3989;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots-2048'));
const HOME = H_.tmpHome('g2t-browser-2048-');
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

// Same as browser-infiltrado.js: no visible text cut or outside the stage
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
    var label = (el.id || el.className || el.tagName) + ': «' + el.textContent.trim().slice(0, 40) + '»';
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible') bad.push('recortado ' + label);
    if (el.scrollHeight > el.clientHeight + 2 && cs.overflow !== 'visible') bad.push('recortado en alto ' + label);
    if (r.left < sr.left - 1 || r.right > sr.right + 1 || r.top < sr.top - 1 || r.bottom > sr.bottom + 1) bad.push('fuera de pantalla ' + label);
    if (r.width > 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflow === 'visible' && cs.whiteSpace === 'nowrap') bad.push('desborda ' + label);
    // Nothing sticks out of its card or board
    var box = el.closest ? el.closest('.nCard, .nBoard, .nBox, .nHelp') : null;
    if (box) {
      var br = box.getBoundingClientRect();
      if (r.right > br.right + 2 || r.left < br.left - 2 || r.bottom > br.bottom + 2 || r.top < br.top - 2) bad.push('sale de su caja ' + label);
    }
  }
  // Cards must not overlap each other
  var cards = document.querySelectorAll('#v2048 .nCard');
  for (var a = 0; a < cards.length; a++) {
    for (var b = a + 1; b < cards.length; b++) {
      var A = cards[a].getBoundingClientRect(), B = cards[b].getBoundingClientRect();
      if (A.left < B.right - 1 && B.left < A.right - 1 && A.top < B.bottom - 1 && B.top < A.bottom - 1) bad.push('tableros solapados ' + a + '/' + b);
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
// Arrow keys as the TV remote sends them (keyCode), n times
const PRESS = function (args) {
  var n = args[0], start = args[1] || 0;
  for (var i = 0; i < n; i++) {
    var e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
    var code = 37 + ((start + i) % 4);
    Object.defineProperty(e, 'keyCode', { get: function () { return code; } });
    window.dispatchEvent(e);
  }
};
function tvMeta(page) { return page.evaluate(function () { var v = window.__tv.view('2048').state().meta; return v ? JSON.parse(JSON.stringify(v)) : null; }); }

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Arrancando servidor en el puerto ' + PORT + ' (capturas en ' + SHOTS + ')');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '30000', G2048_RACE_SECONDS: '25' });
  const browser = await pw.chromium.launch(LAUNCH);
  const errors = [];
  const fakes = [];
  function watch(page, name) {
    page.on('pageerror', function (e) { errors.push(name + ': ' + e.message); });
    page.on('console', function (m) { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  }
  async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, name) }); }
  try {
    const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage(); watch(tv, 'tele');
    const tv720 = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage(); watch(tv720, 'tele720');
    const lg = await (await browser.newContext({
      viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager'
    })).newPage(); watch(lg, 'tele-webos');
    await Promise.all([tv.goto(BASE + '/'), tv720.goto(BASE + '/'), lg.goto(BASE + '/')]);
    // FPS with the other pages closed (one CPU for the emulated TV), while `during` runs
    async function measureAlone(page, during) {
      const others = [tv, tv720].filter(function (p) { return p !== page; });
      const screen = await page.evaluate(function () { return window.__tv.screen(); });
      for (const o of others) await o.goto('about:blank');
      await sleep(300);
      const res = await Promise.all([page.evaluate(MEASURE_FPS), during ? during() : Promise.resolve()]);
      for (const o of others) {
        await o.goto(BASE + '/');
        await waitFor(function () { return o.evaluate(function (s) { return window.__tv && window.__tv.screen() === s; }, screen); }, 5000, 'vuelve la tele');
      }
      await sleep(300);
      return res[0];
    }
    async function overflowAll(label) {
      const a = await tv.evaluate(OVERFLOW_CHECK);
      const b = await tv720.evaluate(OVERFLOW_CHECK);
      return check(!a.length && !b.length, label + ' sin desbordes a 1920x1080 ni a 1280x720' + (a.concat(b).length ? ': ' + a.concat(b).slice(0, 6).join(' | ') : ''));
    }
    const iphone = { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
    async function newPhone(name) {
      const p = await (await browser.newContext(iphone)).newPage(); watch(p, 'móvil-' + name);
      await p.goto(BASE + '/m');
      await p.fill('#name', name);
      await p.click('#joinBtn');
      await waitFor(function () { return p.evaluate(function () { return window.__phone.slot() > 0; }); }, 3000, 'unirse ' + name);
      return p;
    }

    console.log('\n[1 jugadora: menú]');
    const ana = await newPhone('Ana');
    const st = await waitFor(function () { return tv.evaluate(function () { var s = document.getElementById('menuStatus').textContent; return /Hola, Ana/.test(s) && s; }); }, 3000, 'estado menú');
    check(st === '¡Hola, Ana! Elige juego con el mando o desde el móvil', 'Tele con 1 móvil: «' + st + '»');
    const phoneSt = await ana.evaluate(function () { var b = document.querySelector('#gameList .game[data-game="2048"]'); return { st: document.getElementById('mStatus').textContent, dis: b.disabled, dib: document.querySelector('#gameList .game[data-game="dibuja"]').disabled }; });
    check(/^Juegas tú/.test(phoneSt.st) && !phoneSt.dis && phoneSt.dib, 'Móvil con 1: «2048» activo y los juegos de 2 en gris («' + phoneSt.st + '»)');
    // The remote arrows still move the menu to «2048»
    await H_.tvFocus(tv, '2048');
    const focus = await tv.evaluate(function () { var c = document.getElementById('card-2048'); return c.className.indexOf('focus') >= 0 && c.className.indexOf('off') < 0; });
    check(focus, 'Flechas en el menú de la tele: el foco llega a «2048» (disponible)');
    await tv.keyboard.press('ArrowLeft');
    check(await tv.evaluate(function () {
      var cs = [].slice.call(document.querySelectorAll('#cards .card'));
      return cs.indexOf(document.getElementById('card-2048')) - 1 === cs.indexOf(document.querySelector('#cards .card.focus'));
    }), '…y vuelve atrás con la flecha izquierda');
    await tv.keyboard.press('ArrowRight');
    await tv.keyboard.press('Enter');
    const m0 = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.mode === 'solo' ? m : null; }); }, 4000, 'empieza a solas');
    check(!!m0 && m0.boards.length === 1 && m0.boards[0].tiles.length === 8, 'OK: empieza «2048» a solas, con 2 fichas');
    await waitFor(function () { return tvMeta(tv720).then(function (m) { return !!m; }); }, 3000, 'tele 720');
    await waitFor(function () { return tvMeta(lg).then(function (m) { return !!m; }); }, 3000, 'tele lg');

    console.log('\n[1 jugadora: teclado de la tele, flechas y gestos en el móvil]');
    async function seqOf() { const m = await tvMeta(tv); return m ? m.boards[0].seq : -1; }
    async function movedAfter(action) {
      const before = await seqOf();
      await action();
      return waitFor(function () { return seqOf().then(function (s) { return s > before ? s : null; }); }, 700, 'movimiento');
    }
    let kb = null;
    for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) { if (kb) break; kb = await movedAfter(function () { return tv.keyboard.press(k); }); }
    check(!!kb, 'Las flechas del teclado de la tele mueven el tablero de Ana');
    await sleep(300);
    const tvTiles = await tv.evaluate(function () { return document.querySelectorAll('#v2048 .nT').length; });
    const m1 = await tvMeta(tv);
    check(tvTiles === m1.boards[0].tiles.length / 4, 'La tele dibuja una ficha por número (' + tvTiles + ')');
    // Phone: tap the big arrows
    let tapped = null;
    for (const d of ['left', 'up', 'right', 'down']) { if (tapped) break; tapped = await movedAfter(function () { return ana.tap('.npArrow[data-dir="' + d + '"]'); }); }
    check(!!tapped, 'Botones grandes del móvil: una flecha mueve las fichas');
    let clicked = null;
    for (const d of ['down', 'right', 'up', 'left']) { if (clicked) break; clicked = await movedAfter(function () { return ana.click('.npArrow[data-dir="' + d + '"]'); }); }
    check(!!clicked, 'También con ratón (clic) en un ordenador');
    // Swipes with real touch events
    const cdp = await ana.context().newCDPSession(ana);
    const c = await ana.evaluate(function () { var r = document.getElementById('npBoard').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    async function swipe(dx, dy) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
      for (let k = 1; k <= 4; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + dx * k / 4, y: c.y + dy * k / 4 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    let swiped = null;
    for (const v of [[-120, 0], [0, 120], [120, 0], [0, -120]]) { if (swiped) break; swiped = await movedAfter(function () { return swipe(v[0], v[1]); }); }
    check(!!swiped, 'Deslizar el dedo sobre el mando mueve las fichas');
    const s0 = await seqOf();
    for (const v of [[-12, 0], [0, 10], [9, 9], [0, -14]]) await swipe(v[0], v[1]);
    await sleep(500);
    check((await seqOf()) === s0, 'Un gesto diminuto (menos de 30 px) no hace nada');
    const scroll = await ana.evaluate(function () { return { x: window.scrollX, y: window.scrollY, w: document.documentElement.scrollWidth, sc: window.visualViewport ? window.visualViewport.scale : 1 }; });
    check(scroll.x === 0 && scroll.y === 0 && scroll.w <= 390 && scroll.sc === 1, 'La página del móvil no se desplaza ni se amplía');
    // Same board on the phone and the TV
    await sleep(300);
    const same = await Promise.all([
      ana.evaluate(function () { return Array.prototype.map.call(document.querySelectorAll('#npBoard i'), function (i) { return i.textContent || '0'; }).join(','); }),
      tvMeta(tv)
    ]);
    const cells = new Array(16).fill('0');
    for (let i = 0; i < same[1].boards[0].tiles.length; i += 4) cells[same[1].boards[0].tiles[i + 2]] = String(same[1].boards[0].tiles[i + 1]);
    check(same[0] === cells.join(','), 'El móvil enseña el mismo tablero que la tele');
    const scores = await ana.evaluate(function () { return { s: document.getElementById('npScore').textContent, b: document.getElementById('npBestL').textContent, newBtn: !document.getElementById('npNew').classList.contains('hidden') }; });
    check(scores.s === String(same[1].boards[0].score) && /RÉCORD/.test(scores.b) && scores.newBtn, 'Móvil: puntos, «Récord» y «Nueva partida»');
    await shot(ana, 'movil-2048-mando.png');
    // «?»
    await ana.click('#scr-2048 .npHelpBtn');
    const help = await ana.evaluate(function () { return document.getElementById('npHelp').classList.contains('hidden') ? 0 : document.querySelectorAll('#npHelpList li').length; });
    check(help >= 5, '«?»: cómo se juega, en ' + help + ' líneas');
    await shot(ana, 'movil-2048-ayuda.png');
    await ana.click('#npHelpOk');
    // «Nueva partida» asks first
    await ana.click('#npNew');
    const ask = await ana.evaluate(function () { return !document.getElementById('modal').classList.contains('hidden') && document.getElementById('modalText').textContent; });
    check(/partida nueva/.test(ask || ''), '«Nueva partida» pide confirmación: «' + ask + '»');
    await ana.click('#modalNo');
    // The TV
    for (let k = 0; k < 12; k++) await tv.evaluate(PRESS, [1, k]);
    await sleep(500);
    const soloTv = await tv.evaluate(function () { return { who: document.getElementById('nWho').textContent, score: document.getElementById('nScore').textContent, side: document.getElementById('nSideL').classList.contains('on') }; });
    check(soloTv.who === 'Ana' && soloTv.side, 'Tele a solas: tablero grande, con el nombre, los puntos y el récord a los lados');
    await shot(tv, 'tv-2048-1-jugadora.png');
    await shot(tv720, 'tv-2048-1-jugadora-720p.png');
    await overflowAll('A solas');
    const fpsSolo = await measureAlone(lg, async function () {
      for (let k = 0; k < 20; k++) { await lg.evaluate(PRESS, [1, k]); await sleep(130); }
    });
    check(fpsSolo >= 50, 'Tele webOS emulada (dpr 2) con las fichas moviéndose: ' + fpsSolo + ' FPS');
    await shot(lg, 'tv-2048-webos.png');

    console.log('\n[1 jugadora: sin movimientos]');
    let over = null;
    for (let round = 0; round < 80 && !over; round++) {
      await tv.evaluate(PRESS, [40, round]);
      await sleep(60);
      over = await tvMeta(tv).then(function (m) { return m && m.boards[0].over ? m : null; });
    }
    if (!check(!!over, 'Jugando sin parar, el tablero se llena: «Sin movimientos» (' + (over && over.boards[0].score) + ' puntos)')) throw new Error('no se acaba');
    await sleep(500);
    const ovTv = await tv.evaluate(function () { var c = document.querySelector('.nCard.solo.over'); return c && getComputedStyle(c.querySelector('.nOver')).display !== 'none' && c.querySelector('.nOverT').textContent + ' | ' + c.querySelector('.nOverB .btn.focus').textContent; });
    check(ovTv === 'Sin movimientos | Otra', 'Tele: «Sin movimientos» con «Otra» / «Menú» (foco en «Otra»)');
    const ovPh = await waitFor(function () { return ana.evaluate(function () { return !document.getElementById('npOver').classList.contains('hidden') && document.getElementById('npOverPts').textContent; }); }, 2000, 'móvil sin movimientos');
    check(ovPh === over.boards[0].score + ' puntos' && await ana.isVisible('#npAgain') && await ana.isVisible('#npOver .menuBtn'), 'Móvil: «Sin movimientos», los puntos, «Otra» y «Menú»');
    await shot(tv, 'tv-2048-sin-movimientos.png');
    await shot(tv720, 'tv-2048-sin-movimientos-720p.png');
    await shot(ana, 'movil-2048-sin-movimientos.png');
    await overflowAll('Sin movimientos');
    // The remote: right = «Menú», left = «Otra», then «Otra» from the phone
    await tv.keyboard.press('ArrowRight');
    check(await tv.evaluate(function () { return document.querySelector('.nCard.solo.over .nOverB .btn.focus').textContent === 'Menú'; }), 'Con el mando se elige entre «Otra» y «Menú»');
    await tv.keyboard.press('ArrowLeft');
    await ana.click('#npAgain');
    const again = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.match > over.match && !m.boards[0].over ? m : null; }); }, 3000, 'otra');
    check(!!again && again.boards[0].score === 0 && again.boards[0].best === over.boards[0].score, '«Otra»: tablero nuevo y el récord (' + (again && again.boards[0].best) + ') a la vista');

    console.log('\n[Carrera de 4]');
    await ana.click('#scr-2048 .bar .menuBtn');
    await ana.click('#modalYes');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú');
    const berto = await newPhone('Berto');
    fakes.push(await H_.phone(WS, 'Carla', 'f-carla'));
    fakes.push(await H_.phone(WS, 'Dani', 'f-dani'));
    await waitFor(function () { return tv.evaluate(function () { return document.querySelectorAll('.pchip.in').length === 4; }); }, 3000, '4 fichas');
    await berto.click('#gameList .game[data-game="2048"]');
    const intro = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.mode === 'race' && m.phase === 'intro' ? m : null; }); }, 3000, 'presentación');
    check(!!intro && intro.boards.length === 4, 'Berto elige «2048»: carrera de 4 con cuenta atrás');
    const play = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'play' ? m : null; }); }, 6000, 'en juego');
    check(!!play, '¡A jugar!');
    let k2 = 0;
    const timer = setInterval(function () {
      fakes.forEach(function (f, i) { f.send({ t: 'n.move', dir: ['left', 'down', 'right', 'up'][(k2 + i) % 4] }); });
      k2++;
    }, 120);
    let bt = null;
    for (const d of ['left', 'up', 'right', 'down']) { if (bt) break; bt = await waitFor(async function () { await berto.tap('.npArrow[data-dir="' + d + '"]'); return tvMeta(tv).then(function (m) { return m && m.boards[1].seq > 0; }); }, 400, 'berto mueve'); }
    check(!!bt, 'Berto mueve su tablero con las flechas del móvil');
    for (let k = 0; k < 8; k++) await tv.evaluate(PRESS, [1, k]);
    await sleep(600);
    const grid = await tv.evaluate(function () {
      var cs = document.querySelectorAll('#v2048 .nCard');
      var r = Array.prototype.map.call(cs, function (c) { var b = c.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), name: c.querySelector('.nName').textContent, color: c.style.borderColor }; });
      return { n: cs.length, rows: new Set(r.map(function (x) { return x.y; })).size, cols: new Set(r.map(function (x) { return x.x; })).size, names: r.map(function (x) { return x.name.replace(' ★', ''); }).join(','), colors: new Set(r.map(function (x) { return x.color; })).size, clock: document.getElementById('nClock').textContent };
    });
    check(grid.n === 4 && grid.rows === 2 && grid.cols === 2 && grid.names === 'Ana,Berto,Carla,Dani' && grid.colors === 4, 'Tele: 4 tableros en 2x2, con nombre y color de cada uno');
    check(/^0:\d\d$/.test(grid.clock), 'Reloj de la carrera en la tele: ' + grid.clock);
    const m4 = await tvMeta(tv);
    check(m4.boards[0].seq > 0, 'El teclado de la tele mueve el tablero de Ana (jugadora 1)');
    await shot(tv, 'tv-2048-4-jugadores.png');
    await shot(tv720, 'tv-2048-4-jugadores-720p.png');
    await shot(berto, 'movil-2048-carrera.png');
    await overflowAll('Carrera de 4');
    const fpsRace = await measureAlone(lg);
    check(fpsRace >= 50, 'Tele webOS emulada con 4 tableros moviéndose: ' + fpsRace + ' FPS');
    const end = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'end' ? m : null; }); }, 30000, 'fin de la carrera');
    clearInterval(timer);
    check(!!end && end.ranking.length === 4, 'Se acaba el tiempo: clasificación de los 4');
    await sleep(900);
    const fin = await tv.evaluate(function () { return { t: document.getElementById('nEndT').textContent, rows: document.querySelectorAll('#nRank li').length, medals: document.querySelectorAll('#nRank .medal.m1, #nRank .medal.m2, #nRank .medal.m3').length, focus: document.querySelector('#nEnd .btn.focus').textContent }; });
    const onTop = await tv.evaluate(function () {
      var r = document.querySelector('#nRank li').getBoundingClientRect();
      var el = document.elementFromPoint(r.left + r.width * 0.75, r.top + r.height / 2);
      return !!(el && el.closest && el.closest('#nEnd'));
    });
    check(onTop, 'La clasificación queda por encima de los tableros (ninguna ficha encima)');
    check(/^¡(Gana|Empate)/.test(fin.t) && fin.rows === 4 && fin.medals >= 3 && fin.focus === 'Otra carrera', 'Clasificación con medallas («' + fin.t + '») y «Otra carrera» / «Menú» con el mando');
    const phEnd = await waitFor(function () { return berto.evaluate(function () { return !document.getElementById('npEnd').classList.contains('hidden') && document.querySelectorAll('#npRank li').length; }); }, 2000, 'final móvil');
    check(phEnd === 4 && await berto.isVisible('#npEndAgain'), 'Móvil: puesto, clasificación y «Otra carrera»');
    await shot(tv, 'tv-2048-clasificacion.png');
    await shot(tv720, 'tv-2048-clasificacion-720p.png');
    await shot(berto, 'movil-2048-clasificacion.png');
    await overflowAll('Clasificación');
    // Back / Escape asks to go back to the menu, as in the other games
    await tv.keyboard.press('Escape');
    check(await tv.evaluate(function () { return document.getElementById('confirm').className.indexOf('on') >= 0; }), 'Atrás / Esc en la tele: «¿Volver al menú?»');
    await tv.keyboard.press('ArrowLeft');
    await tv.keyboard.press('Enter');
    check(!!(await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú')), '…y «Sí, al menú» vuelve al menú');
    const wide = [];
    for (const p of [ana, berto]) wide.push(await p.evaluate(function () { return document.documentElement.scrollWidth; }));
    check(wide.every(function (w) { return w <= 390; }), 'Los móviles no se salen de lado (390 px)');
    check(!errors.length, 'Sin errores de JavaScript en las páginas' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
  } catch (e) {
    failed++;
    console.log('  FALLO  Excepción: ' + (e && e.stack || e));
  } finally {
    fakes.forEach(function (f) { try { f.ws.terminate(); } catch (e) { /* noop */ } });
    await browser.close().catch(function () {});
    await srv.stop();
    H_.rmrf(HOME);
  }
  console.log('\nResultado (navegador, 2048): ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

main();
