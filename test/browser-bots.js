'use strict';
/*
 * Headless Chromium (Playwright, optional): «Rivales bot».
 * A 1920x1080 TV and one phone (iPhone, portrait). The phone opens «🤖 Añadir
 * rival», picks «Difícil»; the bot shows up on the TV (chip with a robot and
 * «Rival · Difícil») and in the phone's list (🤖 Nombre · Difícil, ×). The
 * cards say which games take bots («🤖 vs bot») and the others are greyed
 * out («Este juego no admite rivales: quita los bots»). Then Tanques against
 * the bot: it drives and shoots and a round ends. Back in the menu, × removes
 * the bot. Screenshots go to the folder given as argument.
 *
 *   node test/browser-bots.js [carpeta-de-capturas]
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

const PORT = parseInt(process.env.TEST_PORT, 10) || 3963;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots-bots'));
const HOME = H_.tmpHome('g2t-browser-bots-');
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

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Arrancando servidor en el puerto ' + PORT + ' (capturas en ' + SHOTS + ')');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '30000', TANQUES_DEBUG_SPEED: '2' });
  const browser = await pw.chromium.launch(LAUNCH);
  const errors = [];
  function watch(page, name) {
    page.on('pageerror', function (e) { errors.push(name + ': ' + e.message); });
    page.on('console', function (m) { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  }
  async function shot(page, name) { await page.screenshot({ path: path.join(SHOTS, name) }); }
  // A fake TV in Node too: the exact 30 Hz state (who moves, who fires)
  const eye = H_.makeClient(WS, 'ojo');
  try {
    await eye.ready;
    eye.send({ t: 'hello', role: 'tv' });
    const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage(); watch(tv, 'tele');
    await tv.goto(BASE + '/');
    const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
    const ana = await (await browser.newContext(iphone)).newPage(); watch(ana, 'móvil');
    await ana.goto(BASE + '/m');
    await ana.fill('#name', 'Ana');
    await ana.click('#joinBtn');
    await waitFor(function () { return ana.evaluate(function () { return window.__phone.slot() === 1; }); }, 3000, 'unirse');

    console.log('\n[Menú del móvil: añadir un rival]');
    const cards = await ana.evaluate(function () {
      function badge(id) { var b = document.querySelector('#gameList .game[data-game="' + id + '"] .bt'); return b ? b.textContent : ''; }
      return { tanques: badge('tanques'), dibuja: badge('dibuja'), btn: document.getElementById('botAddBtn').textContent, vis: !!document.getElementById('botAddBtn').getClientRects().length };
    });
    check(cards.tanques === '🤖 vs bot' && cards.dibuja === '', 'Las tarjetas dicen qué juegos admiten rivales: «' + cards.tanques + '» en Tanques, nada en Dibuja');
    check(cards.vis && cards.btn === '🤖 Añadir rival', 'Botón «' + cards.btn + '» en el menú');
    await ana.click('#botAddBtn');
    await sleep(200);
    const sheet = await ana.evaluate(function () {
      var s = document.getElementById('botSheet');
      var r = s.querySelector('.box').getBoundingClientRect();
      return {
        open: !s.classList.contains('hidden'),
        lvls: [].map.call(s.querySelectorAll('.lvl'), function (b) { var q = b.getBoundingClientRect(); return { l: b.getAttribute('data-level'), t: b.querySelector('b').textContent, d: b.querySelector('span').textContent, h: q.height, w: q.width }; }),
        fits: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth
      };
    });
    check(sheet.open && sheet.lvls.map(function (l) { return l.t; }).join() === 'Fácil,Normal,Difícil,Imposible' && sheet.lvls.every(function (l) { return l.h >= 60 && l.w >= 140 && l.d; }) && sheet.fits,
      'La hoja: cuatro botones grandes con su explicación (' + sheet.lvls.map(function (l) { return l.t + ': ' + l.d; }).join(' · ') + ')');
    await shot(ana, 'bots-movil-hoja.png');
    await ana.click('#botSheet .lvl[data-level="dificil"]');
    const hub = await waitFor(function () { return tv.evaluate(function () { var h = window.__tv.hub(); return h && h.players[1] && h.players[1].bot ? h : null; }); }, 3000, 'bot en la tele');
    const botName = hub && hub.players[1].name;
    check(!!hub && hub.players[1].level === 'dificil' && hub.ready, 'Ana elige «Difícil»: entra ' + botName + ' en el hueco 2 y la sala está lista');
    await sleep(400);

    console.log('\n[La tele y el móvil muestran al rival]');
    const chip = await tv.evaluate(function () {
      var c = document.getElementById('chip2');
      return { bot: c.classList.contains('bot'), svg: !!c.querySelector('.dot svg'), name: c.querySelector('b').textContent, sub: c.querySelector('small').textContent, keys: document.getElementById('menuKeys').textContent };
    });
    check(chip.bot && chip.svg && chip.name === botName && chip.sub === 'Rival · Difícil', 'Tele: la ficha del hueco 2 lleva un robot, «' + chip.name + '» y «' + chip.sub + '»');
    check(/Añade un rival desde el móvil$/.test(chip.keys), 'Tele: el pie del menú lo recuerda («' + chip.keys + '»)');
    const tvCards = await tv.evaluate(function () {
      function why(id) { var c = document.getElementById('card-' + id); return c ? (c.classList.contains('off') ? c.querySelector('.why').textContent : '') : null; }
      return { dibuja: why('dibuja'), sec: why('sec-1vs1') };
    });
    check(tvCards.dibuja === 'Este juego no admite rivales: quita los bots' && tvCards.sec === '', 'Tele: Dibuja en gris («' + tvCards.dibuja + '»); «1 contra 1» se puede jugar');
    await shot(tv, 'bots-tv-menu.png');
    const list = await ana.evaluate(function () {
      var b = document.querySelector('#mRoom span.bot');
      var d = document.querySelector('#gameList .game[data-game="dibuja"]');
      return { txt: b ? b.querySelector('em').textContent : '', x: !!(b && b.querySelector('.rmBot')), dibuja: d.disabled, why: d.querySelector('.why').textContent, status: document.getElementById('mStatus').textContent, open: window.__phone.sectionOpen('1vs1') };
    });
    check(list.txt === '🤖 ' + botName + ' · Difícil' && list.x, 'Móvil: «' + list.txt + '» con su × en la lista de jugadores');
    check(list.dibuja && list.why === ' · Este juego no admite rivales: quita los bots', 'Móvil: Dibuja desactivado («' + list.why.slice(3) + '»)');
    check(list.status === 'Juegas contra ' + botName + '. ¡Elige juego!' && list.open, 'Móvil: «' + list.status + '» y el grupo «1 contra 1» abierto');
    const cut = await ana.evaluate(function () { var e = document.querySelector('#mRoom span.bot em'); return e.scrollWidth > e.clientWidth + 1; });
    check(!cut, 'El nombre y el nivel del rival caben enteros en la lista');
    await sleep(2400);    // the «se une como rival» toast goes away
    await shot(ana, 'bots-movil-lista.png');

    console.log('\n[Tanques contra el bot]');
    const mark = eye.mark();
    await ana.click('#gameList .game[data-game="tanques"]');
    const play = await eye.wait(function (m) { return m.t === 'kmeta' && m.phase === 'play'; }, 6000, 'en juego', mark);
    check(!!play && play.tanks.join() === '1,2', 'Ana elige Tanques: Ana contra ' + botName);
    const s0 = await eye.wait(function (m) { return m.t === 'k.s'; }, 2000, 'estado', eye.msgs.indexOf(play));
    const fired = await eye.wait(function (m) { return m.t === 'k.s' && m.e.some(function (e) { return e[0] === 'f' && e[3] === 2; }); }, 25000, 'disparo', eye.msgs.indexOf(play));
    const s1 = eye.find('k.s');
    const moved = Math.hypot(s1.k[4] - s0.k[4], s1.k[5] - s0.k[5]);
    check(moved > 50 && !!fired, 'El bot se mueve (' + Math.round(moved) + ' u) y dispara');
    const drawn = await tv.evaluate(function () { var s = window.__tv.view('tanques').state(); return { tanks: s.drawn.tanks.length, frames: s.drawn.frames, name: document.getElementById('kName2') ? document.getElementById('kName2').textContent : '' }; });
    check(drawn.tanks === 2 && drawn.frames > 30, 'La tele dibuja los dos tanques');
    await shot(tv, 'bots-tv-tanques.png');
    const over = await eye.wait(function (m) { return m.t === 'kmeta' && m.phase === 'over' && m.last; }, 40000, 'ronda', eye.msgs.indexOf(play));
    check(!!over, 'Se juega una ronda entera: ' + (over && (over.last.winner === 2 ? 'gana ' + botName : (over.last.winner === 1 ? 'gana Ana' : 'empate'))));
    await sleep(500);
    await shot(tv, 'bots-tv-ronda.png');
    const st = await ana.evaluate(function () { return document.getElementById('kpStatus').textContent; });
    check(/Punto para|Empate|propia bala|Le has dado|Te han dado/.test(st) || st.length > 0, 'El móvil de Ana lo cuenta («' + st + '»)');

    console.log('\n[De vuelta al menú: quitar el rival]');
    await ana.click('#scr-tanques .bar .menuBtn');
    await ana.click('#modalYes');
    await waitFor(function () { return tv.evaluate(function () { return window.__tv.screen() === 'menu'; }); }, 3000, 'menú');
    const still = await tv.evaluate(function () { var h = window.__tv.hub(); return h.players[1] && h.players[1].bot; });
    check(still, 'El rival sigue en la sala para la siguiente partida');
    await waitFor(function () { return ana.evaluate(function () { return !!document.querySelector('#mRoom .rmBot'); }); }, 2000, 'lista');
    await ana.click('#mRoom .rmBot');
    const gone = await waitFor(function () { return tv.evaluate(function () { var h = window.__tv.hub(); return !h.players[1] && document.getElementById('chip2').className.indexOf('bot') < 0; }); }, 3000, 'sin bot');
    await waitFor(function () { return ana.evaluate(function () { return !document.querySelector('#mRoom span.bot'); }); }, 3000, 'lista sin bot');
    const after = await ana.evaluate(function () { return { bots: document.querySelectorAll('#mRoom span.bot').length, dibuja: document.querySelector('#gameList .game[data-game="dibuja"] .why').textContent }; });
    check(!!gone && after.bots === 0 && after.dibuja === ' · Falta 1 jugador', '×: el rival se va (la tele vuelve a «Hueco libre» y Dibuja vuelve a pedir otro jugador)' + (gone && after.bots === 0 ? '' : ': ' + JSON.stringify(after) + ' ' + gone));
    check(!errors.length, 'Sin errores de JavaScript en las páginas' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
  } catch (e) {
    failed++;
    console.log('  FALLO  Excepción: ' + (e && e.stack || e));
  } finally {
    try { eye.ws.terminate(); } catch (e) { /* noop */ }
    await browser.close().catch(function () {});
    await srv.stop();
    H_.rmrf(HOME);
  }
  console.log('\nResultado (navegador, rivales bot): ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

main();
