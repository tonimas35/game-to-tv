'use strict';
/*
 * Headless Chromium (Playwright, optional): «Tanques».
 * Two emulated iPhones held sideways, a 1920x1080 TV, a 1280x720 TV and two
 * emulated LG webOS TVs (dpr 2, at 1920x1080 and 1280x720: FPS measured while
 * tanks drive and bullets bounce). Checks: picking the game from a phone,
 * 3-2-1, the floating stick (real touch events) moving the tank on the TV,
 * stick + «¡Fuego!» at the same time (multi-touch), the buttons mode, «?»,
 * the «gira el móvil» hint in portrait, pause and reconnection, a round won,
 * the winner screen with «Otra» / «Menú» (remote), and no text overflow.
 * Screenshots go to the folder given as argument.
 *
 *   node test/browser-tanques.js [carpeta-de-capturas]
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

const PORT = parseInt(process.env.TEST_PORT, 10) || 3973;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots-tanques'));
const HOME = H_.tmpHome('g2t-browser-tanques-');
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

// No visible text cut or outside the stage (as in browser-2048.js)
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
    var box = el.closest ? el.closest('.kSide, .kMid, .kBanner, .kEndS') : null;
    if (box) {
      var br = box.getBoundingClientRect();
      if (r.right > br.right + 2 || r.left < br.left - 2 || r.bottom > br.bottom + 2 || r.top < br.top - 2) bad.push('sale de su caja ' + label);
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
function tvState(page) { return page.evaluate(function () { var v = window.__tv.view('tanques').state(); return JSON.parse(JSON.stringify(v)); }); }
function tvMeta(page) { return tvState(page).then(function (s) { return s.meta; }); }
function phoneState(page) { return page.evaluate(function () { var v = window.G2T.phone.get('tanques').state(); return JSON.parse(JSON.stringify(v)); }); }

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Arrancando servidor en el puerto ' + PORT + ' (capturas en ' + SHOTS + ')');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '30000', TANQUES_TO_WIN: '3' });
  const browser = await pw.chromium.launch(LAUNCH);
  const errors = [];
  function watch(page, name) {
    page.on('pageerror', function (e) { errors.push(name + ': ' + e.message); });
    page.on('console', function (m) { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  }
  async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, name) }); }
  const webosUA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager';
  try {
    const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage(); watch(tv, 'tele');
    const tv720 = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage(); watch(tv720, 'tele720');
    const lg = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, userAgent: webosUA })).newPage(); watch(lg, 'tele-webos');
    const lg720 = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, userAgent: webosUA })).newPage(); watch(lg720, 'tele-webos-720');
    const tvs = [tv, tv720, lg, lg720];
    await Promise.all(tvs.map(function (p) { return p.goto(BASE + '/'); }));
    // FPS with the other TV pages closed (one CPU for the emulated TV), while `during` runs
    async function measureAlone(page, during) {
      const others = tvs.filter(function (p) { return p !== page; });
      for (const o of others) await o.goto('about:blank');
      await sleep(300);
      const res = await Promise.all([page.evaluate(MEASURE_FPS), during ? during() : Promise.resolve()]);
      for (const o of others) {
        await o.goto(BASE + '/');
        await waitFor(function () { return o.evaluate(function () { return window.__tv && window.__tv.screen() === 'tanques'; }); }, 5000, 'vuelve la tele');
      }
      await sleep(300);
      return res[0];
    }
    async function overflowAll(label) {
      const a = await tv.evaluate(OVERFLOW_CHECK);
      const b = await tv720.evaluate(OVERFLOW_CHECK);
      return check(!a.length && !b.length, label + ' sin desbordes a 1920x1080 ni a 1280x720' + (a.concat(b).length ? ': ' + a.concat(b).slice(0, 6).join(' | ') : ''));
    }
    // iPhone held sideways (Safari, landscape: about 750x340 of page)
    const iphone = { viewport: { width: 750, height: 340 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
    const phones = [];
    async function newPhone(name) {
      const p = await (await browser.newContext(iphone)).newPage(); watch(p, 'móvil-' + name);
      await p.goto(BASE + '/m');
      await p.fill('#name', name);
      await p.click('#joinBtn');
      await waitFor(function () { return p.evaluate(function () { return window.__phone.slot() > 0; }); }, 3000, 'unirse ' + name);
      const cdp = await p.context().newCDPSession(p);
      const ph = { page: p, cdp: cdp, name: name };
      phones.push(ph);
      return ph;
    }
    async function center(ph, sel) {
      return ph.page.evaluate(function (s) { var r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }, sel);
    }
    function touch(ph, type, points) { return ph.cdp.send('Input.dispatchTouchEvent', { type: type, touchPoints: points }); }

    // Stray bullets may end the duel early (a 3 in this test): then «Otra» from a phone
    async function ensureDuel() {
      const m = await tvMeta(tv);
      if (m && m.phase === 'end') {
        await ana.page.click('#kpAgain');
        await waitFor(function () { return tvMeta(tv).then(function (x) { return x && x.match > m.match; }); }, 3000, 'otra');
      }
      await waitFor(function () { return tvMeta(tv).then(function (x) { return x && x.phase === 'play' && !x.paused; }); }, 8000, 'en juego');
    }
    // FPS: the best of two runs (the test machine may be busy with other things)
    async function bestFps(page, during) {
      const a = await measureAlone(page, during);
      if (a >= 50) return a;
      await ensureDuel();
      return Math.max(a, await measureAlone(page, during));
    }

    console.log('\n[Elegir el juego]');
    const ana = await newPhone('Ana');
    const berto = await newPhone('Berto');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.hub() && window.__tv.hub().ready; }); }, 3000, 'sala lista');
    await ana.page.click('#gameList .game[data-game="tanques"]');
    const m0 = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'countdown' ? m : null; }); }, 4000, 'cuenta atrás');
    check(!!m0 && m0.tanks.join() === '1,2' && m0.count >= 2, 'Ana elige «Tanques» en el móvil: 3-2-1 en la tele');
    const pst = await waitFor(function () { return ana.page.evaluate(function () { return document.getElementById('kpStatus').textContent; }); }, 1000, 'estado móvil');
    check(/empieza en/.test(pst), 'Móvil: «' + pst + '»');
    await sleep(300);
    const cd = await tv.evaluate(function () { return { on: document.getElementById('kCount').className.indexOf('on') >= 0, n: document.getElementById('kCountN').textContent, s: document.getElementById('kCountS').textContent }; });
    check(cd.on && /^[123]$/.test(cd.n) && /Preparados/.test(cd.s), 'Tele: cuenta atrás grande («' + cd.n + '», «' + cd.s + '»)');
    await shot(tv, 'tanques-tv-cuenta-atras.png');
    await overflowAll('Cuenta atrás');
    await Promise.all(tvs.map(function (p) { return waitFor(function () { return tvMeta(p).then(function (m) { return m && m.phase === 'play'; }); }, 6000, 'en juego'); }));

    console.log('\n[Mando: palanca, fuego y botones]');
    const layout = await ana.page.evaluate(function () {
      function r(s) { var b = document.querySelector(s).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; }
      return { stick: r('#kpStick'), fire: r('#kpFire'), vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, rot: getComputedStyle(document.getElementById('kpRotate')).display };
    });
    check(layout.stick.r < layout.fire.l && layout.stick.w >= 250 && layout.stick.h >= 180 && layout.fire.w >= 200 && layout.fire.h >= 180 && layout.fire.r <= layout.vw && layout.fire.b <= layout.vh,
      'En horizontal: palanca a la izquierda (' + Math.round(layout.stick.w) + 'x' + Math.round(layout.stick.h) + ') y «¡Fuego!» grande a la derecha (' + Math.round(layout.fire.w) + 'x' + Math.round(layout.fire.h) + ')');
    check(layout.sw <= layout.vw && layout.sh <= layout.vh && layout.rot === 'none', 'Cabe sin desplazarse y sin el aviso de girar');
    async function tankOf(slot) {
      const s = await tvState(tv);
      const k = s.meta.tanks.indexOf(slot);
      const t = s.drawn.tanks[k];
      return t ? { x: t[0], y: t[1], a: t[2], alive: t[3] } : null;
    }
    // Stick to the right with real touch events
    const sc = await center(ana, '#kpStick');
    const before = await tankOf(1);
    await touch(ana, 'touchStart', [{ x: sc.x, y: sc.y, id: 1 }]);
    for (let k = 1; k <= 5; k++) await touch(ana, 'touchMove', [{ x: sc.x + 16 * k, y: sc.y, id: 1 }]);
    const held = await phoneState(ana.page);
    check(held.stick.m === 1 && Math.abs(held.stick.a) < 0.01 && /"s":\[0,1\]/.test(held.lastSent), 'Palanca a la derecha: el móvil manda dirección 0 y fuerza 1 (' + held.lastSent + ')');
    await shot(ana.page, 'tanques-movil-palanca.png');
    await sleep(900);
    const moved = await tankOf(1);
    check(moved.x > before.x + 60 && Math.abs(Math.cos(moved.a) - 1) < 0.05, 'El tanque de Ana gira hacia la derecha y avanza en la tele (x ' + Math.round(before.x) + ' → ' + Math.round(moved.x) + ')');
    // Fire with a second finger while the stick is held
    const fc = await center(ana, '#kpFire');
    await touch(ana, 'touchStart', [{ x: sc.x + 80, y: sc.y, id: 1 }, { x: fc.x, y: fc.y, id: 2 }]);
    const shotSeen = await waitFor(function () { return tvState(tv).then(function (s) { return s.drawn.bullets > 0; }); }, 1500, 'bala');
    check(!!shotSeen, '«¡Fuego!» con otro dedo mientras se mueve: la bala sale en la tele');
    await touch(ana, 'touchEnd', [{ x: sc.x + 80, y: sc.y, id: 1 }]);
    await touch(ana, 'touchEnd', []);
    await sleep(300);
    const rel = await phoneState(ana.page);
    const stop1 = await tankOf(1);
    await sleep(400);
    const stop2 = await tankOf(1);
    check(rel.stick.m === 0 && Math.abs(stop2.x - stop1.x) < 2 && Math.abs(stop2.y - stop1.y) < 2, 'Al soltar la palanca el tanque se para');
    // Buttons mode for Berto
    await berto.page.click('#kpMode');
    const bm = await berto.page.evaluate(function () { return { keys: !document.getElementById('kpKeys').classList.contains('hidden'), stick: document.getElementById('kpStick').classList.contains('hidden'), label: document.getElementById('kpMode').textContent }; });
    check(bm.keys && bm.stick && bm.label === 'Palanca', '«Botones»: ◀ ▶ ▲ ▼ en lugar de la palanca');
    // ▶ held (retried if a stray bullet ends the round meanwhile)
    const rc = await center(berto, '#kpKeys [data-k="right"]');
    let turned = 0, still = false, shotKeys = false;
    for (let tries = 0; tries < 4 && !(turned > 0.8 && still); tries++) {
      await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'play' && !m.paused; }); }, 6000, 'en juego');
      const r0 = (await tvMeta(tv)).round;
      const b0 = await tankOf(2);
      await touch(berto, 'touchStart', [{ x: rc.x, y: rc.y, id: 5 }]);
      await sleep(500);
      if (!shotKeys) { await shot(berto.page, 'tanques-movil-botones.png'); shotKeys = true; }
      await touch(berto, 'touchEnd', []);
      await sleep(200);
      const b1 = await tankOf(2);
      if ((await tvMeta(tv)).round !== r0 || !b0 || !b1) continue;
      turned = Math.abs(Math.atan2(Math.sin(b1.a - b0.a), Math.cos(b1.a - b0.a)));
      still = Math.abs(b1.x - b0.x) < 2 && Math.abs(b1.y - b0.y) < 2;
    }
    check(turned > 0.8 && still, '▶ mantenido: el tanque de Berto gira en el sitio (' + turned.toFixed(2) + ' rad)');
    const uc = await center(berto, '#kpKeys [data-k="up"]');
    const lc = await center(berto, '#kpKeys [data-k="left"]');
    await touch(berto, 'touchStart', [{ x: uc.x, y: uc.y, id: 6 }, { x: lc.x, y: lc.y, id: 7 }]);
    await sleep(150);
    const both = await phoneState(berto.page);
    await sleep(150);
    await touch(berto, 'touchEnd', []);
    check(both.keys.up && both.keys.left && /"k":\[-1,1\]/.test(both.lastSent), '▲ y ◀ a la vez (dos dedos): avanza girando (' + both.lastSent + ')');
    // Mode remembered on the phone
    await berto.page.click('#kpMode');
    check(await berto.page.evaluate(function () { return !document.getElementById('kpStick').classList.contains('hidden'); }), '«Palanca» vuelve a la palanca');
    // Bullets bouncing: a few shots from both
    for (let k = 0; k < 3; k++) {
      await touch(ana, 'touchStart', [{ x: fc.x, y: fc.y, id: 9 }]); await touch(ana, 'touchEnd', []);
      const bf = await center(berto, '#kpFire');
      await touch(berto, 'touchStart', [{ x: bf.x, y: bf.y, id: 9 }]); await touch(berto, 'touchEnd', []);
      await sleep(300);
    }
    await sleep(200);
    await shot(tv, 'tanques-tv-juego.png');
    await shot(tv720, 'tanques-tv-juego-720p.png');
    await shot(lg, 'tanques-tv-webos.png');
    await overflowAll('En juego');
    const cvs = await lg.evaluate(function () { return window.__tv.view('tanques').state().canvas; });
    check(cvs[0] <= 1280, 'Tele webOS (dpr 2): el lienzo se limita a ' + cvs[0] + 'x' + cvs[1]);

    console.log('\n[Rendimiento en la tele webOS emulada]');
    async function action() {
      // Both tanks drive around and shoot while the FPS is measured
      const t0 = Date.now();
      let k = 0;
      while (Date.now() - t0 < 2900) {
        const ang = k * 0.9;
        await touch(ana, 'touchStart', [{ x: sc.x, y: sc.y, id: 1 }]);
        await touch(ana, 'touchMove', [{ x: sc.x + Math.cos(ang) * 60, y: sc.y + Math.sin(ang) * 60, id: 1 }]);
        await touch(ana, 'touchStart', [{ x: sc.x + Math.cos(ang) * 60, y: sc.y + Math.sin(ang) * 60, id: 1 }, { x: fc.x, y: fc.y, id: 2 }]);
        await touch(ana, 'touchEnd', [{ x: sc.x + Math.cos(ang) * 60, y: sc.y + Math.sin(ang) * 60, id: 1 }]);
        await sleep(250);
        await touch(ana, 'touchEnd', []);
        k++;
      }
    }
    const fps1080 = await bestFps(lg, action);
    check(fps1080 >= 50, 'Tele webOS 1920x1080 (dpr 2) con tanques y balas: ' + fps1080 + ' FPS');
    await ensureDuel();
    const fps720 = await bestFps(lg720, action);
    check(fps720 >= 50, 'Tele webOS 1280x720 (dpr 2) con tanques y balas: ' + fps720 + ' FPS');

    console.log('\n[Ayuda y móvil en vertical]');
    await ensureDuel();
    await berto.page.click('#scr-tanques .kpHelpBtn');
    const help = await berto.page.evaluate(function () { return document.getElementById('kpHelp').classList.contains('hidden') ? 0 : document.querySelectorAll('#kpHelpList li').length; });
    check(help >= 5, '«?»: cómo se juega, en ' + help + ' líneas');
    await shot(berto.page, 'tanques-movil-ayuda.png');
    await berto.page.click('#kpHelpOk');
    await berto.page.setViewportSize({ width: 390, height: 664 });
    await sleep(300);
    const portrait = await berto.page.evaluate(function () {
      var f = document.getElementById('kpFire').getBoundingClientRect(), s = document.getElementById('kpStick').getBoundingClientRect();
      return { rot: getComputedStyle(document.getElementById('kpRotate')).display, txt: document.getElementById('kpRotate').textContent, below: f.top >= s.bottom - 1, fireH: f.height, sw: document.documentElement.scrollWidth };
    });
    check(portrait.rot !== 'none' && /Gira el móvil/.test(portrait.txt) && portrait.below && portrait.fireH >= 120 && portrait.sw <= 390, 'En vertical: aviso «' + portrait.txt + '» y aun así se puede jugar (fuego debajo de la palanca)');
    await shot(berto.page, 'tanques-movil-vertical.png');
    await berto.page.setViewportSize({ width: 750, height: 340 });

    console.log('\n[Pausa y reconexión]');
    await ensureDuel();
    await berto.page.goto('about:blank');
    const paused = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.paused ? m : null; }); }, 4000, 'pausa');
    check(!!paused && paused.waiting.join() === 'Berto', 'El móvil de Berto se va: pausa en la tele');
    await sleep(400);
    const pz = await tv.evaluate(function () { var p = document.getElementById('kPause'); return p.className.indexOf('on') >= 0 && document.getElementById('kPauseWho').textContent; });
    check(pz === 'Esperando a Berto…', 'Tele: «Pausa · ' + pz + '»');
    const apz = await ana.page.evaluate(function () { return !document.getElementById('kpPause').classList.contains('hidden') && document.getElementById('kpPauseWho').textContent; });
    check(apz === 'Esperando a Berto…', 'El móvil de Ana también lo dice');
    await shot(tv, 'tanques-tv-pausa.png');
    await shot(tv720, 'tanques-tv-pausa-720p.png');
    await overflowAll('Pausa');
    await berto.page.goto(BASE + '/m');
    const back = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && !m.paused && m.resumed ? m : null; }); }, 5000, 'reanuda');
    check(!!back && back.round === paused.round, 'Berto vuelve (mismo hueco): 3-2-1 «Seguimos» en la misma ronda');
    berto.cdp = await berto.page.context().newCDPSession(berto.page);
    await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'play'; }); }, 5000, 'sigue');

    console.log('\n[Una ronda y el final (a 3 en esta prueba)]');
    // Each phone aims up and shoots until somebody is hit; the walls do the rest
    async function aimUpAndShoot(ph) {
      const s = await center(ph, '#kpStick');
      const f = await center(ph, '#kpFire');
      await touch(ph, 'touchStart', [{ x: s.x, y: s.y, id: 1 }]);
      await touch(ph, 'touchMove', [{ x: s.x, y: s.y - 70, id: 1 }]);
      await sleep(250);
      await touch(ph, 'touchEnd', []);
      await touch(ph, 'touchStart', [{ x: f.x, y: f.y, id: 2 }]);
      await touch(ph, 'touchEnd', []);
    }
    let banner = null, sawBanner = false;
    const tEnd = Date.now() + 60000;
    while (Date.now() < tEnd) {
      const m = await tvMeta(tv);
      if (m && m.phase === 'end') break;
      if (m && m.phase === 'over' && m.last && !sawBanner) {
        await sleep(150);
        banner = await tv.evaluate(function () { return document.getElementById('kBanner').className.indexOf('on') >= 0 && document.getElementById('kBanT').textContent; });
        if (banner) {
          sawBanner = true;
          await shot(tv, 'tanques-tv-punto.png');
          await overflowAll('Resultado de la ronda');
        }
      }
      if (m && m.phase === 'play') { await aimUpAndShoot(ana); await aimUpAndShoot(berto); }
      await sleep(200);
    }
    check(sawBanner && /^¡(Punto para|Empate)/.test(banner), 'Tras un impacto, la tele dice «' + banner + '»');
    const end = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'end' ? m : null; }); }, 3000, 'final');
    check(!!end && end.winner > 0 && Math.max.apply(null, end.scores) === 3, 'Alguien llega a 3: fin del duelo (' + (end && end.scores.join('-')) + ')');
    await sleep(800);
    const fin = await tv.evaluate(function () { return { on: document.getElementById('kEnd').className.indexOf('on') >= 0, t: document.getElementById('kEndT').textContent, score: document.getElementById('kEndScore').textContent, focus: document.querySelector('#kEnd .btn.focus').textContent }; });
    const wName = end && end.winner === 1 ? 'Ana' : 'Berto';
    check(fin.on && fin.t === '¡Gana ' + wName + '!' && fin.focus === 'Otra', 'Tele: «' + fin.t + '» ' + fin.score + ' con «Otra» / «Menú»');
    const winnerPhone = end && end.winner === 1 ? ana : berto;
    const loserPhone = winnerPhone === ana ? berto : ana;
    const wp = await waitFor(function () { return winnerPhone.page.evaluate(function () { return !document.getElementById('kpEnd').classList.contains('hidden') && document.getElementById('kpEndT').textContent; }); }, 2000, 'final ganador');
    const lp = await loserPhone.page.evaluate(function () { return !document.getElementById('kpEnd').classList.contains('hidden') && document.getElementById('kpEndT').textContent; });
    check(wp === '¡Has ganado!' && lp === 'Has perdido' && await winnerPhone.page.isVisible('#kpAgain') && await winnerPhone.page.isVisible('#kpEnd .menuBtn'), 'Móviles: «¡Has ganado!» / «Has perdido» con «Otra» y «Menú»');
    await shot(tv, 'tanques-tv-ganador.png');
    await shot(tv720, 'tanques-tv-ganador-720p.png');
    await shot(winnerPhone.page, 'tanques-movil-ganador.png');
    await overflowAll('Pantalla del ganador');
    // The remote: right = «Menú», left = «Otra», OK = another duel
    await tv.keyboard.press('ArrowRight');
    check(await tv.evaluate(function () { return document.querySelector('#kEnd .btn.focus').textContent === 'Menú'; }), 'Con el mando se elige entre «Otra» y «Menú»');
    await tv.keyboard.press('ArrowLeft');
    await tv.keyboard.press('Enter');
    const again = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.match === end.match + 1 && m.phase === 'countdown' ? m : null; }); }, 3000, 'otra');
    check(!!again && again.scores.join() === '0,0', '«Otra» con el mando: duelo nuevo a 0-0');
    // Back / Escape asks to go back to the menu, as in the other games
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
  console.log('\nResultado (navegador, tanques): ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

main();
