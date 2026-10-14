'use strict';
/*
 * Headless Chromium (Playwright, optional): «Hockey de mesa».
 * Ana plays on an emulated iPhone (joins in portrait: «Gira el móvil»; then
 * landscape: her half of the table), Berto is a fake phone. TVs at 1920x1080,
 * 1280x720 and an emulated LG webOS TV (dpr 2: canvas capped at 1280, FPS
 * measured while the puck moves). Checks the drag control (absolute, ~60 Hz
 * at most, only on change), the mallet on the TV, goals, the winner screen
 * with «Otra» / «Menú» (remote and phone), «?», and Back -> menu.
 * A tiny bot plays both sides (Berto by WebSocket, Ana with real touches).
 *
 *   node test/browser-hockey.js [carpeta-de-capturas]
 * Without Playwright it is skipped (exit 0).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const H_ = require('./helpers');
const Hockey = require('../src/games/hockey');

let pw = null;
const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/npm-tools/node_modules/playwright'].filter(Boolean);
for (const c of candidates) { try { pw = require(c); break; } catch (e) { /* sigue */ } }
if (!pw) { console.log('Playwright no está disponible: se omite la prueba con navegador.'); process.exit(0); }

const PORT = parseInt(process.env.TEST_PORT, 10) || 4128;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots-hockey'));
const HOME = H_.tmpHome('g2t-browser-hockey-');
const F = Hockey.FIELD;
const P = Hockey.physics;
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

// No visible text cut or outside the stage (same as the other browser tests)
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
    if (r.left < sr.left - 1 || r.right > sr.right + 1 || r.top < sr.top - 1 || r.bottom > sr.bottom + 1) bad.push('fuera de pantalla ' + label);
  }
  // The game canvas covers the window exactly (no scrollbars)
  var c = document.getElementById('hkCanvas');
  if (c && c.style.display !== 'none') {
    var cr = c.getBoundingClientRect();
    if (Math.abs(cr.width - window.innerWidth) > 1 || Math.abs(cr.height - window.innerHeight) > 1) bad.push('canvas ' + cr.width + 'x' + cr.height);
  }
  if (document.documentElement.scrollWidth > window.innerWidth + 1 || document.documentElement.scrollHeight > window.innerHeight + 1) bad.push('la página se desplaza');
  return bad;
};
const MEASURE_FPS = function () {
  return new Promise(function (res) {
    var n = 0, t0 = performance.now();
    function f() { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(Math.round(n * 1000 / (performance.now() - t0))); }
    requestAnimationFrame(f);
  });
};
function tvState(page) { return page.evaluate(function () { var v = window.__tv.view('hockey').state(); return JSON.parse(JSON.stringify(v)); }); }
function phoneState(page) { return page.evaluate(function () { return JSON.parse(JSON.stringify(G2T.phone.get('hockey').state())); }); }

