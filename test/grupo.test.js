'use strict';
/*
 * Groups (up to 6 players) through the real server with fake phones: the
 * 6-slot room (the default), messages when a game does not fit, slot
 * compaction, «Reflejos» with 6 and «Pong» doubles with 3 and 4.
 * «Dibuja y adivina» for groups has its own file (dibuja-grupo.test.js).
 *
 *   node test/grupo.test.js
 */
const H_ = require('./helpers');
const check = H_.checker('Grupos de hasta 6 jugadores');

const PORT = parseInt(process.env.TEST_PORT, 10) || 3993;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';
const NAMES = ['Ana', 'Berto', 'Carla', 'Dani', 'Eva', 'Fran'];
const COLORS = require('../src/server/hub').COLORS;

async function joinAll(names, prefix) {
  const out = [];
  for (let i = 0; i < names.length; i++) out.push(await H_.phone(WS, names[i], (prefix || 'c-') + names[i]));
  return out;
}
function evOf(c, k, from) { return c.wait(function (m) { return m.t === 'ev' && m.k === k; }, 1500, 'ev ' + k, from); }

async function lobbyAndReflejos(tv, clients) {
  console.log('\n[Sala de 6 (por defecto)]');
  check(tv.find('info').slots === 6 && tv.hub.players.length === 6 && tv.hub.slots === 6, 'Sin --jugadores la sala tiene 6 huecos');
  const ps = await joinAll(NAMES);
  ps.forEach(function (p) { clients.push(p); });
  const joined = ps.map(function (p) { return p.find('joined'); });
  check(joined.every(function (j, i) { return j && j.slot === i + 1 && j.color === COLORS[i]; }), 'Los 6 entran en los huecos 1 a 6, cada uno con su color');
  check(new Set(joined.map(function (j) { return j.color; })).size === 6, 'Los 6 colores son distintos (' + joined.map(function (j) { return j.color; }).join(' ') + ')');
  const extra = await H_.phone(WS, 'Gus', 'c-gus'); clients.push(extra);
  check(!!extra.find('full') && extra.find('full').slots === 6 && !extra.find('joined'), 'Un séptimo móvil recibe «lleno» (6 huecos)');
  await extra.close();
  await H_.waitUntil(function () { return tv.hub.ready && tv.hub.players.every(function (p) { return p && p.connected; }); }, 2000, 'ready 6');
  check(tv.hub.ready && tv.hub.players.map(function (p) { return p.name; }).join() === NAMES.join(), 'La tele ve a los 6 listos, con nombre y color');

  console.log('\n[Juego que no encaja]');
  let tm = tv.mark();
  const marks = ps.map(function (p) { return p.mark(); });
  ps[2].send({ t: 'pick', game: 'pong' });
  const tvEv = await evOf(tv, 'toomany', tm);
  check(!!tvEv && tvEv.text === '«Pong» es de 2 a 4 jugadores y sois 6. Elegid otro juego.' && tvEv.by === 3 && tvEv.name === 'Carla',
    'Pong con 6: la tele recibe «' + (tvEv && tvEv.text) + '»');
  const all = await Promise.all(ps.map(function (p, i) { return evOf(p, 'toomany', marks[i]); }));
  check(all.every(function (e) { return e && e.text === tvEv.text && e.min === 2 && e.max === 4 && e.n === 6; }), 'Y los 6 móviles también (no solo quien lo eligió)');
  check(tv.hub.screen === 'menu', 'Se sigue en el menú');

  console.log('\n[Reflejos con 6]');
  tm = tv.mark();
  ps[5].send({ t: 'pick', game: 'ejemplo-reflejos' });
  const hubR = await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'ejemplo-reflejos'; }, 2000, 'reflejos', tm);
  check(!!hubR && hubR.pick.name === 'Fran', 'Fran elige «Reflejos» con 6 jugadores');
  const first = await tv.wait(function (m) { return m.t === 'rmeta'; }, 2000, 'rmeta', tm);
  check(first && first.players.join() === '1,2,3,4,5,6' && first.scores.length === 6, 'rmeta con los 6 jugadores');
  // Ana se adelanta en la primera ronda; luego cada ronda la gana uno distinto y Eva gana 3
  ps[0].send({ t: 'r.tap' });
  const early = await tv.wait(function (m) { return m.t === 'r.early' && m.slot === 1; }, 1000, 'early');
  check(!!early, 'Ana se adelanta: fuera esta ronda');
  const winners = [4, 1, 4, 2, 4]; // Eva, Berto, Eva, Carla, Eva (índices)
  let lastRound = 0;
  let ok = 0;
  for (let r = 0; r < winners.length; r++) {
    const go = await tv.wait(function (m) { return m.t === 'rmeta' && m.phase === 'go' && m.round > lastRound; }, 8000, 'go ' + r);
    if (!go) break;
    lastRound = go.round;
    ps[winners[r]].send({ t: 'r.tap' });
    if (r === 0) ps[0].send({ t: 'r.tap' }); // la que se adelantó no puntúa
    const pt = await tv.wait(function (m) { return m.t === 'rmeta' && m.round === go.round && (m.phase === 'point' || m.phase === 'end') && m.last; }, 2000, 'punto ' + r);
    if (pt && pt.last.slot === winners[r] + 1) ok++;
  }
  check(ok === winners.length, 'Cada ronda la gana quien toca primero (' + ok + '/' + winners.length + ')');
  const end = await tv.wait(function (m) { return m.t === 'rmeta' && m.phase === 'end'; }, 2000, 'fin');
  check(!!end && end.winner === 5 && end.scores.join() === '0,1,1,0,3,0', 'Gana Eva 3 a 1 a 1 (' + (end && end.scores.join()) + ')');
  const allEnd = await Promise.all(ps.map(function (p) { return p.wait(function (m) { return m.t === 'rmeta' && m.phase === 'end'; }, 2000, 'fin móvil'); }));
  check(allEnd.every(Boolean), 'Los 6 móviles reciben el final');

  // Alguien se va del todo durante la partida: Reflejos sigue sin él
  ps[0].send({ t: 'r.again' });
  await tv.wait(function (m) { return m.t === 'rmeta' && m.phase === 'ready' && m.round === 1; }, 2000, 'otra');
  tm = tv.mark();
  ps[3].send({ t: 'leave' });
  const leftEv = await evOf(tv, 'left', tm);
  check(!!leftEv && leftEv.name === 'Dani' && tv.hub.screen === 'ejemplo-reflejos', 'Dani se va: la tele avisa y Reflejos sigue');
  const m5 = await tv.wait(function (m) { return m.t === 'rmeta' && m.players.join() === '1,2,3,5,6'; }, 2000, 'sin Dani', tm);
  check(!!m5 && !m5.paused, 'Reflejos sigue con 5 (sin pausa)');
  tv.send({ t: 'menu' });
  await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'menú');
  return ps;
}

