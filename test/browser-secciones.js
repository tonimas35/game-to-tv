'use strict';
/*
 * Headless Chromium (Playwright, optional): the menu sections («1 contra 1»)
 * with 4 FAKE duels written to a temporary folder (test/helpers/juegos-falsos.js):
 *  - the main row has ONE «1 contra 1» card (our art, «Duelos rápidos para
 *    dos») and none of its games; without section games there is no card
 *  - OK opens the sub-menu (same cards), the arrows move and scroll, Back
 *    (Escape and the LG key 461) goes back to the section card
 *  - «Falta 1 jugador» / «sois 3» on each card of the sub-menu, and OK there
 *    gives the reason to everybody
 *  - OK picks a duel; back from it, the TV is in the sub-menu on that duel
 *  - a phone picks while the TV is in the sub-menu (a duel, and Pong)
 *  - the phone group: closed while no duel fits, open by itself with 2,
 *    opens and closes with a tap, its duels are picked with {t:'pick'}
 *  - no overflow at 1920x1080 and 1280x720, FPS of the menu on an emulated
 *    LG webOS TV, no JS errors
 * Screenshots: menu-*.png in the folder given as argument.
 *
 *   node test/browser-secciones.js [carpeta-de-capturas]
 * Without Playwright it is skipped (exit 0).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const H_ = require('./helpers');
const { writeFakeGames } = require('./helpers/juegos-falsos');

let pw = null;
const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/npm-tools/node_modules/playwright'].filter(Boolean);
for (const c of candidates) { try { pw = require(c); break; } catch (e) { /* sigue */ } }
if (!pw) { console.log('Playwright no está disponible: se omite la prueba con navegador.'); process.exit(0); }

const PORT = parseInt(process.env.TEST_PORT, 10) || 3987;
const PORT_PLAIN = PORT - 1;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots-secciones'));
const TMP = H_.tmpHome('g2t-browser-secciones-');
process.env.GAME_TO_TV_HOME = path.join(TMP, 'home');
const games = require('../src/games');
const { createServer } = require('../src/server');
const FAKE_DIR = writeFakeGames(path.join(TMP, 'juegos'));
const PLAIN_DIR = writeFakeGames(path.join(TMP, 'sin-seccion'), [{ id: 'prueba-normal', title: 'Normal', description: 'Juego de prueba sin sección.', minPlayers: 2, maxPlayers: 2, section: null, accent: '#ffffff' }]);
// The fake duels go first in the section (order 1-4); the real ones follow
const DUELS = ['prueba-duelo-a', 'prueba-duelo-b', 'prueba-duelo-c', 'prueba-duelo-d'];
const REAL_DUELS = ['tanques', 'motos', 'hockey', 'sumo'];

const LAUNCH = { args: ['--autoplay-policy=no-user-gesture-required'] };
if (fs.existsSync('/opt/pw-browsers')) {
  try {
    const dirs = fs.readdirSync('/opt/pw-browsers').filter(function (d) { return /^chromium-\d+$/.test(d); }).sort();
    const exe = dirs.length ? path.join('/opt/pw-browsers', dirs[dirs.length - 1], 'chrome-linux', 'chrome') : null;
    if (exe && fs.existsSync(exe)) LAUNCH.executablePath = exe;
  } catch (e) { /* the default one */ }
}

const check = H_.checker('Secciones del menú («1 contra 1») en la tele y el móvil');
const sleep = H_.sleep;
async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* sigue */ }
    await sleep(50);
  }
  console.log('    (tiempo agotado: ' + label + ')');
  return null;
}