// Bot: a target for the mallet of `side` that pushes the puck towards the other goal
function botTarget(side, s) {
  const px = s.p[0], py = s.p[1];
  const mx = s.m[side * 2], my = s.m[side * 2 + 1];
  const mine = side === 0 ? px < F.w / 2 + 10 : px > F.w / 2 - 10;
  const home = side === 0 ? 180 : F.w - 180;
  if (!mine || s.ph !== 'playing') return P.clampToHalf(side, home, F.h / 2 + (side === 0 ? -200 : 200));
  const gx = side === 0 ? F.w + 100 : -100;
  let dx = gx - px, dy = F.h / 2 - py;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  const behind = side === 0 ? mx < px - 10 : mx > px + 10;
  if (!behind) {
    // Go around the puck first (do not push it into my own goal)
    const off = my < py ? -1 : 1;
    return P.clampToHalf(side, px - dx * 140, py + off * 130);
  }
  const a = P.clampToHalf(side, px - dx * 110, py - dy * 110);
  if (Math.hypot(mx - a.x, my - a.y) < 30) return P.clampToHalf(side, px + dx * 160, py + dy * 160);
  return a;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Arrancando servidor en el puerto ' + PORT + ' (capturas en ' + SHOTS + ')');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '30000', HOCKEY_POINTS: '3' });
  const browser = await pw.chromium.launch(LAUNCH);
  const errors = [];
  const fakes = [];
  function watch(page, name) {
    page.on('pageerror', function (e) { errors.push(name + ': ' + e.message); });
    page.on('console', function (m) { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  }
  async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, 'hockey-' + name + '.png') }); }
  let botTimer = null;
  try {
    const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage(); watch(tv, 'tele');
    const tv720 = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage(); watch(tv720, 'tele720');
    const lg = await (await browser.newContext({
      viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager'
    })).newPage(); watch(lg, 'tele-webos');
    await Promise.all([tv.goto(BASE + '/'), tv720.goto(BASE + '/'), lg.goto(BASE + '/')]);
    async function measureAlone(page) {
      const others = [tv, tv720].filter(function (p) { return p !== page; });
      for (const o of others) await o.goto('about:blank');
      await sleep(300);
      const fps = await page.evaluate(MEASURE_FPS);
      for (const o of others) {
        await o.goto(BASE + '/');
        await waitFor(function () { return o.evaluate(function () { return window.__tv && window.__tv.screen() === 'hockey'; }); }, 5000, 'vuelve la tele');
      }
      await sleep(300);
      return fps;
    }
    async function overflowAll(label) {
      const a = await tv.evaluate(OVERFLOW_CHECK);
      const b = await tv720.evaluate(OVERFLOW_CHECK);
      return check(!a.length && !b.length, label + ' sin desbordes a 1920x1080 ni a 1280x720' + (a.concat(b).length ? ': ' + a.concat(b).slice(0, 6).join(' | ') : ''));
    }
    // A fake TV for the bot (it reads the 30 Hz states)
    const botTv = H_.makeClient(WS, 'bot-tele'); fakes.push(botTv);
    await botTv.ready;
    let botState = null;
    botTv.ws.on('message', function (d) { const m = JSON.parse(d.toString()); if (m.t === 'hs') botState = m; });
    botTv.send({ t: 'hello', role: 'tv' });

    const iphone = { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
    const ana = await (await browser.newContext(iphone)).newPage(); watch(ana, 'móvil-Ana');
    await ana.goto(BASE + '/m');
    await ana.fill('#name', 'Ana');
    await ana.click('#joinBtn');
    await waitFor(function () { return ana.evaluate(function () { return window.__phone.slot() > 0; }); }, 3000, 'unirse Ana');
    const berto = await H_.phone(WS, 'Berto', 'b-berto'); fakes.push(berto);

    console.log('\n[Empieza: el móvil en vertical pide girarlo]');
    await waitFor(function () { return ana.evaluate(function () { var b = document.querySelector('#gameList .game[data-game="hockey"]'); return b && !b.disabled; }); }, 3000, 'botón activo');
    await ana.click('#gameList .game[data-game="hockey"]');
    const m0 = await waitFor(function () { return tvState(tv).then(function (s) { return s.meta && s.meta.phase === 'countdown' ? s.meta : null; }); }, 4000, 'cuenta atrás');
    check(!!m0 && m0.players.join() === '1,2', 'Ana elige «Hockey de mesa»: cuenta atrás en la tele (Ana a la izquierda, Berto a la derecha)');
    await sleep(400);
    const portrait = await ana.evaluate(function () {
      var r = document.getElementById('hkRotate'), w = document.getElementById('hkWrap');
      return { rot: getComputedStyle(r).display !== 'none' && r.textContent, wrap: getComputedStyle(w).display };
    });
    check(!!portrait.rot && /Gira el móvil/.test(portrait.rot) && portrait.wrap === 'none', 'En vertical: «Gira el móvil» en lugar de la mesa');
    await shot(ana, 'movil-vertical');
    await shot(tv, 'tv-cuenta-atras');

    console.log('\n[En horizontal: tu mitad de la mesa]');
    await ana.setViewportSize({ width: 844, height: 390 });
    await sleep(400);
    const land = await ana.evaluate(function () {
      var pad = document.getElementById('hkPad').getBoundingClientRect();
      return { rot: getComputedStyle(document.getElementById('hkRotate')).display, pad: { x: pad.left, y: pad.top, w: pad.width, h: pad.height },
        sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, sx: window.scrollX, sy: window.scrollY };
    });
    const ps0 = await phoneState(ana);
    check(land.rot === 'none' && land.pad.w > 400 && land.pad.h > 300 && ps0.box.w > 280 && Math.abs(ps0.box.w - ps0.box.h) < 2,
      'En horizontal: la mitad de la mesa (cuadrada, ' + Math.round(ps0.box.w) + ' px) ocupa el alto del móvil');
    check(land.sw <= 844 && land.sh <= 390 && land.sx === 0 && land.sy === 0, 'La página del móvil no se desplaza');
    check(ps0.side === 0 && Math.abs(ps0.pos.x - 0.24) < 0.01, 'Su mazo empieza donde lo tiene el servidor (h.you)');

    const cdp = await ana.context().newCDPSession(ana);
    function padPoint(u, v) { return { x: land.pad.x + ps0.box.x + u * ps0.box.w, y: land.pad.y + ps0.box.y + v * ps0.box.h }; }
    async function touch(type, u, v) {
      await cdp.send('Input.dispatchTouchEvent', { type: type, touchPoints: type === 'touchEnd' ? [] : [padPoint(u, v)] });
    }
    await waitFor(function () { return tvState(tv).then(function (s) { return s.meta.phase === 'playing'; }); }, 5000, 'en juego');
    // Drag: the mallet follows the finger (absolute)
    await touch('touchStart', 0.2, 0.2);
    for (let k = 1; k <= 10; k++) { await touch('touchMove', 0.2 + 0.06 * k, 0.2 + 0.05 * k); await sleep(20); }
    const ps1 = await phoneState(ana);
    check(Math.abs(ps1.pos.x - 0.8) < 0.01 && Math.abs(ps1.pos.y - 0.7) < 0.01, 'Arrastrar el dedo: el mazo va donde está el dedo (0.80, 0.70 de su mitad)');
    const goal = P.targetFromInput(0, 0.8, 0.7);
    const onTv = await waitFor(function () { return tvState(tv).then(function (s) { return s.render && Math.hypot(s.render.m[0] - goal.x, s.render.m[1] - goal.y) < 3 ? s.render : null; }); }, 2000, 'mazo en la tele');
    check(!!onTv, 'La tele dibuja el mazo de Ana en ese sitio (' + Math.round(goal.x) + ', ' + Math.round(goal.y) + ')');
    // Beyond the pad: clamped to the half
    await touch('touchMove', 1.6, -0.5);
    await sleep(100);
    const ps2 = await phoneState(ana);
    const lim = F.malletR / (F.w / 2);
    check(Math.abs(ps2.pos.x - (1 - lim)) < 1e-6 && Math.abs(ps2.pos.y - F.malletR / F.h) < 1e-6, 'Fuera de la mesa del móvil, el mazo se queda en el borde (la línea del centro)');
    await touch('touchEnd', 0.5, 0.5);
    // At most ~60 per second, and only on change: a finger moving every 4 ms
    // for 600 ms (150 touchmove events, dispatched inside the page)
    const PAD_TOUCHES = function (args) {
      var pad = document.getElementById('hkPad'), r = pad.getBoundingClientRect();
      var b = G2T.phone.get('hockey').state().box;
      var moving = args[0], ms = args[1];
      function pt(u, v) { return { x: r.left + b.x + u * b.w, y: r.top + b.y + v * b.h }; }
      function fire(type, p) {
        var t = new Touch({ identifier: 7, target: pad, clientX: p.x, clientY: p.y });
        pad.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], cancelable: true, bubbles: true }));
      }
      var before = G2T.phone.get('hockey').state().sent, n = 0, t0 = performance.now();
      fire('touchstart', pt(0.3, 0.5));
      return new Promise(function (res) {
        var iv = setInterval(function () {
          n++;
          fire('touchmove', moving ? pt(0.3 + 0.4 * ((n % 50) / 50), 0.3 + 0.004 * n) : pt(0.3, 0.5));
          if (performance.now() - t0 >= ms) {
            clearInterval(iv);
            setTimeout(function () {
              fire('touchend', pt(0.3, 0.5));
              res({ moves: n, ms: Math.round(performance.now() - t0), sent: G2T.phone.get('hockey').state().sent - before });
            }, 100);
          }
        }, 4);
      });
    };
    const burst = await ana.evaluate(PAD_TOUCHES, [true, 600]);
    const allowed = Math.ceil(burst.ms / 15) + 2;
    check(burst.sent >= 5 && burst.sent <= allowed && burst.sent < burst.moves,
      'Dedo moviéndose: ' + burst.moves + ' eventos en ' + burst.ms + ' ms -> ' + burst.sent + ' envíos (máx. ~60 por segundo: ' + allowed + ')');
    const still = await ana.evaluate(PAD_TOUCHES, [false, 300]);
    check(still.sent <= 1, 'Dedo quieto: ' + still.moves + ' eventos -> ' + still.sent + ' envíos (solo se envían cambios)');
    await touch('touchStart', 0.45, 0.6);
    await sleep(150);
    await shot(ana, 'movil-mando');
    await touch('touchEnd', 0.45, 0.6);

    // «?»
    await ana.click('#scr-hockey .hkHelpBtn');
    const help = await ana.evaluate(function () { return document.getElementById('hkHelp').classList.contains('hidden') ? 0 : document.querySelectorAll('#hkHelpList li').length; });
    check(help >= 5, '«?»: cómo se juega, en ' + help + ' líneas');
    await shot(ana, 'movil-ayuda');
    await ana.click('#hkHelpOk');

    console.log('\n[La tele: interpolación, rendimiento y desbordes]');
    // The bot plays both sides from now on
    let anaTouching = false, botBusy = false, botQuiet = false;
    async function botTick() {
      if (botBusy || botQuiet) return;
      botBusy = true;
      try {
        const s = botState;
        if (!s) return;
        const b = botTarget(1, s);
        const ib = P.inputFromPos(1, b.x, b.y);
        berto.send({ t: 'h.m', x: Math.round(ib.x * 1000) / 1000, y: Math.round(ib.y * 1000) / 1000 });
        const a = botTarget(0, s);
        const ia = P.inputFromPos(0, a.x, a.y);
        if (!anaTouching) { anaTouching = true; await touch('touchStart', ia.x, ia.y); } else await touch('touchMove', ia.x, ia.y);
      } catch (e) { /* page busy */ } finally { botBusy = false; }
    }
    botTimer = setInterval(botTick, 40);
    const st0 = await tvState(tv);
    const ws0 = botTv.msgs.filter(function (m) { return m.t === 'hs'; }).length;
    await sleep(2000);
    const st1 = await tvState(tv);
    const wsRate = (botTv.msgs.filter(function (m) { return m.t === 'hs'; }).length - ws0) / 2;
    const perSec = (st1.states - st0.states) / 2;
    // (exactly 30 per 60 server ticks in test/hockey.test.js; a busy machine delays the server loop)
    check(wsRate >= 22 && wsRate <= 34 && perSec >= 20 && st1.frames - st0.frames > 20,
      'El servidor manda ~30 estados/s (' + wsRate + '); la tele los recibe (' + perSec + '/s) y dibuja (' + Math.round((st1.frames - st0.frames) / 2) + ' FPS con las 3 teles abiertas)');
    // The puck moves smoothly: consecutive frames never jump much
    const jumps = await tv.evaluate(function () {
      return new Promise(function (res) {
        var v = window.__tv.view('hockey'), prev = null, max = 0, n = 0, still = 0;
        function f() {
          var s = v.state();
          if (s.render && s.meta.phase === 'playing' && prev) {
            var d = Math.hypot(s.render.puck.x - prev.x, s.render.puck.y - prev.y);
            if (d > max && d < 300) max = d;
            if (d === 0) still++;
            n++;
          }
          prev = s.render ? { x: s.render.puck.x, y: s.render.puck.y } : null;
          if (n < 90) requestAnimationFrame(f); else res({ max: Math.round(max), still: still, n: n });
        }
        requestAnimationFrame(f);
      });
    });
    check(jumps.n >= 90, 'Disco interpolado/extrapolado en ' + jumps.n + ' fotogramas (salto máximo ' + jumps.max + ' u, ' + jumps.still + ' fotogramas sin moverse)');
    await shot(tv, 'tv-juego');
    await shot(tv720, 'tv-juego-720p');
    await overflowAll('En juego');
    const sizes = await Promise.all([tv, tv720, lg].map(function (p) { return tvState(p).then(function (s) { return s.w + 'x' + s.h; }); }));
    check(sizes[0] === '1920x1080' && sizes[1] === '1280x720' && sizes[2] === '1280x720', 'Canvas: 1920x1080, 1280x720 y en webOS limitado a 1280 de ancho (' + sizes.join(', ') + ')');
    console.log('\n[Goles y final]');
    function isGoal(m) { return m.t === 'hmeta' && m.phase === 'goal'; }
    const gm = await botTv.wait(isGoal, 60000, 'un gol');
    check(!!gm && gm.score[0] + gm.score[1] >= 1, '¡Gol! (' + (gm && gm.score.join('-')) + ')');
    // Screenshot of a goal on the TV (the next one if this one is over)
    const tvPhase = (await tvState(tv)).meta.phase;
    let shotGoal = tvPhase === 'goal';
    if (!shotGoal) {
      const next = await botTv.wait(function (m) { return isGoal(m) || (m.t === 'hmeta' && m.phase === 'end'); }, 60000, 'otro gol', botTv.msgs.length);
      shotGoal = !!next && next.phase === 'goal';
      if (!shotGoal) console.log('    (tele en ' + tvPhase + '; después: ' + (next ? next.phase + ' ' + next.score.join('-') : 'nada') + ')');
    }
    if (shotGoal) { await sleep(100); await shot(tv, 'tv-gol'); await shot(tv720, 'tv-gol-720p'); }
    check(shotGoal, 'Gol en la tele: destello y «¡GOL de …!» (captura)');

    // FPS on the emulated webOS TV alone (the machine may be busy: best of 3;
    // the bot keeps Berto moving, Ana's touches pause meanwhile)
    let fps = 0;
    for (let k = 0; k < 3 && fps < 50; k++) {
      botQuiet = true;
      if (botState && botState.ph !== 'playing') await sleep(1500);
      fps = Math.max(fps, await measureAlone(lg));
      botQuiet = false;
      await sleep(300);
    }
    check(fps >= 50, 'Tele webOS emulada (dpr 2) con el disco en juego: ' + fps + ' FPS');
    await shot(lg, 'tv-webos');

    const endMsg = await botTv.wait(function (m) { return m.t === 'hmeta' && m.phase === 'end'; }, 90000, 'final');
    // The serve after the first goal went towards the one who conceded
    const gi = botTv.msgs.indexOf(gm);
    let firstPlay = null;
    for (let i = gi + 1; i < botTv.msgs.length && !firstPlay; i++) if (botTv.msgs[i].t === 'hs' && botTv.msgs[i].ph === 'playing') firstPlay = botTv.msgs[i];
    check(!!gm && !!firstPlay && gm.serve === 3 - gm.lastScorer && (gm.serve === 1 ? firstPlay.p[2] < 0 : firstPlay.p[2] > 0),
      'Tras el gol, el disco sale hacia quien ha encajado (' + (gm && (gm.serve === 1 ? 'Ana' : 'Berto')) + ')');
    const end = endMsg ? (await waitFor(function () { return tvState(tv).then(function (s) { return s.meta.phase === 'end' ? s.meta : null; }); }, 3000, 'final en la tele')) : null;
    clearInterval(botTimer);
    botTimer = null;
    if (anaTouching) { await touch('touchEnd', 0.5, 0.5); anaTouching = false; }
    check(!!end && Math.max(end.score[0], end.score[1]) === 3 && end.winner > 0, 'A 3 (en esta prueba): gana ' + (end && (end.winner === 1 ? 'Ana' : 'Berto')) + ' ' + (end && end.score.join('-')));
    await sleep(800);
    await shot(tv, 'tv-ganador');
    await shot(tv720, 'tv-ganador-720p');
    const phEnd = await waitFor(function () { return ana.evaluate(function () { var o = document.getElementById('hkOver'); return !o.classList.contains('hidden') && document.getElementById('hkOverT').textContent; }); }, 2000, 'final móvil');
    const expect = end && end.winner === 1 ? '¡Has ganado!' : 'Has perdido';
    check(phEnd === expect && await ana.isVisible('#hkAgain') && await ana.isVisible('#hkOver .menuBtn'), 'Móvil: «' + phEnd + '», el marcador, «Otra» y «Menú»');
    const btns = await ana.evaluate(function () { var r = document.querySelector('#hkOver .hkOverB').getBoundingClientRect(); return r.bottom <= window.innerHeight && r.top >= 0; });
    check(btns, 'Los botones del final caben en el móvil en horizontal');
    await shot(ana, 'movil-final');
    await overflowAll('Final');
    // Remote: ▶ «Menú», ◀ «Otra»
    await tv.keyboard.press('ArrowRight');
    const f1 = (await tvState(tv)).focus;
    await tv.keyboard.press('ArrowLeft');
    const f0 = (await tvState(tv)).focus;
    check(f1 === 1 && f0 === 0, 'Con el mando se elige entre «Otra» y «Menú»');
    await ana.click('#hkAgain');
    const again = await waitFor(function () { return tvState(tv).then(function (s) { return s.meta.match === 2 && s.meta.phase === 'countdown' ? s.meta : null; }); }, 3000, 'otra');
    check(!!again && again.score.join() === '0,0', '«Otra» en el móvil: partida nueva 0-0');
    // Back / Escape asks to go back to the menu
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
    if (botTimer) clearInterval(botTimer);
    fakes.forEach(function (f) { try { f.ws.terminate(); } catch (e) { /* noop */ } });
    await browser.close().catch(function () {});
    await srv.stop();
    H_.rmrf(HOME);
  }
  console.log('\nResultado (navegador, hockey): ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

main();
