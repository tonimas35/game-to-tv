'use strict';
/*
 * Headless Chromium (Playwright, optional): «Motos de neón».
 * Two emulated iPhones play on a 1920x1080 TV, a 1280x720 TV and an emulated
 * LG webOS TV (dpr 2): the phone controls (an arrow button on touchstart, a
 * swipe, two turns in one quick gesture), the crash vibration, the countdown,
 * the end of a round, FPS on the webOS TV while the trails grow (drawn
 * incrementally: no full redraw per frame), a TV that reloads mid-round and
 * rebuilds the same grid, a whole match to 5, the winner screen with «Otra» /
 * «Menú», «?», a pause, and Back. No text overflow anywhere.
 * Screenshots go to the folder given as argument (motos-*.png).
 *
 *   node test/browser-motos.js [carpeta-de-capturas]
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

const PORT = parseInt(process.env.TEST_PORT, 10) || 3953;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots-motos'));
const HOME = H_.tmpHome('g2t-browser-motos-');
// A bit slower than real (0.6): wider windows for the checks on a busy machine; the
// bikes still draw several segments per second while the FPS are measured
const SPEED = process.env.MOTOS_DEBUG_SPEED || '0.6';
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
    await sleep(25);
  }
  console.log('    (tiempo agotado: ' + label + ')');
  return null;
}

// Same as browser-2048.js: no visible text cut or outside the stage
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
    var box = el.closest ? el.closest('.mtP, .mtMid, .mtMsg, .mtEndRow, .btn') : null;
    if (box && box !== el) {
      var br = box.getBoundingClientRect();
      if (r.right > br.right + 2 || r.left < br.left - 2 || r.bottom > br.bottom + 2 || r.top < br.top - 2) bad.push('sale de su caja ' + label);
    }
  }
  return bad;
};
// FPS during `ms`
const MEASURE_FPS = function (ms) {
  return new Promise(function (res) {
    var n = 0, t0 = performance.now();
    function f() { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(Math.round(n * 1000 / (performance.now() - t0))); }
    requestAnimationFrame(f);
  });
};
// A swipe made of real TouchEvents fired inside the page in one go (no round trips)
const QUICK_SWIPE = function (a) {
  var el = document.querySelector(a.sel);
  var r = el.getBoundingClientRect();
  var x = r.left + r.width / 2, y = r.top + r.height / 2;
  function fire(type, px, py) {
    var t = new Touch({ identifier: 7, target: el, clientX: px, clientY: py, pageX: px, pageY: py });
    var live = type === 'touchend' ? [] : [t];
    el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: live, targetTouches: live, changedTouches: [t] }));
  }
  fire('touchstart', x, y);
  a.moves.forEach(function (m) {
    for (var k = 1; k <= 3; k++) fire('touchmove', x + m[0] * k / 3, y + m[1] * k / 3);
    x += m[0];
    y += m[1];
  });
  fire('touchend', x, y);
};
function tvState(page) { return page.evaluate(function () { var v = window.__tv.view('motos').state(); return JSON.parse(JSON.stringify(v)); }); }
function phoneState(page) { return page.evaluate(function () { return JSON.parse(JSON.stringify(G2T.phone.get('motos').state())); }); }
function phaseIs(page, ph, round) {
  return tvState(page).then(function (s) { return s.meta && s.meta.phase === ph && (round == null || s.meta.round === round) ? s : null; });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Arrancando servidor en el puerto ' + PORT + ' (capturas en ' + SHOTS + ')');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '30000', MOTOS_DEBUG_SPEED: SPEED });
  const browser = await pw.chromium.launch(LAUNCH);
  const errors = [];
  function watch(page, name) {
    page.on('pageerror', function (e) { errors.push(name + ': ' + e.message); });
    page.on('console', function (m) { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  }
  async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, 'motos-' + name) }); }
  try {
    const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage(); watch(tv, 'tele');
    const tv720 = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage(); watch(tv720, 'tele720');
    const lg = await (await browser.newContext({
      viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager'
    })).newPage(); watch(lg, 'tele-webos');
    await Promise.all([tv.goto(BASE + '/'), tv720.goto(BASE + '/'), lg.goto(BASE + '/')]);
    async function overflowAll(label) {
      const a = await tv.evaluate(OVERFLOW_CHECK);
      const b = await tv720.evaluate(OVERFLOW_CHECK);
      return check(!a.length && !b.length, label + ': sin desbordes a 1920x1080 ni a 1280x720' + (a.concat(b).length ? ': ' + a.concat(b).slice(0, 6).join(' | ') : ''));
    }
    const iphone = { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
    async function newPhone(name) {
      const ctx = await browser.newContext(iphone);
      // Record the vibrations (navigator.vibrate)
      await ctx.addInitScript(function () { window.__vib = []; try { navigator.vibrate = function (p) { window.__vib.push(p); return true; }; } catch (e) { /* noop */ } });
      const p = await ctx.newPage(); watch(p, 'móvil-' + name);
      await p.goto(BASE + '/m');
      await p.fill('#name', name);
      await p.click('#joinBtn');
      await waitFor(function () { return p.evaluate(function () { return window.__phone.slot() > 0; }); }, 3000, 'unirse ' + name);
      p.cdp = await ctx.newCDPSession(p);
      return p;
    }
    // A swipe with real touch events: from (x, y) through the given offsets
    async function swipe(page, x, y, moves) {
      await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x, y: y }] });
      let cx = x, cy = y;
      for (const mv of moves) {
        for (let k = 1; k <= 3; k++) await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + mv[0] * k / 3, y: cy + mv[1] * k / 3 }] });
        cx += mv[0];
        cy += mv[1];
      }
      await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }

    console.log('\n[Menú y comienzo]');
    const ana = await newPhone('Ana');
    const berto = await newPhone('Berto');
    const card = await waitFor(function () { return tv.evaluate(function () { var c = document.getElementById('card-motos'); return c && c.className.indexOf('off') < 0 && c.querySelector('h2').textContent; }); }, 3000, 'tarjeta');
    check(card === 'Motos de neón', 'La tele muestra la tarjeta «Motos de neón» (2 jugadores)');
    const btnPh = await ana.evaluate(function () { var b = document.querySelector('#gameList .game[data-game="motos"]'); return b && !b.disabled && b.querySelector('b').textContent; });
    check(btnPh === 'Motos de neón', 'En el móvil se puede elegir');
    await ana.click('#gameList .game[data-game="motos"]');
    const cd = await waitFor(function () { return phaseIs(tv, 'countdown', 1); }, 4000, 'cuenta atrás');
    check(!!cd && cd.meta.players.join() === '1,2', 'Ana elige el juego: cuenta atrás de la ronda 1');
    await waitFor(function () { return phaseIs(tv720, 'countdown'); }, 3000, 'tele 720');
    await waitFor(function () { return phaseIs(lg, 'countdown'); }, 3000, 'tele webos');
    await sleep(300);
    await shot(tv, 'tv-cuenta-atras.png');
    await overflowAll('Cuenta atrás');
    const canv = await Promise.all([tvState(tv), tvState(tv720), tvState(lg)]);
    check(canv[2].canvas[0] <= 1280 && canv[0].canvas[0] === 1920 && canv[1].canvas[0] === 1280, 'Canvas: ' + canv.map(function (s) { return s.canvas.join('x'); }).join(', ') + ' (en webOS como mucho 1280 de ancho)');

    console.log('\n[Ronda 1: mandos del móvil]');
    const cdTxt = await tvState(tv);
    check(!!cdTxt.count && /^[123]$/.test(cdTxt.count.n) && /Ronda 1/.test(cdTxt.count.sub) && cdTxt.hud.n1 === 'Ana' && cdTxt.hud.n2 === 'Berto' && cdTxt.hud.round === 'RONDA 1',
      'Tele: marcador arriba (' + cdTxt.hud.n1 + ' ' + cdTxt.hud.s1 + ' · ' + cdTxt.hud.round + ' · ' + cdTxt.hud.s2 + ' ' + cdTxt.hud.n2 + ') y cuenta atrás «' + cdTxt.count.n + '»');
    await waitFor(function () { return phaseIs(tv, 'playing', 1); }, 10000, 'en juego');
    // Two turns in one quick gesture: up, then right (a jog of one cell). The touch
    // events are fired inside the page, all at once: as fast as a real thumb
    const before = await tvState(tv);
    const sentBefore = (await phoneState(ana)).sent;
    await ana.evaluate(QUICK_SWIPE, { sel: '#mpStatus', moves: [[0, -26], [26, 0]] });
    const two = await waitFor(function () { return tvState(tv).then(function (s) { return s.dirs[0] === 1 && Math.floor(s.heads[0] / 64) === 16 && s.lens[0] >= before.lens[0] + 3 ? s : null; }); }, 2000, 'dos giros');
    const sentAfter = (await phoneState(ana)).sent;
    let jog = false;
    if (two) {
      // In the grid: row 17 up to the jog, one cell up, then row 16 to the right
      const g = two.grid, h = two.heads[0], hx = h % 64;
      let jx = -1;
      for (let x = 12; x <= hx; x++) if (g[16 * 64 + x] === '1' && g[17 * 64 + x] === '1') jx = x;
      jog = jx > 12 && g[16 * 64 + jx - 1] === '0' && g[17 * 64 + jx + 1] === '0';
    }
    if (!two) { const dbg = await tvState(tv); console.log('    (depuración: fase ' + dbg.meta.phase + ', dirs ' + dbg.dirs + ', cabezas ' + dbg.heads.map(function (c) { return (c % 64) + ',' + Math.floor(c / 64); }).join(' / ') + ', giros enviados ' + (sentAfter - sentBefore) + ')'); }
    check(sentAfter - sentBefore === 2 && !!two && jog, 'Un solo gesto rápido «arriba y derecha» manda dos giros y la moto hace los dos (sube una casilla y sigue)');
    // A swipe anywhere (here, on the band at the top of the pad)
    const band = await berto.evaluate(function () { var r = document.getElementById('mpBand').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await swipe(berto, band.x, band.y + 40, [[0, 30]]);
    const down = await waitFor(function () { return tvState(tv).then(function (s) { return s.dirs[1] === 2 ? s : null; }); }, 1500, 'Berto gira abajo');
    check(!!down, 'Deslizar hacia abajo (fuera de las flechas) gira la moto de Berto');
    // An arrow button: sent on touchstart
    await ana.tap('#scr-motos .mpArrow[data-dir="up"]');
    const up = await waitFor(function () { return tvState(tv).then(function (s) { return s.dirs[0] === 0 ? s : null; }); }, 1500, 'Ana gira arriba');
    check(!!up, 'Botón ▲ del móvil (al tocar): la moto de Ana gira hacia arriba');
    await shot(tv, 'tv-juego.png');
    await shot(tv720, 'tv-juego-720p.png');
    await shot(ana, 'movil-mando.png');
    await overflowAll('En juego');
    const end1 = await waitFor(function () { return phaseIs(tv, 'roundEnd', 1); }, 20000, 'fin de la ronda 1');
    check(!!end1 && end1.meta.last && end1.meta.last.crashes.length >= 1, 'Alguien choca: fin de la ronda 1 (' + (end1 && end1.meta.score.join('-')) + ')');
    const msg = end1 && end1.msg ? end1.msg.title + ' | ' + end1.msg.sub : '';
    check(/^¡(Ronda para|Empate)/.test(msg) && /chocó|nadie suma/.test(msg), 'La tele dice quién gana la ronda y por qué: «' + msg + '»');
    await sleep(300);
    const crashed = end1 ? end1.meta.last.crashes.map(function (c) { return c.side; }) : [];
    const loser = crashed.indexOf(1) >= 0 ? ana : berto;
    const vib = await loser.evaluate(function () { return { v: window.__vib.slice(), shakes: G2T.phone.get('motos').state().shakes, st: document.getElementById('mpStatus').textContent }; });
    check(vib.v.some(function (p) { return Array.isArray(p) && p.length >= 3; }) && vib.shakes === 1, 'El móvil de quien choca vibra y el mando tiembla (' + JSON.stringify(vib.v) + ')');
    await shot(tv, 'tv-fin-de-ronda.png');
    await shot(loser, 'movil-choque.png');
    await overflowAll('Fin de ronda');

    console.log('\n[Ronda 2: un giro en la cuenta atrás]');
    await waitFor(function () { return phaseIs(tv, 'countdown', 2); }, 12000, 'ronda 2');
    await ana.tap('#scr-motos .mpArrow[data-dir="left"]');
    const st2 = await phoneState(ana);
    check(st2.lastDir === 'left', 'Durante la cuenta atrás ya se puede girar (Ana: izquierda)');
    const end2 = await waitFor(function () { return phaseIs(tv, 'roundEnd', 2); }, 20000, 'fin de la ronda 2');
    check(!!end2 && end2.meta.last.winner === 2 && end2.meta.last.crashes[0].cause === 'muro', 'Ana se va contra el muro de la izquierda: ronda para Berto');
    const phSt = await berto.evaluate(function () { return document.getElementById('mpStatus').textContent; });
    check(phSt === '¡Ronda para ti!', 'Móvil de Berto: «' + phSt + '»');

    console.log('\n[Ronda 3: FPS en la tele webOS emulada]');
    // One CPU for the emulated TV: the other TV pages are closed meanwhile
    await tv.goto('about:blank');
    await tv720.goto('about:blank');
    await waitFor(function () { return phaseIs(lg, 'playing', 3); }, 20000, 'ronda 3 en juego');
    const s0 = await tvState(lg);
    const fps = await lg.evaluate(MEASURE_FPS, 3000);
    const s1 = await tvState(lg);
    check(fps >= 50, 'Tele webOS emulada (dpr 2, canvas de ' + s1.canvas.join('x') + ') con las estelas creciendo: ' + fps + ' FPS');
    check(s1.meta.phase === 'playing' || s1.k > 30, 'Medido mientras las motos corren (pasos ' + s0.k + ' → ' + s1.k + ')');
    check(s1.fullRedraws === s0.fullRedraws && s1.segs - s0.segs >= (s1.k - s0.k) * 2 - 2 && s1.frames - s0.frames > 20,
      'Las estelas se dibujan por partes: ' + (s1.segs - s0.segs) + ' tramos nuevos en ' + (s1.frames - s0.frames) + ' fotogramas, sin redibujarlas todas');
    await shot(lg, 'tv-webos.png');
    // The TVs come back mid-round: same grid as the webOS TV
    await tv.goto(BASE + '/');
    await tv720.goto(BASE + '/');
    const same = await waitFor(async function () {
      const a = await tvState(tv), b = await tvState(lg);
      return a.r === b.r && a.k === b.k && a.k > 0 && a.grid === b.grid ? a : null;
    }, 5000, 'misma rejilla');
    check(!!same, 'Una tele que se recarga a mitad de ronda rehace la misma rejilla que la otra (paso ' + (same && same.k) + ')');

    console.log('\n[Hasta 5 rondas]');
    let seen = 3;
    const t0 = Date.now();
    while (Date.now() - t0 < 150000) {
      const s = await tvState(lg);
      if (s.meta && s.meta.phase === 'gameover') break;
      if (s.meta && s.meta.phase === 'countdown' && s.meta.round > seen) {
        seen = s.meta.round;
        await ana.tap('#scr-motos .mpArrow[data-dir="' + ((seen - 1) % 2 === 0 ? 'up' : 'left') + '"]');
      }
      await sleep(80);
    }
    const over = await waitFor(function () { return phaseIs(tv, 'gameover'); }, 10000, 'final');
    check(!!over && over.meta.score[1] === 5 && over.meta.winner === 2, 'Berto llega a 5 rondas: fin de la partida (' + (over && over.meta.score.join('-')) + ')');
    await waitFor(function () { return phaseIs(tv720, 'gameover'); }, 3000, 'final 720');
    await sleep(600);
    const fin = await tv.evaluate(function () { return { t: document.getElementById('mtEndT').textContent, s: document.getElementById('mtEndS').textContent, focus: document.querySelector('#mtEnd .btn.focus').textContent }; });
    check(fin.t === '¡GANA BERTO!' && /5$/.test(fin.s) && fin.focus === 'Otra', 'Tele: «' + fin.t + '», ' + fin.s + ', con «Otra» / «Menú»');
    await tv.keyboard.press('ArrowRight');
    check(await tv.evaluate(function () { return document.querySelector('#mtEnd .btn.focus').textContent === 'Menú'; }), 'Con el mando se elige entre «Otra» y «Menú»');
    await tv.keyboard.press('ArrowLeft');
    const phEnd = await waitFor(function () { return berto.evaluate(function () { return !document.getElementById('mpOver').classList.contains('hidden') && document.getElementById('mpOverT').textContent; }); }, 2000, 'final móvil');
    const anaEnd = await ana.evaluate(function () { return document.getElementById('mpOverT').textContent; });
    check(phEnd === '¡Has ganado!' && anaEnd === 'Has perdido' && await berto.isVisible('#mpAgain') && await berto.isVisible('#mpOver .menuBtn'), 'Móviles: «¡Has ganado!» / «Has perdido», con «Otra» y «Menú»');
    await shot(tv, 'tv-ganador.png');
    await shot(tv720, 'tv-ganador-720p.png');
    await shot(berto, 'movil-ganador.png');
    await overflowAll('Ganador');
    await ana.click('#mpAgain');
    const again = await waitFor(function () { return phaseIs(tv, 'countdown', 1); }, 3000, 'otra');
    check(!!again && again.meta.score.join() === '0,0' && again.meta.match === 2, '«Otra» desde el móvil: partida nueva');

    console.log('\n[«?», pausa y Atrás]');
    await ana.click('#scr-motos .mpHelpBtn');
    const help = await ana.evaluate(function () { return document.getElementById('mpHelp').classList.contains('hidden') ? 0 : document.querySelectorAll('#mpHelpList li').length; });
    check(help >= 5, '«?»: cómo se juega, en ' + help + ' líneas');
    await shot(ana, 'movil-ayuda.png');
    await ana.click('#mpHelpOk');
    // Berto's phone goes away for a moment (same tab: same identity when it comes back)
    await berto.goto('about:blank');
    const pz = await waitFor(function () { return phaseIs(tv, 'paused'); }, 6000, 'pausa');
    await sleep(400);
    const pzTxt = await tv.evaluate(function () { return document.getElementById('mtWait').textContent; });
    check(!!pz && pzTxt === 'Esperando a Berto…', 'Si un móvil se va, pausa en la tele: «' + pzTxt + '»');
    const anaPause = await ana.evaluate(function () { return !document.getElementById('mpPause').classList.contains('hidden'); });
    check(anaPause, 'El otro móvil también muestra «Pausa»');
    await shot(tv, 'tv-pausa.png');
    await overflowAll('Pausa');
    await berto.goto(BASE + '/m');
    const back = await waitFor(function () { return tvState(tv).then(function (s) { return s.meta && (s.meta.phase === 'countdown' || s.meta.phase === 'playing') ? s : null; }); }, 10000, 'vuelve');
    check(!!back && (await berto.evaluate(function () { return window.__phone.slot(); })) === 2, 'Berto vuelve a abrir la página: recupera su sitio y sigue la partida');
    const scroll = [];
    for (const p of [ana, berto]) scroll.push(await p.evaluate(function () { return { w: document.documentElement.scrollWidth, x: window.scrollX, y: window.scrollY }; }));
    check(scroll.every(function (s) { return s.w <= 390 && s.x === 0 && s.y === 0; }), 'Los móviles no se desplazan ni se salen de lado (390 px)');
    await tv.keyboard.press('Escape');
    check(await tv.evaluate(function () { return document.getElementById('confirm').className.indexOf('on') >= 0; }), 'Atrás / Esc en la tele: «¿Volver al menú?»');
    await tv.keyboard.press('ArrowLeft');
    await tv.keyboard.press('Enter');
    check(!!(await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú')), '…y «Sí, al menú» vuelve al menú');
    check(!errors.length, 'Sin errores de JavaScript en las páginas' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
  } catch (e) {
    failed++;
    console.log('  FALLO  Excepción: ' + (e && e.stack || e));
  } finally {
    await browser.close().catch(function () {});
    await srv.stop();
    H_.rmrf(HOME);
  }
  console.log('\nResultado (navegador, motos): ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

main();