async function compaction(tv, ps) {
  console.log('\n[Huecos con hueco libre en medio]');
  // Quedan Ana(1) Berto(2) Carla(3) Eva(5) Fran(6): Pong es de 2 a 4 -> sobran
  let tm = tv.mark();
  ps[0].send({ t: 'pick', game: 'pong' });
  const tooMany = await evOf(tv, 'toomany', tm);
  check(!!tooMany && tooMany.n === 5 && /sois 5/.test(tooMany.text), 'Pong con 5: «' + (tooMany && tooMany.text) + '»');
  ps[1].send({ t: 'leave' });
  await tv.wait(function (m) { return m.t === 'hub' && m.players[1] === null; }, 2000, 'berto sale');
  // Ana(1) Carla(3) Eva(5) Fran(6): Pong con 4 -> Eva y Fran pasan a los huecos 2 y 4
  const marks = [ps[2].mark(), ps[4].mark(), ps[5].mark()];
  tm = tv.mark();
  ps[2].send({ t: 'pick', game: 'pong' });
  const pongHub = await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'pong'; }, 2000, 'pong', tm);
  check(!!pongHub && pongHub.pick.name === 'Carla' && pongHub.pick.by === 2, 'La tele sabe que lo eligió Carla (ya en su hueco nuevo, el 2)');
  const moved = await Promise.all([ps[2], ps[4], ps[5]].map(function (p, k) { return p.wait(function (m) { return m.t === 'joined'; }, 1000, 'joined', marks[k]); }));
  check(!!pongHub && pongHub.players.slice(0, 4).map(function (p) { return p && p.name; }).join() === 'Ana,Carla,Eva,Fran' && !pongHub.players[4] && !pongHub.players[5],
    'Para el Pong (máx. 4) los huecos se compactan: Ana, Carla, Eva, Fran en 1-4');
  check(moved[0] && moved[0].slot === 2 && moved[1] && moved[1].slot === 3 && moved[2] && moved[2].slot === 4 && moved[1].reconnect === true,
    'Carla, Eva y Fran reciben su nuevo hueco (y su color nuevo)');
  tv.send({ t: 'menu' });
  await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'menú');
}

// Bots: every paddle of side `win` follows the ball; the others run away from it
function pongBots(tv, bySlot, pads, win) {
  const H = 1080;
  return setInterval(function () {
    const s = tv.state;
    if (!s) return;
    pads.forEach(function (p, k) {
      const ph = bySlot[p.slot];
      if (!ph) return;
      const by = s.b[1] + s.b[3] * 0.03;
      let y;
      if (p.side === win) y = Math.max(0, Math.min(1, (by - p.h / 2) / (H - p.h)));
      else y = s.b[1] < H / 2 ? 1 : 0;
      try { ph.send({ t: 'm', y: y }); } catch (e) { /* noop */ }
      void k;
    });
  }, 16);
}

