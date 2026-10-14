'use strict';
/*
 * Headless Chromium (Playwright, optional): «Sumo».
 * Two emulated iPhones (Ana and Berto) and three TVs: 1920x1080, 1280x720 and
 * an emulated LG webOS TV (dpr 2: canvas capped at 1280, FPS measured while
 * the wrestlers push). Checks the joystick (real touch events, also together
 * with the «¡Embestida!» button), the cooldown ring, the pause when a phone
 * goes away and the reconnection, a whole match to 3 rounds, the winner
 * screen with «Otra» / «Menú» (remote and phone), Back, and that no text
 * overflows anywhere. Screenshots go to the folder given as argument.
 *
 *   node test/browser-sumo.js [carpeta-de-capturas]
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

const PORT = parseInt(process.env.TEST_PORT, 10) || 3962;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots-sumo'));
const HOME = H_.tmpHome('g2t-browser-sumo-');
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

// No visible text cut or outside the stage (as in the other browser tests)
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
    var box = el.closest ? el.closest('.suSide, .suBanner, .suMid') : null;
    if (box && box !== el) {
      var br = box.getBoundingClientRect();
      if (r.right > br.right + 2 || r.left < br.left - 2 || r.bottom > br.bottom + 2 || r.top < br.top - 2) bad.push('sale de su caja ' + label);
    }
  }
  // The score boxes must not overlap each other
  var sides = document.querySelectorAll('#vSumo .suSide, #vSumo .suMid');
  for (var a = 0; a < sides.length; a++) {
    for (var b = a + 1; b < sides.length; b++) {
      var A = sides[a].getBoundingClientRect(), B = sides[b].getBoundingClientRect();
      if (A.left < B.right - 1 && B.left < A.right - 1 && A.top < B.bottom - 1 && B.top < A.bottom - 1) bad.push('marcadores solapados ' + a + '/' + b);
    }
  }
  return bad;
};
const PHONE_OVERFLOW = function () {
  var bad = [];
  var vw = window.innerWidth, vh = window.innerHeight;
  var all = document.querySelectorAll('#scr-sumo *, #spOver *, #spPause *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!el.getClientRects().length) continue;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) bad.push('fuera ' + (el.id || el.className || el.tagName));
    var cs = getComputedStyle(el);
    if (cs.whiteSpace === 'nowrap' && el.scrollWidth > el.clientWidth + 2 && el.textContent.trim()) bad.push('recortado ' + (el.id || el.className));
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
function tvState(page) { return page.evaluate(function () { var s = window.__tv.view('sumo').state(); return JSON.parse(JSON.stringify(s)); }); }
function tvMeta(page) { return tvState(page).then(function (s) { return s.meta; }); }
function phoneState(page) { return page.evaluate(function () { return JSON.parse(JSON.stringify(window.G2T.phone.get('sumo').state())); }); }

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Arrancando servidor en el puerto ' + PORT + ' (capturas en ' + SHOTS + ')');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '30000' });
  const browser = await pw.chromium.launch(LAUNCH);
  const errors = [];
  let remote = null;
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
      return check(!a.length && !b.length, label + ': sin desbordes a 1920x1080 ni a 1280x720' + (a.concat(b).length ? ': ' + a.concat(b).slice(0, 6).join(' | ') : ''));
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

    console.log('\n[Elegir «Sumo» con 2 móviles]');
    const ana = await newPhone('Ana');
    const berto = await newPhone('Berto');
    // Picked by a fake remote (the menu may group the 1vs1 games: not this test's business)
    remote = H_.makeClient(WS, 'mando');
    await remote.ready;
    remote.send({ t: 'hello', role: 'tv' });
    await waitFor(function () { return remote.hub && remote.hub.ready; }, 3000, 'sala lista');
    remote.send({ t: 'pick', game: 'sumo' });
    const m0 = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'countdown' ? m : null; }); }, 4000, 'cuenta atrás');
    check(!!m0 && m0.slots.join() === '1,2' && m0.round === 1, 'Empieza «Sumo»: Ana contra Berto, ronda 1 con cuenta atrás');
    const cdTxt = await tv.evaluate(function () { return document.getElementById('suBig').textContent + '|' + document.getElementById('suN1').textContent + '|' + document.getElementById('suN2').textContent; });
    check(/^[123]\|Ana\|Berto$/.test(cdTxt), 'Tele: número de la cuenta atrás y los nombres en el marcador (' + cdTxt + ')');
    await shot(tv, 'sumo-tv-cuenta-atras.png');
    const ph0 = await waitFor(function () { return ana.evaluate(function () { return !document.getElementById('scr-sumo').classList.contains('hidden') && document.getElementById('spStatus').textContent; }); }, 3000, 'móvil en el juego');
    check(/^(Empieza en \d…|¡Empuja! Saca a Berto del círculo)$/.test(ph0 || ''), 'Móvil: «' + ph0 + '»');
    await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'playing'; }); }, 4000, 'a jugar');
    await waitFor(function () { return tvMeta(lg).then(function (m) { return !!m; }); }, 3000, 'tele lg');
    await waitFor(function () { return tvMeta(tv720).then(function (m) { return !!m; }); }, 3000, 'tele 720');

    console.log('\n[Joystick y «¡Embestida!» con toques de verdad]');
    const cdp = await ana.context().newCDPSession(ana);
    const geo = await ana.evaluate(function () {
      var j = document.getElementById('spJoy').getBoundingClientRect(), d = document.getElementById('spDash').getBoundingClientRect();
      return { jx: j.left + j.width / 2, jy: j.top + j.height / 2, jw: j.width, jh: j.height, dx: d.left + d.width / 2, dy: d.top + d.height / 2, dw: d.width };
    });
    check(geo.jh >= 250 && geo.dw >= 150, 'Joystick grande (' + Math.round(geo.jw) + 'x' + Math.round(geo.jh) + ' px) y botón grande (' + Math.round(geo.dw) + ' px)');
    const s0 = await tvState(tv);
    const x0 = s0.sample.w[0].x;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: geo.jx, y: geo.jy, id: 1 }] });
    for (let k = 1; k <= 5; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: geo.jx + 25 * k, y: geo.jy, id: 1 }] });
    await sleep(100);
    const pj = await phoneState(ana);
    check(pj.joy[0] > 0.9 && Math.abs(pj.joy[1]) < 0.05 && pj.sent[0] === pj.joy[0], 'Arrastrar a la derecha: joystick (' + pj.joy.join(', ') + ') enviado al servidor');
    const knob = await ana.evaluate(function () { return document.getElementById('spKnob').style.transform; });
    check(/translate3d\((\d+)/.test(knob) && parseFloat(/translate3d\(([\d.]+)/.exec(knob)[1]) > 40, 'La bolita del joystick sigue al dedo');
    const moved = await waitFor(function () { return tvState(tv).then(function (s) { return s.sample && s.sample.w[0].x > x0 + 60 ? s.sample.w[0].x : null; }); }, 2000, 'Ana se mueve');
    check(!!moved, 'En la tele, la bola de Ana va hacia la derecha (x ' + Math.round(x0) + ' → ' + Math.round(moved || 0) + ')');
    // Second finger on the dash button while the thumb stays on the joystick
    // (CDP: the points listed are the ones still down; the missing one is lifted)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: geo.jx + 125, y: geo.jy, id: 1 }, { x: geo.dx, y: geo.dy, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: geo.jx + 125, y: geo.jy, id: 1 }] });
    const cd = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.cd[0] > 0 ? m.cd[0] : null; }); }, 1500, 'enfriamiento');
    check(!!cd, '«¡Embestida!» con un segundo dedo: el servidor la acepta (recarga ' + cd + ' ms)');
    await sleep(250);
    const ring = await ana.evaluate(function () {
      var b = document.getElementById('spDash');
      return { off: parseFloat(document.getElementById('spRing').style.strokeDashoffset), cool: b.classList.contains('cool'), sub: document.getElementById('spDashSub').textContent, joy: window.G2T.phone.get('sumo').state().joy[0] };
    });
    check(ring.cool && ring.off > 100 && ring.off < 578 && ring.sub === 'Recargando…', 'El anillo del botón se va llenando (offset ' + ring.off + ', «' + ring.sub + '»)');
    check(ring.joy > 0.9, 'El joystick sigue apretado mientras se pulsa el botón');
    await shot(ana, 'sumo-movil-mando.png');
    await shot(tv, 'sumo-tv-juego.png');
    await shot(tv720, 'sumo-tv-juego-720p.png');
    await overflowAll('En juego');
    const pov = await ana.evaluate(PHONE_OVERFLOW);
    check(!pov.length, 'Móvil: todo cabe en 390x664' + (pov.length ? ': ' + pov.slice(0, 4).join(' | ') : ''));
    // Ready again (lit only while playing: the dash may have ended the round)
    const ready = await waitFor(function () {
      return ana.evaluate(function () {
        var b = document.getElementById('spDash'), sub = document.getElementById('spDashSub').textContent;
        var play = window.G2T.phone.get('sumo').state().meta.phase === 'playing';
        return !b.classList.contains('cool') && document.getElementById('spRing').style.strokeDashoffset === '0' &&
          (play ? b.classList.contains('ready') && sub === '¡Lista!' : sub === 'Espera…');
      });
    }, 3000, 'botón listo');
    check(!!ready, 'A los 2 s el anillo está lleno y el botón vuelve a estar listo');
    // Release: the joystick goes back and 0,0 is sent
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(150);
    const rel = await phoneState(ana);
    check(rel.joy[0] === 0 && rel.joy[1] === 0 && rel.sent[0] === 0, 'Al soltar, el joystick vuelve al centro y se manda 0,0');
    const scroll = await ana.evaluate(function () { return { x: window.scrollX, y: window.scrollY, w: document.documentElement.scrollWidth, sc: window.visualViewport ? window.visualViewport.scale : 1 }; });
    check(scroll.x === 0 && scroll.y === 0 && scroll.w <= 390 && scroll.sc === 1, 'La página del móvil no se desplaza ni se amplía');
    // «?»
    await ana.click('#scr-sumo .spHelpBtn');
    const help = await ana.evaluate(function () { return document.getElementById('spHelp').classList.contains('hidden') ? 0 : document.querySelectorAll('#spHelpList li').length; });
    check(help >= 5, '«?»: cómo se juega, en ' + help + ' líneas');
    await shot(ana, 'sumo-movil-ayuda.png');
    await ana.click('#spHelpOk');

    console.log('\n[Pausa y reconexión]');
    const bertoUrl = berto.url();
    await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'playing'; }); }, 8000, 'en juego antes de la pausa');
    await berto.goto('about:blank');
    const paused = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'paused' ? m : null; }); }, 3000, 'pausa');
    check(!!paused && paused.waiting.join() === 'Berto', 'Berto cierra la página: pausa esperando a Berto');
    await sleep(400);
    const pz = await tv.evaluate(function () { var p = document.getElementById('suPause'); return p.className.indexOf('on') >= 0 && document.getElementById('suPauseWho').textContent; });
    check(pz === 'Esperando a Berto…', 'Tele: «Pausa · ' + pz + '»');
    const apz = await waitFor(function () { return ana.evaluate(function () { return !document.getElementById('spPause').classList.contains('hidden') && document.getElementById('spPauseWho').textContent; }); }, 2000, 'pausa móvil');
    check(apz === 'Esperando a Berto…', 'Móvil de Ana: pausa');
    await shot(tv, 'sumo-tv-pausa.png');
    await overflowAll('Pausa');
    const mk = remote.mark();
    await berto.goto(bertoUrl);
    const back = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'countdown' && m.resumed ? m : null; }); }, 5000, 'vuelve');
    const sub = back ? await tv.evaluate(function () { return document.getElementById('suSub').textContent; }) : '';
    await waitFor(function () { return remote.since(mk, 'smeta').some(function (m) { return m.resumed; }); }, 2000, 'reanuda (mando)');
    const seen = remote.since(mk, 'smeta').map(function (m) { return m.phase + (m.resumed ? '+' : ''); }).filter(function (x, i, a) { return a.indexOf(x) === i; });
    check(seen.indexOf('countdown+') >= 0, 'Berto vuelve (misma pestaña): el servidor sigue con una cuenta atrás (' + seen.join(' → ') + ')');
    check(!!back && sub === 'Seguimos…', 'Tele: «' + sub + '»');
    check(!!(await waitFor(function () { return berto.evaluate(function () { var s = window.G2T.phone.get('sumo').state(); return s.meta && s.meta.phase !== 'paused'; }); }, 3000, 'móvil de Berto')), 'El móvil de Berto vuelve al juego');

    console.log('\n[Un combate entero: Ana empuja y embiste]');
    async function holdRight() {
      const g = await ana.evaluate(function () { var j = document.getElementById('spJoy').getBoundingClientRect(); return { x: j.left + j.width / 2, y: j.top + j.height / 2 }; });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g.x, y: g.y, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: g.x + 140, y: g.y, id: 1 }] });
      return g;
    }
    const hg = await holdRight();
    let banner = null, bannerWant = '', end = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const m = await tvMeta(tv);
      if (m && m.phase === 'end') { end = m; break; }
      if (m && m.phase === 'playing') {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: hg.x + 140, y: hg.y, id: 1 }, { x: geo.dx, y: geo.dy, id: 2 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: hg.x + 140, y: hg.y, id: 1 }] });
      }
      if (m && m.phase === 'roundover' && !banner) {
        await sleep(250);
        banner = await tv.evaluate(function () { var b = document.getElementById('suBanner'); return b.className.indexOf('on') >= 0 && b.textContent; });
        bannerWant = m.result.w === 0 ? '¡Empate! Se repite la ronda' : '¡Ronda para ' + (m.result.w === 1 ? 'Ana' : 'Berto') + '!';
        await shot(tv, 'sumo-tv-ronda.png');
        await shot(tv720, 'sumo-tv-ronda-720p.png');
        await overflowAll('Fin de ronda');
      }
      await sleep(150);
    }
    check(!!banner && banner === bannerWant, 'Tele, al acabar una ronda: «' + banner + '»');
    check(!!end && end.winner === 1 && end.score[0] === 3, 'Ana gana 3 rondas: fin del combate (' + (end && end.score.join('-')) + ')');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(900);
    const fin = await tv.evaluate(function () {
      return { on: document.getElementById('suEnd').className.indexOf('on') >= 0, t: document.getElementById('suEndT').textContent, s: document.getElementById('suEndS').textContent, focus: (document.querySelector('#suEnd .btn.focus') || {}).textContent };
    });
    check(fin.on && fin.t === '¡Gana Ana!' && !!end && fin.s === end.score.join(' – ') && fin.focus === 'Otra', 'Tele: «' + fin.t + '» ' + fin.s + ' con «Otra» / «Menú»');
    const pa = await waitFor(function () { return ana.evaluate(function () { return !document.getElementById('spOver').classList.contains('hidden') && document.getElementById('spOverT').textContent; }); }, 2000, 'final Ana');
    const pb = await waitFor(function () { return berto.evaluate(function () { return !document.getElementById('spOver').classList.contains('hidden') && document.getElementById('spOverT').textContent; }); }, 2000, 'final Berto');
    check(pa === '¡Has ganado!' && pb === 'Has perdido', 'Móviles: «' + pa + '» / «' + pb + '», con «Otra» y «Menú»');
    check(await berto.isVisible('#spAgain') && await berto.isVisible('#spOver .menuBtn'), 'Botones «Otra» y «Menú» en el móvil');
    await shot(tv, 'sumo-tv-ganador.png');
    await shot(tv720, 'sumo-tv-ganador-720p.png');
    await shot(ana, 'sumo-movil-ganador.png');
    await shot(berto, 'sumo-movil-perdedor.png');
    await overflowAll('Ganador');
    await tv.keyboard.press('ArrowRight');
    check(await tv.evaluate(function () { return document.querySelector('#suEnd .btn.focus').textContent === 'Menú'; }), 'Con el mando se elige entre «Otra» y «Menú»');
    await tv.keyboard.press('ArrowLeft');
    await tv.keyboard.press('Enter');
    const again = await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.match === end.match + 1 && m.phase === 'countdown' ? m : null; }); }, 3000, 'otra');
    check(!!again && again.score.join() === '0,0' && again.round === 1, '«Otra» con el mando: combate nuevo, 0 – 0');
    const pAgain = await waitFor(function () { return ana.evaluate(function () { return document.getElementById('spOver').classList.contains('hidden'); }); }, 2000, 'móvil sin final');
    check(!!pAgain, 'Los móviles vuelven al mando');

    console.log('\n[Rendimiento en la tele webOS emulada, en el combate nuevo]');
    await waitFor(function () { return tvMeta(lg).then(function (m) { return m && m.phase === 'playing'; }); }, 6000, 'a jugar (lg)');
    const lgCanvas = await lg.evaluate(function () { return window.__tv.view('sumo').state().canvas; });
    check(lgCanvas && lgCanvas[0] <= 1280, 'webOS: el lienzo se limita a 1280 de ancho (' + (lgCanvas && lgCanvas.join('x')) + ')');
    // Ana pushes right (touch) and Berto pushes left with the mouse (another way of
    // playing on a computer): they meet in the middle and shove each other
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: geo.jx, y: geo.jy, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: geo.jx + 140, y: geo.jy, id: 1 }] });
    const bj = await berto.evaluate(function () { var j = document.getElementById('spJoy').getBoundingClientRect(); return { x: j.left + j.width / 2, y: j.top + j.height / 2 }; });
    await berto.mouse.move(bj.x, bj.y);
    await berto.mouse.down();
    await berto.mouse.move(bj.x - 140, bj.y, { steps: 4 });
    const fps = await measureAlone(lg, async function () {
      for (let k = 0; k < 6; k++) { await berto.mouse.move(bj.x - 140, bj.y + (k % 2 ? 25 : -25), { steps: 3 }); await sleep(400); }
    });
    check(fps >= 50, 'Tele webOS emulada (dpr 2) con los luchadores empujándose: ' + fps + ' FPS');
    const lgS = await tvState(lg);
    check(lgS.states > 5 && !!lgS.sample, 'La tele webOS recibe estados y los interpola');
    await shot(lg, 'sumo-tv-webos.png');
    if (await waitFor(function () { return tvMeta(tv).then(function (m) { return m && m.phase === 'playing'; }); }, 6000, 'empujando')) {
      await sleep(1300);
      await shot(tv, 'sumo-tv-empujando.png');
    }
    await berto.mouse.up();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    // Back / Escape asks to go back to the menu
    await tv.keyboard.press('Escape');
    check(await tv.evaluate(function () { return document.getElementById('confirm').className.indexOf('on') >= 0; }), 'Atrás / Esc en la tele: «¿Volver al menú?»');
    await tv.keyboard.press('ArrowLeft');
    await tv.keyboard.press('Enter');
    check(!!(await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú')), '…y «Sí, al menú» vuelve al menú');
    const canvasHidden = await tv.evaluate(function () { return document.getElementById('suCanvas').style.display === 'none'; });
    check(canvasHidden, 'En el menú el lienzo del Sumo está oculto');
    const wide = [];
    for (const p of [ana, berto]) wide.push(await p.evaluate(function () { return document.documentElement.scrollWidth; }));
    check(wide.every(function (w) { return w <= 390; }), 'Los móviles no se salen de lado (390 px)');
    check(!errors.length, 'Sin errores de JavaScript en las páginas' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
  } catch (e) {
    failed++;
    console.log('  FALLO  Excepción: ' + (e && e.stack || e));
  } finally {
    if (remote) { try { remote.ws.terminate(); } catch (e) { /* noop */ } }
    await browser.close().catch(function () {});
    await srv.stop();
    H_.rmrf(HOME);
  }
  console.log('\nResultado (navegador, sumo): ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

main();
