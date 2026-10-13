'use strict';
/*
 * Headless Chromium (Playwright, optional): a 4-player «El Infiltrado» with
 * four emulated iPhones, on a 1920x1080 TV, a 1280x720 TV and an emulated LG
 * webOS TV (dpr 2, FPS measured). Checks: no text overflow on the TV, the
 * covered card looks the same on every phone, «Ver» / hold / «Ocultar» /
 * 3 s, the spy's card and «¡Sé el lugar!», the turn on the TV, the grid of
 * places, an accusation vote on the phones, the reveal (flip) and the final
 * ranking. Screenshots go to the folder given as argument.
 *
 *   node test/browser-infiltrado.js [carpeta-de-capturas]
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

const PORT = parseInt(process.env.TEST_PORT, 10) || 3995;
const BASE = 'http://127.0.0.1:' + PORT;
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots-infiltrado'));
const HOME = H_.tmpHome('g2t-browser-inf-');
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

// Same as browser-grupo.js: no visible text cut or outside the stage
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
    if (el.scrollHeight > el.clientHeight + 2 && cs.overflow !== 'visible' && !/-webkit-box/.test(cs.display)) bad.push('recortado en alto ' + label);
    if (r.left < sr.left - 1 || r.right > sr.right + 1 || r.top < sr.top - 1 || r.bottom > sr.bottom + 1) bad.push('fuera de pantalla ' + label);
    if (r.width > 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflow === 'visible' && cs.whiteSpace === 'nowrap') bad.push('desborda ' + label);
    var p = el.parentElement;
    if (p && p !== stage && /\b(pl|pc|inTurn|inClock|inHist)\b/.test(p.className)) {
      var pr = p.getBoundingClientRect();
      if (r.right > pr.right + 2 || r.left < pr.left - 2 || r.bottom > pr.bottom + 2) bad.push('sale de su caja ' + label);
    }
  }
  // Grid names cut to 2 lines: the whole name must fit
  var pls = document.querySelectorAll('#vInfiltrado .pl span');
  for (var j = 0; j < pls.length; j++) if (pls[j].scrollHeight > pls[j].clientHeight + 2) bad.push('nombre de lugar cortado: «' + pls[j].textContent + '»');
  return bad;
};
const MEASURE_FPS = function () {
  return new Promise(function (res) {
    var n = 0, t0 = performance.now();
    function f() { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(Math.round(n * 1000 / (performance.now() - t0))); }
    requestAnimationFrame(f);
  });
};
// FPS while the reveal card flips again and again
const MEASURE_FLIP = function () {
  return new Promise(function (res) {
    var el = document.getElementById('inFlip');
    var n = 0, t0 = performance.now(), last = -1;
    function f() {
      n++;
      var k = Math.floor((performance.now() - t0) / 1000);
      if (k !== last) { last = k; el.classList.toggle('on'); }
      if (performance.now() - t0 < 3000) requestAnimationFrame(f);
      else { el.classList.add('on'); res(Math.round(n * 1000 / (performance.now() - t0))); }
    }
    requestAnimationFrame(f);
  });
};

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('Arrancando servidor en el puerto ' + PORT + ' (capturas en ' + SHOTS + ')');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '30000' });
  const browser = await pw.chromium.launch(LAUNCH);
  const errors = [];
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
    async function measureAlone(page, fn) {
      const others = [tv, tv720, lg].filter(function (p) { return p !== page; });
      const screen = await page.evaluate(function () { return window.__tv.screen(); });
      for (const o of others) await o.goto('about:blank');
      await sleep(300);
      const fps = await page.evaluate(fn || MEASURE_FPS);
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

    console.log('\n[Sala de 4 y menú]');
    const iphone = { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
    const NAMES = ['Ana', 'Berto', 'Carla', 'Dani'];
    const ph = {};
    for (let i = 0; i < 4; i++) {
      const p = await (await browser.newContext(iphone)).newPage(); watch(p, 'móvil-' + NAMES[i]);
      await p.goto(BASE + '/m');
      await p.fill('#name', NAMES[i]);
      await p.click('#joinBtn');
      await waitFor(function () { return p.evaluate(function () { return window.__phone.slot() > 0; }); }, 3000, 'unirse ' + NAMES[i]);
      ph[i + 1] = p;
    }
    await waitFor(function () { return tv.evaluate(function () { return document.querySelectorAll('.pchip.in').length === 4; }); }, 3000, '4 fichas');
    // Menu: a «lugar propio» and the round length
    await ph[2].fill('#ipOwnName', 'La casa del pueblo');
    await ph[2].fill('#ipOwnRoles', 'Abuela, Primo, Vecina');
    await ph[2].click('#ipOwnAdd');
    await waitFor(function () { return ph[2].evaluate(function () { return document.querySelectorAll('#ipOwnList li').length === 1; }); }, 2000, 'lugar propio');
    await ph[3].click('#ipMins button[data-m="8"]');
    const mins = await waitFor(function () { return ph[1].evaluate(function () { var b = document.querySelector('#ipMins button.on'); return b && b.textContent === '8 min' && document.getElementById('ipMinsNote').textContent; }); }, 2000, 'minutos');
    check(!!mins && /lo ha puesto Carla/.test(mins), 'Menú del móvil: Carla elige rondas de 8 min y lo ven los demás («' + mins + '»)');
    const badge = await waitFor(function () { return tv.evaluate(function () { return /1 lugar propio/.test(document.getElementById('chip2').textContent); }); }, 2000, 'insignia');
    check(!!badge, 'La tele muestra «1 lugar propio» junto a Berto (sin decir cuál)');
    await ph[1].evaluate(function () { document.getElementById('menuPanels').scrollIntoView(); });
    await shot(ph[1], 'movil-infiltrado-menu.png');

    console.log('\n[Ronda 1]');
    await ph[1].click('#gameList .game[data-game="infiltrado"]');
    await waitFor(function () { return tv.evaluate(function () { var v = window.__tv.view('infiltrado').state().meta; return v && v.phase === 'intro'; }); }, 5000, 'intro');
    await sleep(400);
    await shot(tv, 'tv-infiltrado-intro.png');
    const meta = await waitFor(function () { return tv.evaluate(function () { var v = window.__tv.view('infiltrado').state().meta; return v && v.phase === 'play' ? v : null; }); }, 9000, 'en juego');
    if (!check(!!meta && meta.players.length === 4 && meta.minutes === 8, 'Empieza con 4 y rondas de 8 min')) throw new Error('no empieza');
    await sleep(300);
    // The covered card: identical on every phone (the secret is not even in the page)
    const covered = [];
    for (let s = 1; s <= 4; s++) covered.push(await ph[s].evaluate(function () { return document.getElementById('ipCard').outerHTML + '|' + document.getElementById('ipPaper').textContent; }));
    check(new Set(covered).size === 1 && covered[0].indexOf('CONFIDENCIAL') > 0 && !/INFILTRADO/.test(covered[0]), 'Carta tapada: idéntica en los 4 móviles, sin el secreto dentro de la página');
    // «Ver»: each phone looks at its card
    const cards = {};
    for (let s = 1; s <= 4; s++) {
      await ph[s].click('#ipSee');
      cards[s] = await ph[s].evaluate(function () {
        var p = document.querySelector('.ipPaperIn');
        return { spy: !!(p && p.classList.contains('spy')), text: p ? p.textContent : '', loc: (document.querySelector('.ipLoc') || {}).textContent || '', role: (document.querySelector('.ipRole') || {}).textContent || '' };
      });
      if (s === 1 || cards[s].spy) {
        if (cards[s].spy) await shot(ph[s], 'movil-infiltrado-carta-espia.png');
      }
    }
    const spy = Number(Object.keys(cards).filter(function (s) { return cards[s].spy; })[0]);
    const inn = [1, 2, 3, 4].filter(function (s) { return s !== spy; });
    const loc = cards[inn[0]].loc;
    check(spy > 0 && inn.every(function (s) { return cards[s].loc === loc && cards[s].role; }) && new Set(inn.map(function (s) { return cards[s].role; })).size === 3,
      '«Ver»: los 3 que no son el infiltrado ven «' + loc + '» y un papel distinto cada uno');
    check(/ERES EL INFILTRADO/.test(cards[spy].text) && /¡Sé el lugar!/.test(cards[spy].text) && cards[spy].text.indexOf(loc) < 0, 'El infiltrado (' + NAMES[spy - 1] + ') ve «ERES EL INFILTRADO» y el botón «¡Sé el lugar!»');
    await shot(ph[inn[0]], 'movil-infiltrado-carta-vista.png');
    await sleep(3300);
    const autoHidden = await ph[inn[0]].evaluate(function () { return !document.querySelector('.ipPaperIn') && !document.getElementById('ipCover').classList.contains('hidden'); });
    check(autoHidden, 'Se vuelve a tapar sola a los 3 s');
    await shot(ph[inn[0]], 'movil-infiltrado-carta-tapada.png');
    // Press and hold: shows while pressed, hides on release
    const cdp = await ph[inn[1]].context().newCDPSession(ph[inn[1]]);
    const box = await ph[inn[1]].evaluate(function () { var r = document.getElementById('ipCard').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [box] });
    await sleep(600);
    const held = await ph[inn[1]].evaluate(function () { return !!document.querySelector('.ipLoc'); });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(100);
    const released = await ph[inn[1]].evaluate(function () { return !document.querySelector('.ipLoc'); });
    check(held && released, 'Mantener pulsado: se ve mientras se pulsa y se tapa al soltar');
    await ph[inn[2]].click('#ipSee');
    await ph[inn[2]].click('#ipHide');
    check(await ph[inn[2]].evaluate(function () { return !document.querySelector('.ipLoc'); }), '«Ocultar» la tapa al momento');

    // Turns: the asker picks on the phone, the TV shows it
    const asker = meta.asker;
    const askerTv = await tv.evaluate(function () { return document.getElementById('inT1').textContent + ' ' + document.getElementById('inT2').textContent; });
    check(askerTv === 'Le toca preguntar a ' + NAMES[asker - 1], 'La tele: «' + askerTv + '»');
    await sleep(200);
    await shot(tv, 'tv-infiltrado-turno.png');
    await shot(tv720, 'tv-infiltrado-turno-720p.png');
    await overflowAll('Turno y lista de lugares');
    const to = [1, 2, 3, 4].filter(function (s) { return s !== asker; })[0];
    await ph[asker].click('#ipTurn button[data-s="' + to + '"]');
    const want = NAMES[asker - 1] + ' pregunta a ' + NAMES[to - 1];
    const asked = await waitFor(function () { return tv.evaluate(function (w) { var t = document.getElementById('inT1').textContent + ' ' + document.getElementById('inT2').textContent; return t === w ? t : null; }, want); }, 2000, 'pregunta');
    check(asked === want, 'Desde el móvil: «' + want + '» en la tele');
    const back = await ph[to].evaluate(function (a) { var b = document.querySelector('#ipTurn button[data-s="' + a + '"]'); return b && b.disabled && /te acaba de preguntar/.test(b.textContent); }, asker);
    check(back, NAMES[to - 1] + ' no puede preguntar a ' + NAMES[asker - 1] + ' («te acaba de preguntar»)');
    const third = [1, 2, 3, 4].filter(function (s) { return s !== asker && s !== to; })[0];
    await ph[to].click('#ipTurn button[data-s="' + third + '"]');
    await waitFor(function () { return tv.evaluate(function () { return document.querySelectorAll('#inHist li:not(.empty)').length === 2; }); }, 2000, 'historial');
    const grid = await tv.evaluate(function () {
      return { n: document.querySelectorAll('#inGrid .pl').length, own: document.querySelectorAll('#inGrid .pl.own').length, txt: document.getElementById('inGrid').textContent };
    });
    check(grid.n === 41 && grid.own === 1 && grid.txt.indexOf('La casa del pueblo') >= 0, 'Rejilla de la tele: los 40 lugares + el propio de Berto');
    await sleep(200);
    await shot(tv, 'tv-infiltrado-lugares.png');
    await shot(tv720, 'tv-infiltrado-lugares-720p.png');
    await overflowAll('Rejilla con historial');
    await waitFor(function () { return lg.evaluate(function () { var v = window.__tv.view('infiltrado').state().meta; return v && v.phase === 'play'; }); }, 3000, 'lg en juego');
    const fpsPlay = await measureAlone(lg);
    check(fpsPlay >= 50, 'Tele webOS emulada (dpr 2) durante la ronda: ' + fpsPlay + ' FPS');
    await shot(lg, 'tv-infiltrado-webos.png');

    // Notes: cross out a place on the list (private)
    await ph[inn[0]].click('#ipPlacesBtn');
    await ph[inn[0]].click('#ipListBody .ipPl >> nth=3');
    const crossed = await ph[inn[0]].evaluate(function () { return document.querySelectorAll('#ipListBody .ipPl.x').length; });
    check(crossed === 1, '«Lugares»: se tacha un lugar al tocarlo (notas privadas)');
    await shot(ph[inn[0]], 'movil-infiltrado-notas.png');
    await ph[inn[0]].click('#ipListBack');

    // Help
    await ph[inn[1]].click('#scr-infiltrado .ipHelpBtn');
    const help = await ph[inn[1]].evaluate(function () { return document.getElementById('ipHelp').classList.contains('hidden') ? 0 : document.querySelectorAll('#ipHelpList li').length; });
    check(help >= 6 && help <= 8, '«?»: cómo se juega, en ' + help + ' líneas');
    await shot(ph[inn[1]], 'movil-infiltrado-ayuda.png');
    await ph[inn[1]].click('#ipHelpOk');

    // Accusation: an innocent accuses another innocent; one says No
    const accuser = inn[0], suspect = inn[1];
    await ph[accuser].click('#ipAccBtn');
    await ph[accuser].click('#ipListBody .ipWho[data-s="' + suspect + '"]');
    await ph[accuser].click('#modalYes');
    const voters = [1, 2, 3, 4].filter(function (s) { return s !== accuser && s !== suspect; });
    const votePanel = await waitFor(function () { return ph[voters[0]].evaluate(function () { return !document.getElementById('ipVote').classList.contains('hidden') && document.getElementById('ipVoteWho').textContent; }); }, 3000, 'votación');
    check(votePanel === NAMES[accuser - 1] + ' acusa a ' + NAMES[suspect - 1], 'Los demás votan Sí/No en el móvil: «' + votePanel + '»');
    await shot(ph[voters[0]], 'movil-infiltrado-votacion.png');
    await sleep(300);
    await shot(tv, 'tv-infiltrado-acusacion.png');
    await overflowAll('Acusación');
    await ph[voters[0]].click('#ipNo');
    await ph[voters[1]].click('#ipYes');
    const banner = await waitFor(function () { return tv.evaluate(function () { var b = document.getElementById('inBanner'); return b.classList.contains('on') && b.textContent; }); }, 3000, 'resultado');
    check(/no prospera: 2 a favor, 1 en contra$/.test(banner || ''), 'La tele: «' + banner + '»');
    const accUsed = await ph[accuser].evaluate(function () { var b = document.getElementById('ipAccBtn'); return b.disabled && b.textContent; });
    check(accUsed === 'Ya has acusado', 'Quien ya acusó no puede volver a acusar en la ronda');

    // The spy: «¡Sé el lugar!» and the list
    await ph[spy].click('#ipSee');
    await ph[spy].click('#ipKnow');
    const list = await waitFor(function () { return ph[spy].evaluate(function () { return !document.getElementById('ipList').classList.contains('hidden') && document.querySelectorAll('#ipListBody .ipPl').length; }); }, 2000, 'lista');
    check(list === 41, 'El infiltrado abre la lista completa (41 lugares, con el propio)');
    await shot(ph[spy], 'movil-infiltrado-lista-espia.png');
    await ph[spy].click('#ipListBody .ipPl:has-text("' + loc + '")');
    await ph[spy].click('#modalYes');
    await waitFor(function () { return tv.evaluate(function () { var v = window.__tv.view('infiltrado').state().meta; return v && v.phase === 'reveal'; }); }, 3000, 'revelación');
    await sleep(1800);
    const rv = await tv.evaluate(function () { return { spy: document.getElementById('inRvSpy').textContent, loc: document.getElementById('inRvLoc').textContent, how: document.getElementById('inRvHow').textContent, roles: document.querySelectorAll('#inRvRoles li').length, flip: document.getElementById('inFlip').classList.contains('on') }; });
    check(rv.spy === NAMES[spy - 1] && rv.loc === loc && rv.roles === 4 && rv.flip && /sabía el lugar/.test(rv.how), 'Revelación en la tele: ' + rv.spy + ', «' + rv.loc + '», los 4 papeles y «' + rv.how + '»');
    await shot(tv, 'tv-infiltrado-revelacion.png');
    await shot(tv720, 'tv-infiltrado-revelacion-720p.png');
    await overflowAll('Revelación');
    await shot(ph[inn[0]], 'movil-infiltrado-revelacion.png');
    const fpsFlip = await measureAlone(lg, MEASURE_FLIP);
    check(fpsFlip >= 50, 'Tele webOS emulada mientras la carta da la vuelta: ' + fpsFlip + ' FPS');

    console.log('\n[Rondas 2 a 4 y final]');
    for (let r = 2; r <= 4; r++) {
      await ph[1].click('#ipNext').catch(function () {});
      const m2 = await waitFor(function () { return tv.evaluate(function (rr) { var v = window.__tv.view('infiltrado').state().meta; return v && v.round === rr && v.phase === 'play' ? v : null; }, r); }, 12000, 'ronda ' + r);
      if (!check(!!m2, 'Ronda ' + r)) break;
      let sp = 0;
      for (let s = 1; s <= 4 && !sp; s++) {
        await ph[s].click('#ipSee');
        if (await ph[s].evaluate(function () { return !!document.querySelector('.ipPaperIn.spy'); })) sp = s;
        else await ph[s].click('#ipHide');
      }
      await ph[sp].click('#ipKnow');
      await ph[sp].click('#ipListBody .ipPl:not([disabled]) >> nth=' + (r * 5));
      await ph[sp].click('#modalYes');
      await waitFor(function () { return tv.evaluate(function (rr) { var v = window.__tv.view('infiltrado').state().meta; return v && v.round === rr && v.phase === 'reveal'; }, r); }, 3000, 'revelación ' + r);
    }
    await ph[2].click('#ipNext');
    const end = await waitFor(function () { return tv.evaluate(function () { return document.getElementById('inEnd').classList.contains('on') && document.querySelectorAll('#inRank li').length; }); }, 5000, 'final');
    check(end === 4, 'Final: clasificación de los 4');
    await sleep(800);
    const fin = await tv.evaluate(function () { return { t: document.getElementById('inEndT').textContent, medals: document.querySelectorAll('#inRank .medal.m1, #inRank .medal.m2, #inRank .medal.m3').length, focus: document.querySelector('#inEnd .btn.focus').textContent }; });
    check(/^¡(Gana|Empate)/.test(fin.t) && fin.medals >= 2 && fin.focus === 'Jugar otra vez', 'Clasificación con medallas («' + fin.t + '») y «Jugar otra vez» / «Menú» con el mando');
    await shot(tv, 'tv-infiltrado-clasificacion.png');
    await shot(tv720, 'tv-infiltrado-clasificacion-720p.png');
    await shot(ph[1], 'movil-infiltrado-final.png');
    await overflowAll('Clasificación');
    check(await ph[1].isVisible('#ipAgain') && await ph[1].isVisible('#ipRank li'), 'Móvil: puesto, clasificación, «Jugar otra vez» y «Menú»');
    const wide = [];
    for (let s = 1; s <= 4; s++) wide.push(await ph[s].evaluate(function () { return document.documentElement.scrollWidth; }));
    check(wide.every(function (w) { return w <= 390; }), 'Los móviles no se salen de lado (390 px)');
    check(!errors.length, 'Sin errores de JavaScript en las páginas' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
  } catch (e) {
    failed++;
    console.log('  FALLO  Excepción: ' + (e && e.stack || e));
  } finally {
    await browser.close().catch(function () {});
    await srv.stop();
    H_.rmrf(HOME);
  }
  console.log('\nResultado (navegador, El Infiltrado): ' + passed + ' OK, ' + failed + ' fallos');
  process.exit(failed ? 1 : 0);
}

main();