async function pongMatch(tv, bySlot, n, win) {
  const tm = tv.mark();
  bySlot[1].send({ t: 'pick', game: 'pong' });
  await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'pong'; }, 2000, 'pong ' + n, tm);
  const meta = await tv.wait(function (m) { return m.t === 'pmeta' && m.paddles; }, 2000, 'pmeta', tm);
  if (!check(!!meta && meta.paddles.length === n && meta.mode === 'dobles', 'Pong con ' + n + ': dobles con ' + n + ' palas')) return;
  const pads = meta.paddles;
  if (n === 4) {
    check(pads.map(function (p) { return p.slot + ':' + p.side + ':' + p.role; }).join(' ') === '1:1:portería 2:2:portería 3:1:delantera 4:2:delantera' &&
      meta.teams[0].join() === '1,3' && meta.teams[1].join() === '2,4', 'Equipos 1+3 (izquierda) contra 2+4 (derecha); portería y delantera');
    check(pads[2].x === 540 && pads[3].x === 1380 && pads[0].h === 150, 'Palas delanteras a 540 px de su portería');
  } else {
    check(pads.length === 3 && pads[1].slot === 2 && pads[1].role === 'solo' && pads[1].h > pads[0].h, 'Con 3: el jugador 2 solo a la derecha con la pala más larga');
  }
  // Propiedad: cada móvil mueve su pala (y solo la suya)
  await tv.wait(function (m) { return m.t === 'pmeta' && m.phase === 'playing'; }, 4000, 'playing', tm);
  let owned = 0;
  for (let k = 0; k < pads.length; k++) {
    const p = pads[k];
    const mk = tv.mark();
    const other = pads.map(function (q, j) { return j; }).filter(function (j) { return j !== k; });
    const before = other.map(function (j) { return tv.state.p[j]; });
    bySlot[p.slot].send({ t: 'm', y: k % 2 ? 0 : 1 });
    const pm = await tv.wait(function (m) { return m.t === 'p' && m.i === k; }, 800, 'p ' + k, mk);
    await H_.sleep(120);
    const target = k % 2 ? p.h / 2 : 1080 - p.h / 2;
    const after = other.map(function (j) { return tv.state.p[j]; });
    if (pm && Math.abs(tv.state.p[k] - target) < 1 && after.every(function (v, j) { return Math.abs(v - before[j]) < 1; })) owned++;
  }
  check(owned === pads.length, 'Cada móvil mueve solo su pala (' + owned + '/' + pads.length + ')');
  const tm2 = tv.mark();
  const bot = pongBots(tv, bySlot, pads, win);
  const over = await tv.wait(function (m) { return m.t === 'pmeta' && m.phase === 'gameover'; }, 90000, 'gameover ' + n, tm2);
  clearInterval(bot);
  const hits = tv.since(tm2, 'ev').filter(function (e) { return e.k === 'hit'; });
  const fwdHits = hits.filter(function (e) { return pads[e.paddle] && pads[e.paddle].role === 'delantera'; });
  check(!!over && over.winner === win && over.score[win - 1] === 3 && over.score[2 - win] === 0,
    'Gana el equipo ' + (win === 1 ? 'de la izquierda' : 'de la derecha') + ' ' + (over && over.score.join('-')) + ' (puntos de equipo)');
  // (the losers never touch the ball, so there may be no hits at all: the serve goes to them)
  check(hits.every(function (e) { return pads[e.paddle] && pads[e.paddle].side === e.side && pads[e.paddle].slot === e.slot; }),
    'Cada golpe dice qué pala y qué jugador (' + hits.length + ' golpes, ' + fwdHits.length + ' de delanteras)');
  const phoneOver = await bySlot[pads[0].slot].wait(function (m) { return m.t === 'pmeta' && m.phase === 'gameover'; }, 2000, 'fin móvil');
  check(!!phoneOver && phoneOver.teams[0].length >= 1, 'Los móviles reciben el final con los equipos');
  tv.send({ t: 'menu' });
  await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'menú');
}

(async function () {
  const HOME = H_.tmpHome('g2t-grupo-');
  const srv = await H_.startServer({
    GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '3000',
    REFLEJOS_DEBUG_SPEED: '10', PONG_DEBUG_SPEED: '3', POINTS_TO_WIN: '3', DIBUJA_DEBUG_SPEED: '20'
  });
  const clients = [];
  try {
    const tv = H_.makeClient(WS, 'tele'); clients.push(tv);
    await tv.ready;
    tv.send({ t: 'hello', role: 'tv' });
    await H_.waitUntil(function () { return tv.hub && tv.find('info'); }, 2000, 'hub');
    const ps = await lobbyAndReflejos(tv, clients);
    await compaction(tv, ps);
    // Tras compactar: Ana 1, Carla 2, Eva 3, Fran 4
    console.log('\n[Pong con 4: dobles]');
    await pongMatch(tv, { 1: ps[0], 2: ps[2], 3: ps[4], 4: ps[5] }, 4, 1);
    console.log('\n[Pong con 3]');
    ps[5].send({ t: 'leave' });
    await tv.wait(function (m) { return m.t === 'hub' && m.players[3] === null; }, 2000, 'fran sale');
    await pongMatch(tv, { 1: ps[0], 2: ps[2], 3: ps[4] }, 3, 2);
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    clients.forEach(function (c) { try { c.ws.terminate(); } catch (e) { /* noop */ } });
    await srv.stop();
    H_.rmrf(HOME);
    if (check.counts().failed) console.log('\n--- Registro del servidor ---\n' + srv.out.split('\n').slice(-40).join('\n'));
  }
  check.done();
})();