// Same rules as browser-smoke.js / browser-grupo.js, plus: the cards of the
// visible row must not stick out of the stage when focused, and nothing
// sticks out of its card
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
    // Cards scrolled out of the row (.cardsWrap clips them)
    var card = el.closest ? el.closest('.card') : null;
    if (card) {
      var cr = card.getBoundingClientRect();
      if (cr.left < sr.left - 1 || cr.right > sr.right + 1) continue;
      if (r.right > cr.right + 2 || r.left < cr.left - 2 || r.bottom > cr.bottom + 2 || r.top < cr.top - 2) bad.push('sale de su tarjeta ' + (el.className || el.tagName) + ': «' + el.textContent.trim().slice(0, 30) + '»');
    }
    var label = (el.id || el.className || el.tagName) + ': «' + el.textContent.trim().slice(0, 40) + '»';
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible') bad.push('recortado ' + label);
    if (el.scrollHeight > el.clientHeight + 2 && cs.overflow !== 'visible') bad.push('recortado en alto ' + label);
    if (r.left < sr.left - 1 || r.right > sr.right + 1 || r.top < sr.top - 1 || r.bottom > sr.bottom + 1) bad.push('fuera de pantalla ' + label);
    if (r.width > 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflow === 'visible' && cs.whiteSpace === 'nowrap') bad.push('desborda ' + label);
  }
  // The focused card of the visible row is entirely on screen
  var f = document.querySelector('.cards:not(.hide) .card.focus');
  if (f) {
    var fr = f.getBoundingClientRect();
    if (fr.left < sr.left - 1 || fr.right > sr.right + 1) bad.push('tarjeta enfocada fuera de la pantalla: ' + f.id);
  }
  // The section header does not touch the «Atrás» pill
  var hd = document.getElementById('secTitle'), bk = document.getElementById('secBack');
  if (hd && bk && hd.getClientRects().length && bk.getClientRects().length) {
    var a = hd.parentNode.querySelector('.secArt').getBoundingClientRect(), b = bk.getBoundingClientRect();
    if (a.left < b.right + 8 && a.top < b.bottom && b.top < a.bottom) bad.push('la cabecera de la sección pisa «Atrás»');
  }
  return bad;
};
// The phone: no horizontal scroll, and the group fits the screen
const PHONE_CHECK = function () {
  var bad = [];
  if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push('scroll horizontal');
  var els = document.querySelectorAll('#gameList .sec, #gameList .sec *');
  for (var i = 0; i < els.length; i++) {
    var r = els[i].getBoundingClientRect();
    if (!r.width) continue;
    if (r.right > window.innerWidth + 1 || r.left < -1) bad.push('fuera de la pantalla: ' + (els[i].className || els[i].tagName));
    if (els[i].scrollWidth > els[i].clientWidth + 2 && getComputedStyle(els[i]).overflow !== 'visible') bad.push('recortado: ' + (els[i].className || els[i].tagName));
  }
  return bad;
};
const MEASURE_FPS = function () {
  return new Promise(function (res) {
    var n = 0, t0 = performance.now();
    function f() { n++; if (performance.now() - t0 < 2500) requestAnimationFrame(f); else res(Math.round(n * 1000 / (performance.now() - t0))); }
    requestAnimationFrame(f);
  });
};
// The LG remote's «Back» key (keyCode 461)
const LG_BACK = function () {
  var e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: function () { return 461; } });
  window.dispatchEvent(e);
};
function menuOf(page) { return page.evaluate(function () { return window.__tv.menu(); }); }

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Servidores en ' + PORT + ' (con 4 duelos falsos) y ' + PORT_PLAIN + ' (sin secciones); capturas en ' + SHOTS);
  const quiet = function () {};
  const srv = createServer({ port: PORT, hostIp: '192.168.1.50', galleryDir: null, dataDir: null, gamesDirs: [games.GAMES_DIR, FAKE_DIR], maxPlayers: 6, slotHoldMs: 30000, log: quiet });
  const plain = createServer({ port: PORT_PLAIN, hostIp: '192.168.1.50', galleryDir: null, dataDir: null, gamesDirs: [PLAIN_DIR], maxPlayers: 6, log: quiet });
  await srv.listen();
  await plain.listen();
  const browser = await pw.chromium.launch(LAUNCH);
  const errors = [];
  const fakes = [];
  function watch(page, name) {
    page.on('pageerror', function (e) { errors.push(name + ': ' + e.message); });
    page.on('console', function (m) { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  }
  async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, name) }); }
  const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
  try {
    // ---------------- Without section games: no card ----------------
    console.log('\n[Sin juegos de sección]');
    const p0 = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); watch(p0, 'tele-sin');
    await p0.goto('http://127.0.0.1:' + PORT_PLAIN + '/');
    await waitFor(function () { return p0.evaluate(function () { return window.__tv && window.__tv.menu().cards.length === 1; }); }, 4000, 'menú sin secciones');
    const none = await p0.evaluate(function () {
      return { sec: document.querySelectorAll('.card.sec').length, rows: document.querySelectorAll('.cards').length, keys: document.getElementById('menuKeys').textContent };
    });
    check(none.sec === 0 && none.rows === 1 && none.keys === '◀ ▶ elegir juego · OK jugar', 'Sin juegos con "section": ni tarjeta «1 contra 1» ni segunda fila');
    await p0.keyboard.press('Enter');
    await p0.keyboard.press('Escape');
    check((await menuOf(p0)).row === 'main', 'Atrás en el menú principal no hace nada raro');
    const m0 = await (await browser.newContext(iphone)).newPage(); watch(m0, 'móvil-sin');
    await m0.goto('http://127.0.0.1:' + PORT_PLAIN + '/m');
    check(await m0.evaluate(function () { return document.querySelectorAll('#gameList .sec').length === 0 && document.querySelectorAll('#gameList .game').length === 1; }), 'Ni grupo en el móvil');
    await p0.context().close();
    await m0.context().close();

    // ---------------- The main row ----------------
    console.log('\n[Fila principal]');
    const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage(); watch(tv, 'tele');
    const tv720 = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage(); watch(tv720, 'tele720');
    const TVS = [tv, tv720];
    await Promise.all(TVS.map(function (p) { return p.goto(BASE + '/'); }));
    await waitFor(function () { return tv.evaluate(function () { return document.getElementById('conn').className.indexOf('on') < 0; }); }, 4000, 'conecta');
    // The same key on both TVs (each page has its own menu)
    async function press(key) { for (const p of TVS) await p.keyboard.press(key); }
    async function overflow(label) {
      await sleep(350); // the row slides (0.25 s)
      const bad = (await tv.evaluate(OVERFLOW_CHECK)).concat((await tv720.evaluate(OVERFLOW_CHECK)).map(function (s) { return '720p: ' + s; }));
      check(!bad.length, label + ': sin desbordes a 1920x1080 ni a 1280x720' + (bad.length ? ': ' + bad.join(' | ') : ''));
    }

    // Every game of the section, from G2T_BOOT (the 4 fakes and the real duels)
    const SEC = await tv.evaluate(function () { return window.G2T.sectionById('1vs1').games; });
    const N = SEC.length;
    check(SEC.slice(0, 4).join() === DUELS.join() && REAL_DUELS.every(function (id) { return SEC.indexOf(id) >= 4; }),
      'La sección tiene los 4 duelos falsos y los reales (' + SEC.slice(4).join(', ') + ')');
    const main0 = await tv.evaluate(function () {
      var c = document.getElementById('card-sec-1vs1');
      var ids = [].map.call(document.querySelectorAll('#cards .card'), function (x) { return x.id; });
      return {
        ids: ids, inMain: !!c && c.parentNode.id === 'cards', svg: !!(c && c.querySelector('.art svg')), h2: c && c.querySelector('h2').textContent,
        p: c && c.querySelector('p').textContent, tags: c && [].map.call(c.querySelectorAll('.tags span'), function (s) { return s.textContent; }),
        sub: [].map.call(document.querySelectorAll('#cards-sec-1vs1 .card'), function (x) { return x.id; }),
        subHidden: getComputedStyle(document.getElementById('cards-sec-1vs1')).display === 'none'
      };
    });
    check(main0.inMain && main0.svg && main0.h2 === '1 contra 1' && main0.p === 'Duelos rápidos para dos' && main0.tags.join() === '2 jugadores,' + N + ' juegos',
      'Una tarjeta «1 contra 1» en la fila principal, con dibujo propio, «Duelos rápidos para dos», «2 jugadores» y «' + N + ' juegos»');
    check(main0.ids.filter(function (id) { return /prueba-duelo/.test(id); }).length === 0 && main0.ids.length === games.loadGames([games.GAMES_DIR], quiet).list.filter(function (g) { return !g.manifest.section; }).length + 1,
      'Los duelos no salen sueltos en la fila principal (' + main0.ids.join(', ') + ')');
    check(main0.ids[1] === 'card-sec-1vs1', 'La tarjeta va la segunda (se ve nada más encender)');
    check(main0.sub.join() === SEC.map(function (d) { return 'card-' + d; }).join() && main0.subHidden, 'Sus ' + N + ' juegos están en una fila aparte, oculta');
    check(REAL_DUELS.every(function (id) { return main0.sub.indexOf('card-' + id) >= 0; }) && main0.ids.every(function (id) { return REAL_DUELS.indexOf(id.replace('card-', '')) < 0; }),
      'Los cuatro duelos reales (Tanques, Motos, Hockey, Sumo) están en el submenú y no en la fila principal');

    // ---------------- Phones: 1 player ----------------
    console.log('\n[Con 1 jugadora]');
    async function newPhone(name) {
      const p = await (await browser.newContext(iphone)).newPage(); watch(p, 'móvil ' + name);
      await p.goto(BASE + '/m');
      await p.fill('#name', name);
      await p.click('#joinBtn');
      await waitFor(function () { return p.evaluate(function () { return window.__phone.slot() > 0; }); }, 3000, 'unirse ' + name);
      return p;
    }
    const ana = await newPhone('Ana');
    await waitFor(function () { return tv.evaluate(function () { return /Ana/.test(document.getElementById('chip1').textContent); }); }, 3000, 'chip Ana');
    await sleep(200);
    const one = await tv.evaluate(function () { var c = document.getElementById('card-sec-1vs1'); return { off: c.classList.contains('off'), why: c.querySelector('.why').textContent }; });
    check(one.off && one.why === 'Falta 1 jugador', 'Con 1: la tarjeta de la sección dice «' + one.why + '»');
    const ph1 = await ana.evaluate(function () {
      var s = document.getElementById('sec-1vs1');
      return { open: s.classList.contains('open'), why: s.querySelector('.secHead .why').textContent, n: s.querySelectorAll('.secBody .game').length, vis: s.querySelector('.secBody').getClientRects().length };
    });
    check(!ph1.open && ph1.vis === 0 && ph1.n === N && ph1.why === ' · Falta 1 jugador', 'Móvil con 1: el grupo «1 contra 1» está cerrado y dice por qué («' + ph1.why + '»)');

    // ---------------- TV: open the section ----------------
    console.log('\n[Tele: abrir la sección con el mando]');
    await press('ArrowRight');
    const f1 = await menuOf(tv);
    check(f1.row === 'main' && f1.focus === 'card-sec-1vs1' && await tv.evaluate(function () { return document.getElementById('menuKeys').textContent; }) === '◀ ▶ elegir juego · OK abrir',
      'Flecha derecha: foco en «1 contra 1» («OK abrir»)');
    await sleep(300);
    await shot(tv, 'menu-tv-principal-falta.png');
    await overflow('Fila principal con la tarjeta «1 contra 1»');

    await press('Enter');
    await sleep(100);
    const s1 = await tv.evaluate(function () {
      var m = window.__tv.menu();
      return { m: m, inSec: document.getElementById('vMenu').classList.contains('inSec'), brand: document.querySelector('.brand').getClientRects().length,
        head: document.getElementById('secTitle').textContent, art: !!document.querySelector('#secArt svg'), back: document.getElementById('secBack').getClientRects().length,
        keys: document.getElementById('menuKeys').textContent, main: getComputedStyle(document.getElementById('cards')).display,
        whys: [].map.call(document.querySelectorAll('#cards-sec-1vs1 .card'), function (c) { return c.classList.contains('off') ? c.querySelector('.why').textContent : ''; }) };
    });
    check(s1.m.row === '1vs1' && s1.m.focus === 'card-prueba-duelo-a' && s1.m.cards.length === N && s1.inSec && !s1.brand && s1.head === '1 contra 1' && s1.art && s1.back && s1.main === 'none',
      'OK abre el submenú: título «1 contra 1» con su dibujo, «Atrás», sus ' + N + ' juegos y el foco en el primero');
    check(s1.keys === '◀ ▶ elegir juego · OK jugar · Atrás volver', 'Ayuda del mando: «' + s1.keys + '»');
    check(s1.whys.every(function (w) { return w === 'Falta 1 jugador'; }), 'Cada duelo dice «Falta 1 jugador»');
    await tv.keyboard.press('Enter');
    const tNeed = await waitFor(function () { return tv.evaluate(function () { var t = document.getElementById('toast'); return t.className.indexOf('on') >= 0 && /falta/.test(t.textContent) && t.textContent; }); }, 2000, 'aviso');
    const pNeed = await waitFor(function () { return ana.evaluate(function () { var t = document.getElementById('toast'); return !t.classList.contains('hidden') && t.textContent; }); }, 2000, 'aviso móvil');
    check(tNeed === '«Duelo Alfa» es para 2 jugadores: falta 1 jugador. Escanead el QR.' && pNeed === tNeed && (await menuOf(tv)).row === '1vs1',
      'OK en un duelo con 1: la tele y el móvil dicen «' + tNeed + '» y la tele sigue en el submenú');
    await shot(tv, 'menu-tv-1vs1-falta.png');

    // ---------------- 2 players ----------------
    console.log('\n[Con 2: el submenú]');
    const berto = await newPhone('Berto');
    await waitFor(function () { return tv.evaluate(function () { return !document.getElementById('card-prueba-duelo-a').classList.contains('off'); }); }, 3000, 'duelos disponibles');
    await sleep(3600); // the toast goes away
    // Arrows: to the last game of the section (one press too many) and the row scrolls
    for (let k = 0; k < N; k++) await press('ArrowRight');
    await sleep(350); // the row slides (0.25 s)
    const last = await tv.evaluate(function (id) {
      var c = document.getElementById('card-' + id), r = c.getBoundingClientRect();
      var h = document.querySelector('#card-prueba-duelo-d h2');
      return { focus: c.classList.contains('focus'), r: r.right, l: r.left, fit: h.scrollWidth <= h.clientWidth + 1, size: parseInt(h.style.fontSize, 10) };
    }, SEC[N - 1]);
    check(last.focus && last.l >= 0 && last.r <= 1920, 'Flechas: el foco llega al último juego (' + SEC[N - 1] + ', no se pasa) y la fila se desplaza para verlo entero');
    check(last.fit && last.size < 56, 'El título largo se encoge para caber (' + last.size + ' px)');
    const descs = await tv.evaluate(function () {
      return [].map.call(document.querySelectorAll('#cards-sec-1vs1 .card p, #cards .card p'), function (p) {
        return { id: p.parentNode.id, px: parseInt(p.style.fontSize, 10), ok: p.scrollHeight <= p.clientHeight + 1 };
      });
    });
    check(descs.every(function (d) { return d.ok && d.px >= 20; }), 'Todas las descripciones caben en sus 3 líneas (' +
      descs.filter(function (d) { return d.px < 25; }).map(function (d) { return d.id.replace('card-', '') + ' ' + d.px + ' px'; }).join(', ') + ')');
    await overflow('Submenú en el último juego');
    // Every card of the sub-menu, one by one with the arrows: none overflows
    for (let k = N - 1; k > 0; k--) {
      await press('ArrowLeft');
      if (k % 2 === 1) await overflow('Submenú en ' + SEC[k - 1]);
    }
    check((await menuOf(tv)).focus === 'card-' + SEC[0], 'Flecha izquierda vuelve hasta el primero');
    // The real duels, with their icons
    for (const p of TVS) await H_.tvFocus(p, 'tanques');
    await sleep(350);
    await shot(tv, 'menu-tv-1vs1.png');
    await shot(tv720, 'menu-tv-1vs1-720p.png');
    await overflow('Submenú «1 contra 1» en los duelos reales');
    for (const p of TVS) await H_.tvFocus(p, 'hockey');
    await sleep(350);
    await shot(tv, 'menu-tv-1vs1-reales-2.png');
    for (const p of TVS) await H_.tvFocus(p, 'prueba-duelo-b');
    check((await menuOf(tv)).focus === 'card-prueba-duelo-b', 'Las flechas vuelven a «Duelo Beta»');
    await overflow('Submenú «1 contra 1»');

    // Back: Escape and the LG key 461
    await press('Escape');
    const b1 = await tv.evaluate(function () { return { m: window.__tv.menu(), inSec: document.getElementById('vMenu').classList.contains('inSec'), brand: document.querySelector('.brand').getClientRects().length }; });
    check(b1.m.row === 'main' && b1.m.focus === 'card-sec-1vs1' && !b1.inSec && b1.brand === 1 && !(await tv.isVisible('#confirm')),
      'Escape vuelve a la fila principal, con el foco en «1 contra 1» (sin preguntar nada)');
    await sleep(350);
    await shot(tv, 'menu-tv-principal.png');
    await shot(tv720, 'menu-tv-principal-720p.png');
    await press('Enter');
    check((await menuOf(tv)).row === '1vs1' && (await menuOf(tv)).focus === 'card-prueba-duelo-b', 'OK otra vez: el submenú recuerda el último duelo enfocado (Duelo Beta)');
    for (const p of TVS) await p.evaluate(LG_BACK);
    check((await menuOf(tv)).row === 'main' && (await menuOf(tv720)).row === 'main', 'La tecla Atrás del mando LG (461) también cierra el submenú');
    await overflow('Vuelta a la fila principal');

    // OK picks a duel
    console.log('\n[Elegir un duelo desde el submenú]');
    await press('Enter');
    await tv.keyboard.press('Enter');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'prueba-duelo-b'; }); }, 3000, 'empieza el duelo');
    const picked = await tv.evaluate(function () { return { s: window.__tv.screen(), toast: document.getElementById('toast').textContent, menu: document.getElementById('vMenu').className.indexOf('on') >= 0 }; });
    check(picked.s === 'prueba-duelo-b' && picked.toast === 'Elegido con el mando: «Duelo Beta»' && !picked.menu, 'OK en «Duelo Beta»: empieza («' + picked.toast + '»)');
    await waitFor(function () { return tv720.evaluate(function () { return window.__tv.screen() === 'prueba-duelo-b'; }); }, 3000, 'la otra tele');
    check(await ana.evaluate(function () { return window.__phone.hub().screen === 'prueba-duelo-b'; }), 'Los móviles también pasan al duelo');
    // Back to the menu (Back, «Sí, al menú»): the TV is in the sub-menu, on that duel
    await tv.keyboard.press('Escape');
    await tv.keyboard.press('ArrowLeft');
    await tv.keyboard.press('Enter');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú');
    const back1 = await menuOf(tv);
    const back720 = await waitFor(function () { return tv720.evaluate(function () { return window.__tv.screen() === 'menu' && window.__tv.menu(); }); }, 3000, 'menú 720');
    check(back1.row === '1vs1' && back1.focus === 'card-prueba-duelo-b' && back720.row === '1vs1' && back720.focus === 'card-prueba-duelo-b',
      'Al volver al menú, las dos teles están en el submenú con el foco en el duelo jugado');

    // ---------------- The phone group ----------------
    console.log('\n[El grupo en el móvil]');
    await waitFor(function () { return berto.evaluate(function () { return window.__phone.hub().screen === 'menu'; }); }, 3000, 'menú móvil');
    const g2 = await berto.evaluate(function () {
      var s = document.getElementById('sec-1vs1');
      return { open: s.classList.contains('open'), aria: s.querySelector('.secHead').getAttribute('aria-expanded'), why: s.querySelector('.secHead .why').textContent,
        games: [].map.call(s.querySelectorAll('.secBody .game'), function (b) { return b.getAttribute('data-game') + (b.disabled ? '(off)' : ''); }),
        loose: [].filter.call(document.querySelectorAll('#gameList > .game'), function (b) { return /prueba-duelo/.test(b.getAttribute('data-game')); }).length,
        pos: [].indexOf.call(document.getElementById('gameList').children, s), title: s.querySelector('.secHead b').textContent, sub: s.querySelector('.secHead span.d').textContent };
    });
    check(g2.open && g2.aria === 'true' && g2.why === '' && g2.games.join() === SEC.join() && g2.loose === 0 && g2.pos === 1 && g2.title === '1 contra 1' && g2.sub === 'Duelos rápidos para dos',
      'Móvil con 2: el grupo «1 contra 1» (segundo de la lista) se abre solo y deja elegir sus ' + N + ' juegos (con los 4 duelos reales)');
    const pc = await berto.evaluate(PHONE_CHECK);
    check(!pc.length, 'El grupo cabe en un iPhone (390 px)' + (pc.length ? ': ' + pc.join(' | ') : ''));
    await waitFor(function () { return berto.evaluate(function () { return document.getElementById('toast').classList.contains('hidden'); }); }, 4000, 'sin aviso');
    await berto.evaluate(function () { document.getElementById('sec-1vs1').scrollIntoView({ block: 'start' }); });
    await sleep(150);
    await shot(berto, 'menu-movil-1vs1.png');
    // The real duels inside the group
    await berto.evaluate(function (id) { document.querySelector('#gameList .game[data-game="' + id + '"]').scrollIntoView({ block: 'start' }); }, SEC[4]);
    await sleep(150);
    await shot(berto, 'menu-movil-1vs1-reales.png');
    await berto.evaluate(function () { document.getElementById('scrMenu').scrollTop = 0; });
    // A tap closes it, another opens it (only on this phone)
    await berto.tap('#sec-1vs1 .secHead');
    const closed = await berto.evaluate(function () { var s = document.getElementById('sec-1vs1'); return !s.classList.contains('open') && s.querySelector('.secBody').getClientRects().length === 0; });
    check(closed && await ana.evaluate(function () { return document.getElementById('sec-1vs1').classList.contains('open'); }), 'Un toque cierra el grupo (solo en ese móvil)');
    await shot(berto, 'menu-movil-1vs1-cerrado.png');
    check((await menuOf(tv)).row === '1vs1', 'La tele no sigue al móvil (sigue en su submenú)');
    await berto.tap('#sec-1vs1 .secHead');
    check(await berto.evaluate(function () { return document.getElementById('sec-1vs1').classList.contains('open'); }), 'Otro toque lo abre');

    // A phone picks a duel while the TV is in the sub-menu (on another one)
    console.log('\n[Un móvil elige mientras la tele está en el submenú]');
    await tv.keyboard.press('ArrowLeft');
    await berto.tap('#gameList .game[data-game="prueba-duelo-c"]');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'prueba-duelo-c'; }); }, 3000, 'duelo C');
    check(await tv.evaluate(function () { return window.__tv.screen() === 'prueba-duelo-c' && document.getElementById('toast').textContent === 'Berto ha elegido «Duelo Gamma»'; }),
      'Berto elige «Duelo Gamma» desde el grupo: empieza en la tele («Berto ha elegido…»)');
    check(await berto.evaluate(function () { return window.__phone.hub().screen === 'prueba-duelo-c'; }), '…y en los móviles');
    // Back to the menu from a phone (the hub's {t:'menu'})
    const fakeTv = H_.makeClient('ws://127.0.0.1:' + PORT + '/ws', 'tele falsa'); fakes.push(fakeTv);
    await fakeTv.ready;
    fakeTv.send({ t: 'hello', role: 'tv' });
    fakeTv.send({ t: 'menu' });
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú');
    const back2 = await menuOf(tv);
    check(back2.row === '1vs1' && back2.focus === 'card-prueba-duelo-c', 'De vuelta: la tele en el submenú, en «Duelo Gamma»');
    // A phone picks a game of the main row (Pong) while the TV is in the sub-menu
    await ana.click('#gameList .game[data-game="pong"]');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'pong'; }); }, 3000, 'pong');
    check(await tv.evaluate(function () { return window.__tv.screen() === 'pong'; }), 'Con la tele en el submenú, Ana elige Pong y empieza como siempre');
    fakeTv.send({ t: 'menu' });
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú');
    const back3 = await tv.evaluate(function () { return { m: window.__tv.menu(), inSec: document.getElementById('vMenu').classList.contains('inSec') }; });
    check(back3.m.row === 'main' && back3.m.focus === 'card-pong' && !back3.inSec, 'Al volver de Pong: fila principal, foco en Pong');
    await overflow('Menú al volver de Pong');

    // ---------------- 3 players: «sois 3» per duel ----------------
    console.log('\n[Con 3]');
    const carla = await H_.phone('ws://127.0.0.1:' + PORT + '/ws', 'Carla', 'c-carla'); fakes.push(carla);
    await waitFor(function () { return tv.evaluate(function () { return document.getElementById('card-sec-1vs1').classList.contains('off'); }); }, 3000, 'sección en gris');
    const three = await tv.evaluate(function () { return document.querySelector('#card-sec-1vs1 .why').textContent; });
    check(three === 'Para 2 jugadores · sois 3', 'Con 3: la tarjeta de la sección dice «' + three + '»');
    check(await H_.tvFocus(tv, 'prueba-duelo-d'), 'tvFocus (helper de pruebas) llega a un duelo dentro de la sección');
    await H_.tvFocus(tv720, 'prueba-duelo-d');
    const whys3 = await tv.evaluate(function () { return [].map.call(document.querySelectorAll('#cards-sec-1vs1 .card'), function (c) { return c.classList.contains('off') && c.querySelector('.why').textContent; }); });
    check(whys3.every(function (w) { return w === 'Para 2 jugadores · sois 3'; }), 'Cada duelo del submenú dice «Para 2 jugadores · sois 3»');
    await overflow('Submenú con 3 (motivos)');
    await shot(tv, 'menu-tv-1vs1-sois3.png');
    await tv.keyboard.press('Enter');
    const tMany = await waitFor(function () { return tv.evaluate(function () { var t = document.getElementById('toast'); return t.className.indexOf('on') >= 0 && /sois 3/.test(t.textContent) && t.textContent; }); }, 2000, 'aviso');
    const pMany = await waitFor(function () { return berto.evaluate(function () { var t = document.getElementById('toast'); return !t.classList.contains('hidden') && /sois 3/.test(t.textContent) && t.textContent; }); }, 2000, 'aviso móvil');
    check(tMany === '«Duelo Delta larguísimo» es para 2 jugadores y sois 3. Elegid otro juego.' && pMany === tMany, 'OK en un duelo con 3: todos ven «' + tMany + '»');
    await overflow('Aviso de «sois 3»');
    const g3 = await ana.evaluate(function () { var s = document.getElementById('sec-1vs1'); return { open: s.classList.contains('open'), why: s.querySelector('.secHead .why').textContent, off: [].every.call(s.querySelectorAll('.game'), function (b) { return b.disabled; }) }; });
    check(!g3.open && g3.why === ' · Para 2 jugadores · sois 3' && g3.off, 'Móvil de Ana con 3: el grupo se cierra solo y dice por qué');
    check(await berto.evaluate(function () { return document.getElementById('sec-1vs1').classList.contains('open'); }), 'En el de Berto (que lo abrió a mano) sigue abierto, con los duelos en gris');
    await carla.close();
    await H_.tvFocus(tv, 'sec-1vs1');

    // ---------------- FPS of the menu on an emulated LG TV ----------------
    console.log('\n[Tele LG webOS emulada]');
    const lg = await (await browser.newContext({
      viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager'
    })).newPage(); watch(lg, 'tele-webos');
    await lg.goto(BASE + '/');
    await waitFor(function () { return lg.evaluate(function () { return window.__tv && document.getElementById('conn').className.indexOf('on') < 0 && window.__tv.hub().players.filter(Boolean).length >= 2; }); }, 4000, 'lg');
    for (const p of TVS) await p.goto('about:blank');
    await sleep(300);
    const keys = (async function () {
      const seq = ['ArrowRight', 'Enter', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'Escape', 'ArrowRight', 'ArrowLeft', 'Enter', 'ArrowRight'];
      for (const k of seq) { await lg.keyboard.press(k); await sleep(200); }
    })();
    const fps = await Promise.all([lg.evaluate(MEASURE_FPS), keys]);
    check(fps[0] >= 50, 'Menú (entrando y saliendo del submenú) a ' + fps[0] + ' FPS en la tele webOS emulada (objetivo ≈60)');
    check((await menuOf(lg)).row === '1vs1', '…y termina en el submenú como se espera');
    await shot(lg, 'menu-tv-1vs1-webos.png');

    check(!errors.length, 'Sin errores de JavaScript' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
  } finally {
    for (const f of fakes) { try { await f.close(); } catch (e) { /* noop */ } }
    await browser.close();
    await srv.close();
    await plain.close();
    H_.rmrf(TMP);
  }
}

main().then(function () { check.done(); }, function (e) {
  check.fail('Excepción: ' + (e && e.stack || e));
  check.done();
});
