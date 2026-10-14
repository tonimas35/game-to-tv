'use strict';
/*
 * «Motos de neón»: the grid logic (movement, turn queue, U-turns, every kind
 * of crash, draws), the game with a fake hub API (countdown, speed, rounds,
 * scoring to 5, pause and reconnection, a player leaving), the compact
 * protocol decoded by the REAL TV code (src/games/motos/tv.js run in a
 * sandbox: a TV that connects mid-round rebuilds the same trail grid), and
 * the real server with fake phones and fake TVs.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H_ = require('./helpers');
const L = require('../src/games/motos/logic');
const Game = require('../src/games/motos');
const check = H_.checker('Motos de neón');

const DT = 1 / 60;
const TV_SRC = fs.readFileSync(path.join(H_.ROOT, 'src', 'games', 'motos', 'tv.js'), 'utf8');

function cell(x, y) { return y * L.W + x; }
function xy(c) { return [c % L.W, Math.floor(c / L.W)]; }
function gridString(rd) { return Array.prototype.join.call(rd.grid, ''); }

// The TV's trail model, from the real tv.js (each call: a separate «TV»)
function tvModel() {
  let registered = null;
  const G2T = {
    now: function () { return Date.now(); },
    clamp: function (v, a, b) { return v < a ? a : (v > b ? b : v); },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    hexA: function () { return 'rgba(0,0,0,0)'; },
    sound: { beep: function () {} },
    tv: { register: function (v) { registered = v; } }
  };
  const sandbox = { window: { G2T: G2T }, document: {} };
  vm.createContext(sandbox);
  vm.runInContext(TV_SRC, sandbox, { filename: 'tv.js' });
  const m = G2T.motosTrailModel();
  m.view = registered;
  // Feeds one message as the TV page would; returns false if a full state was needed
  m.feed = function (msg) {
    if (msg.t === 'msnap') { m.snap(msg); return true; }
    if (msg.t === 'mt') return m.tick(msg);
    return true;
  };
  return m;
}

// ---------------------------------------------------------------- logic
function logic() {
  console.log('\n[Lógica: salida, movimiento y giros]');
  const l0 = L.startLayout(0), l1 = L.startLayout(1);
  check(l0[0].x === 12 && l0[0].y === 17 && l0[0].dir === 1 && l0[1].x === 51 && l0[1].y === 18 && l0[1].dir === 3,
    'Salida 0: frente a frente, simétrica girando la pista 180° ((12,17)→ y (51,18)←)');
  check(l1[0].x === 16 && l1[1].x === 47 && l1[0].y === 30 && l1[1].y === 30 && l1[0].dir === 0 && l1[1].dir === 0,
    'Salida 1: las dos hacia arriba desde lados opuestos ((16,30) y (47,30), en espejo)');

  let rd = L.newRound(0);
  check(rd.grid[cell(12, 17)] === 1 && rd.grid[cell(51, 18)] === 2 && rd.grid.length === 64 * 36, 'Rejilla de 64x36; cada moto ocupa su casilla de salida');
  let r = L.step(rd);
  check(r.heads[0] === cell(13, 17) && r.heads[1] === cell(50, 18) && rd.grid[cell(13, 17)] === 1 && rd.grid[cell(50, 18)] === 2 && !r.crashed.length,
    'Un paso: cada moto avanza exactamente una casilla y deja estela');

  // Queue: up then left between two steps -> two turns
  rd = L.newRound(0);
  const b = rd.bikes[0];
  check(L.queueTurn(b, 'up') && L.queueTurn(b, 'left'), 'Dos giros rápidos («arriba y luego izquierda») entran en la cola');
  check(!L.queueTurn(b, 'down') && b.queue.length === 2, 'La cola guarda como mucho 2 giros (el tercero se ignora)');
  L.step(rd);
  check(b.x === 12 && b.y === 16 && b.dir === 0, 'Paso 1: usa el primero (arriba)');
  L.step(rd);
  check(b.x === 11 && b.y === 16 && b.dir === 3 && b.alive, 'Paso 2: usa el segundo (izquierda) sin chocar con su estela');
  L.step(rd);
  check(b.x === 10 && b.y === 16 && b.dir === 3, 'Sin giros en la cola, sigue recto');
  const snap = L.snapshot(rd);
  check(snap.tr[0].join() === [cell(12, 17), cell(12, 16), cell(10, 16)].join() && snap.dr[0] === 3,
    'La estela compacta: solo las esquinas y la cabeza (' + snap.tr[0].length + ' puntos)');
  check(L.expandPath(snap.tr[0], L.W).join() === [cell(12, 17), cell(12, 16), cell(11, 16), cell(10, 16)].join(), 'De las esquinas se recupera cada casilla, en orden');

  console.log('\n[Lógica: la media vuelta se ignora]');
  rd = L.newRound(0);
  const c = rd.bikes[0];
  check(!L.queueTurn(c, 'left') && !L.queueTurn(c, 'right') && c.queue.length === 0, 'Hacia la derecha: «izquierda» (media vuelta) y «derecha» (la misma) se ignoran');
  check(L.queueTurn(c, 'up') && !L.queueTurn(c, 'down') && !L.queueTurn(c, 'up') && c.queue.join() === '0',
    'En cola «arriba»: después «abajo» sería media vuelta y se ignora');
  check(!L.queueTurn(c, 'diagonal') && !L.queueTurn(c, 7) && c.queue.length === 1, 'Direcciones raras se ignoran');
  rd.bikes[1].alive = false;
  check(!L.queueTurn(rd.bikes[1], 'up'), 'Una moto que ha chocado no gira');

  console.log('\n[Lógica: choques]');
  // Wall
  rd = L.newRound(0, 64, 36, [{ x: 63, y: 5, dir: 'right' }, { x: 0, y: 30, dir: 'right' }]);
  r = L.step(rd);
  check(r.crashed.length === 1 && r.crashed[0].side === 1 && r.crashed[0].cause === 'muro' && r.heads[0] === -1 && L.result(rd) === 2,
    'Contra el muro: choca, no se mueve y gana la otra');
  // Own trail
  rd = L.newRound(0);
  const own = rd.bikes[0];
  L.queueTurn(own, 'up'); L.step(rd);
  L.queueTurn(own, 'left'); L.step(rd);
  L.queueTurn(own, 'down'); L.step(rd);
  L.queueTurn(own, 'right');
  r = L.step(rd);
  check(r.crashed.length === 1 && r.crashed[0].cause === 'propia' && r.crashed[0].cell === cell(12, 17) && L.result(rd) === 2,
    'Contra su propia estela (arriba, izquierda, abajo, derecha: vuelve a la salida)');
  // The other trail
  rd = L.newRound(0, 64, 36, [{ x: 5, y: 5, dir: 'right' }, { x: 8, y: 3, dir: 'down' }]);
  L.step(rd); L.step(rd);
  r = L.step(rd);
  check(r.crashed.length === 1 && r.crashed[0].side === 1 && r.crashed[0].cause === 'rival' && rd.bikes[1].alive && L.result(rd) === 2,
    'Contra la estela de la otra moto');
  // The other bike's head (it moves away in the same step)
  rd = L.newRound(0, 64, 36, [{ x: 5, y: 5, dir: 'right' }, { x: 7, y: 4, dir: 'down' }]);
  L.step(rd);
  r = L.step(rd);
  check(r.crashed.length === 1 && r.crashed[0].side === 1 && r.crashed[0].cell === cell(7, 5) && rd.bikes[1].alive,
    'Contra la casilla de la otra moto (su cabeza): choca quien llega');
  // Head-on: same cell
  rd = L.newRound(0, 64, 36, [{ x: 5, y: 5, dir: 'right' }, { x: 7, y: 5, dir: 'left' }]);
  r = L.step(rd);
  check(r.crashed.length === 2 && r.crashed.every(function (x) { return x.cause === 'frontal' && x.cell === cell(6, 5); }) && L.result(rd) === 0 && rd.grid[cell(6, 5)] === 0,
    'De frente a la misma casilla: chocan las dos (empate) y nadie la ocupa');
  // Head-on: swapping cells
  rd = L.newRound(0, 64, 36, [{ x: 5, y: 5, dir: 'right' }, { x: 6, y: 5, dir: 'left' }]);
  r = L.step(rd);
  check(r.crashed.length === 2 && r.crashed.every(function (x) { return x.cause === 'frontal'; }) && L.result(rd) === 0, 'De frente, cara a cara (se cruzarían): empate');
  // Side-on into the same cell
  rd = L.newRound(0, 64, 36, [{ x: 5, y: 5, dir: 'right' }, { x: 6, y: 4, dir: 'down' }]);
  r = L.step(rd);
  check(r.crashed.length === 2 && L.result(rd) === 0, 'Las dos a la misma casilla desde lados distintos: empate');
  // Same step, different crashes: straight from layout 0, both reach the walls together
  rd = L.newRound(0);
  let steps = 0;
  while (L.result(rd) === null && steps < 200) { r = L.step(rd); steps++; }
  check(steps === 52 && r.crashed.length === 2 && r.crashed.every(function (x) { return x.cause === 'muro'; }) && L.result(rd) === 0,
    'Recto desde la salida 0: las dos llegan al muro en el mismo paso (' + steps + '): empate');
  // A crashed bike stays still; order does not matter
  rd = L.newRound(0, 64, 36, [{ x: 63, y: 5, dir: 'right' }, { x: 10, y: 10, dir: 'right' }]);
  L.step(rd);
  r = L.step(rd);
  check(r.heads[0] === -1 && r.heads[1] === cell(12, 10) && !rd.bikes[0].alive, 'Una moto que ha chocado no se mueve más');
  const swapA = L.newRound(0, 64, 36, [{ x: 5, y: 5, dir: 'right' }, { x: 8, y: 3, dir: 'down' }]);
  const swapB = L.newRound(0, 64, 36, [{ x: 8, y: 3, dir: 'down' }, { x: 5, y: 5, dir: 'right' }]);
  for (let i = 0; i < 3; i++) { L.step(swapA); L.step(swapB); }
  check(!swapA.bikes[0].alive && swapA.bikes[1].alive && swapB.bikes[0].alive && !swapB.bikes[1].alive, 'El orden de las motos no cambia el resultado');
}

// ---------------------------------------------------------------- the game with a fake API
function fakeApi(players, names) {
  const sent = [], tv = [], phones = [];
  const conn = {};
  players.forEach(function (i) { conn[i] = true; });
  const api = {
    slots: 6,
    sent: sent, tv: tv, phones: phones, conn: conn,
    tvs: new Set([1]),
    players: function () { return players.slice(); },
    setPlayers: function (p) { players = p; },
    isConnected: function (i) { return !!conn[i]; },
    allConnected: function () { return players.every(function (i) { return conn[i]; }); },
    name: function (i) { return (names && names[i]) || ('J' + (i + 1)); },
    broadcast: function (m) { const o = typeof m === 'string' ? JSON.parse(m) : m; sent.push(o); tv.push(o); },
    sendTvs: function (m) { tv.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendSlot: function (i, m) { phones.push(Object.assign({ _to: i }, typeof m === 'string' ? JSON.parse(m) : m)); },
    sendWs: function (ws, m) { ws.push(typeof m === 'string' ? JSON.parse(m) : m); },
    log: function () {}
  };
  return api;
}
function metaOf(api) { for (let i = api.sent.length - 1; i >= 0; i--) if (api.sent[i].t === 'mmeta') return api.sent[i]; return null; }
function evs(api, k, from) { return api.sent.slice(from || 0).filter(function (m) { return m.t === 'ev' && m.k === k; }); }
function run(g, secs, until) {
  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i++) { g.tick(DT); g.flush(); if (until && until()) return true; }
  return false;
}
// Ticks until the phase is `ph` (at most `secs`)
function runTo(g, ph, secs) { return run(g, secs || 30, function () { return g._state.phase === ph; }); }
// A turn that sends this side into the nearest wall (layout 0 / 1)
function suicideTurn(g, side) {
  const layout = (g._state.round - 1) % 2;
  if (layout === 0) return side === 1 ? 'up' : 'down';
  return side === 1 ? 'left' : 'right';
}

function unitGame() {
  console.log('\n[Juego: cuenta atrás, velocidad y giros]');
  check(Game.cellsPerSecond(0) === 12 && Game.cellsPerSecond(10) === 12 && Game.cellsPerSecond(25) === 14 && Game.cellsPerSecond(40) === 16 && Game.cellsPerSecond(300) === 16,
    'Velocidad: 12 casillas/s, sube poco a poco desde los 10 s hasta 16 a los 40 s');
  const api = fakeApi([0, 1], { 0: 'Ana', 1: 'Berto' });
  const g = Game.create(api);
  const S = g._state;
  g.start();
  let m = metaOf(api);
  check(m && m.phase === 'countdown' && m.countdown === 3 && m.players.join() === '1,2' && m.score.join() === '0,0' && m.round === 1 && m.toWin === 5,
    'Empieza con cuenta atrás 3-2-1, ronda 1, 0-0, a 5');
  const snap0 = api.tv.filter(function (x) { return x.t === 'msnap'; })[0];
  check(snap0 && snap0.r === 1 && snap0.k === 0 && snap0.tr[0].join() === String(cell(12, 17)) && snap0.tr[1].join() === String(cell(51, 18)) && snap0.dr.join() === '1,3',
    'La tele recibe el estado completo de la ronda (msnap)');
  check(evs(api, 'start').length === 1, 'Aviso «start»');
  g.onMessage(0, { t: 'm.turn', dir: 'up' });
  check(S.rd.bikes[0].queue.join() === '0', 'Durante la cuenta atrás ya se puede dejar un giro en la cola');
  S.rd.bikes[0].queue = [];
  run(g, 1.5);
  check(metaOf(api).countdown === 2 || metaOf(api).countdown === 1, 'La cuenta atrás baja (' + metaOf(api).countdown + ')');
  check(S.k === 0, 'Nadie se mueve durante la cuenta atrás');
  const mark = api.sent.length;
  runTo(g, 'playing', 3);
  check(S.phase === 'playing' && evs(api, 'go', mark).length === 1, 'Tras 3 s: «go» y a correr');
  const tvMark = api.tv.length;
  run(g, 1);
  check(S.k >= 11 && S.k <= 13, 'En 1 s avanzan unas 12 casillas (' + S.k + ')');
  const mts = api.tv.slice(tvMark).filter(function (x) { return x.t === 'mt'; });
  let consecutive = true, k = 1, maxLen = 0;
  mts.forEach(function (x) { if (x.k !== k || x.r !== 1) consecutive = false; k += x.h.length / 2; maxLen = Math.max(maxLen, JSON.stringify(x).length); });
  check(mts.length >= 11 && consecutive && k - 1 === S.k, 'La tele recibe cada paso, seguidos y sin huecos (' + mts.length + ' mensajes «mt»)');
  check(maxLen <= 60 && mts.every(function (x) { return Object.keys(x).join() === 't,r,k,s,h' && x.h.length === 2; }),
    'Mensajes compactos: solo las cabezas nuevas (' + maxLen + ' bytes como mucho), p. ej. ' + JSON.stringify(mts[0]));
  check(api.sent.filter(function (x) { return x.t === 'mt'; }).length === 0, 'Los móviles no reciben los pasos (solo la tele)');
  const b1 = S.rd.bikes[0], b2 = S.rd.bikes[1];
  const y0 = b1.y;
  g.onMessage(0, { t: 'm.turn', dir: 'left' });      // U-turn: ignored
  g.onMessage(4, { t: 'm.turn', dir: 'up' });        // someone who is not playing
  g.onMessage(0, { t: 'm.turn', dir: 'up' });
  g.onMessage(1, { t: 'm.turn', dir: 'down' });
  check(b1.queue.join() === '0' && b2.queue.join() === '2', 'Giros del móvil: cada uno mueve su moto; la media vuelta y los que miran se ignoran');
  run(g, 0.2);
  check(b1.dir === 0 && b1.y < y0 && b2.dir === 2, 'Las motos giran en el siguiente paso');
  // Long round: the speed reaches 16
  S.playT = 45;
  const k0 = S.k;
  g.onMessage(0, { t: 'm.turn', dir: 'right' });
  g.onMessage(1, { t: 'm.turn', dir: 'left' });
  run(g, 1);
  check(S.k - k0 >= 15 && S.k - k0 <= 17 && S.cps === 16, 'En una ronda larga van a 16 casillas/s (' + (S.k - k0) + ' en 1 s)');
  const lastMt = api.tv.filter(function (x) { return x.t === 'mt'; }).pop();
  check(lastMt.s === 16, 'Cada «mt» lleva la velocidad, para que la tele deslice las cabezas');

  console.log('\n[Juego: rondas y puntos hasta 5]');
  const api2 = fakeApi([0, 1], { 0: 'Ana', 1: 'Berto' });
  const g2 = Game.create(api2);
  const S2 = g2._state;
  g2.start();
  runTo(g2, 'playing', 5);
  let mk = api2.sent.length;
  g2.onMessage(0, { t: 'm.turn', dir: suicideTurn(g2, 1) });
  runTo(g2, 'roundEnd', 5);
  m = metaOf(api2);
  const crash = evs(api2, 'crash', mk);
  const roundEv = evs(api2, 'round', mk);
  check(crash.length === 1 && crash[0].slot === 1 && crash[0].side === 1 && crash[0].cause === 'muro' && xy(crash[0].cell)[1] === 0,
    'Ana gira hacia el muro de arriba y choca: aviso «crash» (muro)');
  check(m.phase === 'roundEnd' && m.score.join() === '0,1' && m.last.winner === 2 && roundEv.length === 1 && roundEv[0].slot === 2,
    'La última moto en pie gana la ronda: punto para Berto (0-1)');
  check(m.last.crashes.length === 1 && m.last.crashes[0].cause === 'muro', 'El estado dice quién chocó y contra qué');
  const kEnd = S2.k;
  run(g2, 1);
  check(S2.k === kEnd && S2.phase === 'roundEnd', 'Tras el choque nadie se mueve mientras se ve el resultado');
  mk = api2.tv.length;
  runTo(g2, 'countdown', 5);
  const snap2 = api2.tv.slice(mk).filter(function (x) { return x.t === 'msnap'; })[0];
  check(S2.round === 2 && snap2 && snap2.r === 2 && snap2.k === 0 && snap2.tr[0].join() === String(cell(16, 30)) && snap2.dr.join() === '0,0',
    'Ronda 2: rejilla limpia y la otra salida (las dos hacia arriba)');
  // Round 2: nobody turns -> both reach the top wall in the same step: draw
  runTo(g2, 'playing', 5);
  mk = api2.sent.length;
  runTo(g2, 'roundEnd', 10);
  m = metaOf(api2);
  check(m.last.winner === 0 && m.score.join() === '0,1' && evs(api2, 'crash', mk).length === 2, 'Las dos chocan en el mismo paso: empate, nadie suma (0-1)');
  // Round 3: Berto crashes -> Ana; then Berto wins until 5
  runTo(g2, 'countdown', 5);
  g2.onMessage(1, { t: 'm.turn', dir: suicideTurn(g2, 2) });
  runTo(g2, 'roundEnd', 10);
  check(metaOf(api2).score.join() === '1,1' && metaOf(api2).last.winner === 1, 'Ronda 3: choca Berto, punto para Ana (1-1)');
  let rounds = 0;
  mk = api2.sent.length;
  while (S2.phase !== 'gameover' && rounds < 10) {
    runTo(g2, 'countdown', 5);
    if (S2.phase !== 'countdown') break;
    g2.onMessage(0, { t: 'm.turn', dir: suicideTurn(g2, 1) });
    runTo(g2, 'roundEnd', 10);
    rounds++;
    if (S2.score[1] < 5) check(S2.phase === 'roundEnd' && S2.score[1] === rounds + 1, 'Punto para Berto: ' + S2.score.join('-'));
  }
  runTo(g2, 'gameover', 5);
  m = metaOf(api2);
  check(m.phase === 'gameover' && m.score.join() === '1,5' && m.winner === 2 && rounds === 4, 'Al llegar a 5 se acaba: gana Berto 1-5');
  const win = evs(api2, 'win', mk);
  check(win.length === 1 && win[0].slot === 2 && win[0].side === 2, 'Aviso «win» para Berto');
  run(g2, 2);
  g2.onMessage(0, { t: 'm.turn', dir: 'up' });
  check(S2.phase === 'gameover' && S2.round === 7, 'Al final todo se queda quieto hasta «Otra»');
  g2.onMessage(-1, { t: 'm.again' });
  m = metaOf(api2);
  check(m.phase === 'countdown' && m.score.join() === '0,0' && m.round === 1 && m.match === 2, '«Otra» (también con OK en la tele): partida nueva, 0-0');

  console.log('\n[Juego: pausa y reconexión]');
  const api3 = fakeApi([0, 1], { 0: 'Ana', 1: 'Berto' });
  const g3 = Game.create(api3);
  const S3 = g3._state;
  g3.start();
  runTo(g3, 'playing', 5);
  g3.onMessage(0, { t: 'm.turn', dir: 'up' });
  run(g3, 0.5);
  const kp = S3.k;
  const lens = S3.rd.bikes.map(function (b) { return b.corners.length; }).join();
  const gridBefore = gridString(S3.rd);
  api3.conn[1] = false;
  g3.onPlayerDisconnected(1);
  m = metaOf(api3);
  check(m.phase === 'paused' && m.waiting.join() === 'Berto', 'Berto se desconecta: pausa («esperando a Berto»)');
  g3.onMessage(0, { t: 'm.turn', dir: 'left' });
  run(g3, 3);
  check(S3.k === kp && gridString(S3.rd) === gridBefore && S3.rd.bikes[0].queue.length === 0, 'En pausa nada se mueve y los giros se ignoran');
  api3.conn[1] = true;
  g3.onPlayerJoined(1, true);
  check(api3.phones.some(function (x) { return x._to === 1 && x.t === 'mmeta'; }), 'Al volver, su móvil recibe el estado');
  run(g3, DT * 2);
  check(S3.phase === 'countdown' && S3.round === 1, 'Vuelve Berto: cuenta atrás y sigue la MISMA ronda');
  runTo(g3, 'playing', 5);
  run(g3, 0.3);
  check(S3.k > kp && S3.rd.bikes.map(function (b) { return b.corners.length; }).join() === lens && gridBefore.split('').every(function (v, i) { return v === '0' || +gridString(S3.rd)[i] === +v; }),
    'Las estelas siguen ahí y las motos continúan (paso ' + kp + ' → ' + S3.k + ')');
  g3.onPlayerDisconnected(4);
  check(S3.phase === 'playing', 'Si se desconecta alguien que solo mira, no hay pausa');
  // Pause while the result of a round is on screen: back with the next round
  g3.onMessage(0, { t: 'm.turn', dir: 'up' });
  runTo(g3, 'roundEnd', 10);
  api3.conn[0] = false;
  g3.onPlayerDisconnected(0);
  check(S3.phase === 'paused' && S3.resume === 'next', 'Pausa durante el resultado de la ronda');
  api3.conn[0] = true;
  run(g3, DT * 2);
  check(S3.phase === 'countdown' && S3.round === 2, 'Al volver, empieza la ronda siguiente');
  // Nobody connected at the start
  const api4 = fakeApi([0, 1]);
  api4.conn[1] = false;
  const g4 = Game.create(api4);
  g4.start();
  check(g4._state.phase === 'paused', 'Si falta un jugador al empezar, espera en pausa');

  console.log('\n[Juego: alguien se va]');
  const api5 = fakeApi([0, 1, 2], { 0: 'Ana', 1: 'Berto', 2: 'Carla' });
  const g5 = Game.create(api5);
  g5.start();
  check(metaOf(api5).players.join() === '1,2', 'Con alguien mirando (Carla), juegan los dos primeros');
  g5.onPlayerJoined(2, false);
  check(api5.phones.some(function (x) { return x._to === 2 && x.t === 'mmeta'; }), 'Quien mira recibe el estado');
  check(g5.onPlayerLeft(5) === true && metaOf(api5).players.join() === '1,2', 'Si se va alguien que solo mira, no cambia nada');
  api5.setPlayers([0, 2]);
  check(g5.onPlayerLeft(1) === true && metaOf(api5).players.join() === '1,3' && metaOf(api5).score.join() === '0,0' && metaOf(api5).match === 2,
    'Se va Berto: Carla ocupa su sitio en una partida nueva');
  api5.setPlayers([0]);
  check(g5.onPlayerLeft(2) === false, 'Si no queda nadie más, vuelta al menú (onPlayerLeft = false)');
}

// ---------------------------------------------------------------- the compact protocol, decoded by the real TV code
function protocol() {
  console.log('\n[Protocolo compacto: la tele rehace la misma rejilla]');
  const api = fakeApi([0, 1], { 0: 'Ana', 1: 'Berto' });
  const g = Game.create(api);
  const S = g._state;
  const tvA = tvModel();
  let fedA = 0, okA = true;
  function feedA() { for (; fedA < api.tv.length; fedA++) okA = tvA.feed(api.tv[fedA]) && okA; }
  check(!!tvA.view && tvA.view.id === 'motos' && typeof tvA.snap === 'function', 'tv.js se carga aparte (sandbox) y da su modelo de estelas');
  g.start();
  feedA();
  runTo(g, 'playing', 5);
  const turns = [[0, 'up'], [1, 'down'], [0, 'left'], [1, 'right'], [0, 'down'], [1, 'up']];
  for (let i = 0; i < turns.length; i++) {
    g.onMessage(turns[i][0], { t: 'm.turn', dir: turns[i][1] });
    run(g, 0.25);
    feedA();
  }
  check(okA && tvA.k === S.k && tvA.gridString() === gridString(S.rd), 'Una tele conectada desde el principio tiene la misma rejilla que el servidor (paso ' + S.k + ')');
  // A TV that (re)connects mid-round: syncTv -> mmeta + msnap, then only moves
  const ws = [];
  g.syncTv(ws);
  check(ws.length === 2 && ws[0].t === 'mmeta' && ws[1].t === 'msnap', 'Una tele que se conecta a mitad recibe el estado y la instantánea');
  const snapBytes = JSON.stringify(ws[1]).length;
  check(ws[1].tr[0].length < 12 && snapBytes < 300, 'La instantánea es pequeña: esquinas y cabezas (' + snapBytes + ' bytes para ' + (S.k * 2 + 2) + ' casillas)');
  const tvB = tvModel();
  ws.forEach(function (x) { tvB.feed(x); });
  check(tvB.gridString() === gridString(S.rd) && tvB.k === S.k && tvB.paths[0].join() === tvA.paths[0].join() && tvB.paths[1].join() === tvA.paths[1].join(),
    'La tele que se reconecta rehace la MISMA rejilla y el mismo orden de las estelas');
  const fromB = api.tv.length;
  let okB = true;
  g.onMessage(0, { t: 'm.turn', dir: 'right' });
  run(g, 0.4);
  feedA();
  for (let i = fromB; i < api.tv.length; i++) okB = tvB.feed(api.tv[i]) && okB;
  check(okB && tvB.gridString() === tvA.gridString() && tvB.gridString() === gridString(S.rd) && tvB.k === S.k, 'Después, con solo las cabezas nuevas, siguen iguales (paso ' + S.k + ')');
  // A missing message: the TV notices and asks for a full state
  const tvC = tvModel();
  tvC.feed(ws[1]);
  const later = api.tv.slice(fromB).filter(function (x) { return x.t === 'mt'; });
  check(later.length >= 2 && tvC.feed(later[1]) === false, 'Si falta un paso (k no seguido), la tele lo detecta…');
  const ws2 = [];
  g.onMessage(-1, { t: 'm.sync' }, ws2);
  tvC.feed(ws2[0]);
  check(ws2.length === 1 && ws2[0].t === 'msnap' && tvC.gridString() === gridString(S.rd), '…pide «m.sync» y recibe la instantánea: vuelve a estar igual');
  // Until the end of the round (crashes included), and the next round
  runTo(g, 'roundEnd', 30);
  feedA();
  check(okA && tvA.gridString() === gridString(S.rd) && tvA.k === S.k, 'Hasta el choque final, la rejilla de la tele es la del servidor');
  runTo(g, 'countdown', 5);
  feedA();
  check(tvA.r === 2 && tvA.k === 0 && tvA.paths[0].length === 1 && tvA.gridString() === gridString(S.rd), 'Ronda nueva: la tele empieza de cero con la nueva instantánea');
}

// ---------------------------------------------------------------- the real server
async function integration() {
  console.log('\n[Servidor: partida real con móviles y teles falsas]');
  const PORT = 3951;
  const WS = 'ws://127.0.0.1:' + PORT + '/ws';
  const HOME = H_.tmpHome('g2t-motos-');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '1500', MOTOS_DEBUG_SPEED: '3' });
  const clients = [];
  function lastMeta(c) { return c.find('mmeta'); }
  // A fake TV that decodes with the real tv.js model
  async function tvClient(label) {
    const c = H_.makeClient(WS, label); clients.push(c);
    c.model = tvModel();
    c.fed = 0;
    c.ok = true;
    c.pump = function () { for (; c.fed < c.msgs.length; c.fed++) c.ok = c.model.feed(c.msgs[c.fed]) && c.ok; return c.model; };
    await c.ready;
    c.send({ t: 'hello', role: 'tv' });
    await H_.waitUntil(function () { return c.hub; }, 2000, label + ' hub');
    return c;
  }
  try {
    const tv1 = await tvClient('tele1');
    const ana = await H_.phone(WS, 'Ana', 'm-ana'); clients.push(ana);
    const berto = await H_.phone(WS, 'Berto', 'm-berto'); clients.push(berto);
    await H_.waitUntil(function () { return tv1.hub && tv1.hub.ready; }, 2000, 'sala lista');
    const t0 = tv1.mark();
    ana.send({ t: 'pick', game: 'motos' });
    const m0 = await tv1.wait(function (m) { return m.t === 'mmeta' && m.phase === 'countdown'; }, 2000, 'cuenta atrás', t0);
    check(!!m0 && m0.players.join() === '1,2' && m0.round === 1 && tv1.hub.screen === 'motos', 'Ana elige «Motos de neón»: cuenta atrás de la ronda 1');
    check(!!(await tv1.wait(function (m) { return m.t === 'msnap' && m.r === 1; }, 1000, 'msnap', t0)), 'La tele recibe la instantánea de la ronda');
    check(!!(await ana.wait(function (m) { return m.t === 'mmeta'; }, 1000, 'mmeta móvil')) && !ana.find('mt') && !ana.find('msnap'), 'Los móviles reciben el estado, pero no los pasos');
    await tv1.wait(function (m) { return m.t === 'mmeta' && m.phase === 'playing'; }, 3000, 'en juego', t0);
    await H_.sleep(150);
    ana.send({ t: 'm.turn', dir: 'up' });
    ana.send({ t: 'm.turn', dir: 'left' });
    berto.send({ t: 'm.turn', dir: 'down' });
    await H_.sleep(200);
    let md = tv1.pump();
    check(tv1.ok && md.dirs[0] === 3 && md.dirs[1] === 2 && md.paths[0].length > 3, 'Giros desde el móvil: Ana arriba e izquierda (dos seguidos), Berto abajo');

    // Pause and reconnection
    await berto.close();
    const pm = await tv1.wait(function (m) { return m.t === 'mmeta' && m.phase === 'paused'; }, 2000, 'pausa', t0);
    check(!!pm && pm.waiting.join() === 'Berto', 'El móvil de Berto se cae: pausa');
    md = tv1.pump();
    const kPause = md.k;
    await H_.sleep(400);
    check(tv1.pump().k === kPause, 'En pausa no llegan pasos');
    const berto2 = await H_.phone(WS, 'Berto', 'm-berto'); clients.push(berto2);
    const bm = await berto2.wait(function (m) { return m.t === 'mmeta'; }, 1500, 'estado al volver');
    check(!!berto2.find('joined').reconnect && !!bm && bm.players.join() === '1,2', 'Berto vuelve (mismo hueco) y recibe el estado');
    const t1 = tv1.mark();
    await tv1.wait(function (m) { return m.t === 'mmeta' && m.phase === 'playing'; }, 3000, 'sigue', t1);
    await H_.sleep(150);
    check(tv1.pump().k > kPause && tv1.ok && tv1.model.r === 1, 'Tras la cuenta atrás sigue la misma ronda, sin huecos (paso ' + tv1.model.k + ')');

    // A TV that reconnects mid-round rebuilds the same grid
    await tv1.close();
    const tv2 = await tvClient('tele2');
    const tv3 = await tvClient('tele3');
    check(!!tv2.find('msnap') && !!tv3.find('msnap'), 'Dos teles que (re)conectan a mitad de ronda reciben la instantánea');
    const end = await tv2.wait(function (m) { return m.t === 'mmeta' && m.phase === 'roundEnd'; }, 15000, 'fin de ronda');
    await H_.sleep(50);
    tv2.pump();
    tv3.pump();
    check(!!end && tv2.ok && tv3.ok && tv2.model.k === tv3.model.k && tv2.model.gridString() === tv3.model.gridString() && tv2.model.gridString().replace(/0/g, '').length >= tv2.model.k * 2,
      'Al acabar la ronda las dos teles tienen la misma rejilla (' + tv2.model.gridString().replace(/0/g, '').length + ' casillas de estela)');
    const crashes = tv2.since(0, 'ev').filter(function (m) { return m.k === 'crash'; });
    check(crashes.length >= 1 && crashes.every(function (c) { return tv2.model.grid[c.cell] !== undefined || c.cell >= 0; }), 'Aviso «crash» con la casilla del choque (' + crashes.map(function (c) { return c.slot + ':' + c.cause; }).join(', ') + ')');

    // Play on until someone gets 5: Ana steers into the nearest wall every round
    let seenRound = 1;
    const tPlay = Date.now();
    while (Date.now() - tPlay < 30000) {
      const m = lastMeta(tv2);
      if (m && m.phase === 'gameover') break;
      if (m && m.phase === 'countdown' && m.round !== seenRound) {
        seenRound = m.round;
        ana.send({ t: 'm.turn', dir: (m.round - 1) % 2 === 0 ? 'up' : 'left' });
      }
      await H_.sleep(100);
    }
    const over = await tv2.wait(function (m) { return m.t === 'mmeta' && m.phase === 'gameover'; }, 20000, 'final');
    check(!!over && over.score[1] === 5 && over.winner === 2, 'Primero en llegar a 5 rondas: gana Berto (' + (over && over.score.join('-')) + ')');
    check(!!(await berto2.wait(function (m) { return m.t === 'ev' && m.k === 'win' && m.slot === 2; }, 1000, 'win')), 'Los móviles reciben el aviso «win»');
    tv2.pump();
    check(tv2.ok, 'La tele ha seguido todas las rondas sin perder ningún paso');
    const t2 = tv2.mark();
    berto2.send({ t: 'm.again' });
    const again = await tv2.wait(function (m) { return m.t === 'mmeta' && m.phase === 'countdown'; }, 2000, 'otra', t2);
    check(!!again && again.score.join() === '0,0' && again.round === 1, '«Otra» desde el móvil: partida nueva');

    // A third phone watches; Berto leaves: Carla takes his place
    const carla = await H_.phone(WS, 'Carla', 'm-carla'); clients.push(carla);
    const cm = await carla.wait(function (m) { return m.t === 'mmeta'; }, 1500, 'Carla mira');
    check(!!cm && cm.players.indexOf(3) < 0, 'Carla entra a mitad: mira (no juega)');
    const t3 = tv2.mark();
    berto2.send({ t: 'leave' });
    const swap = await tv2.wait(function (m) { return m.t === 'mmeta' && m.players.join() === '1,3'; }, 3000, 'Carla juega', t3);
    const left = await tv2.wait(function (m) { return m.t === 'ev' && m.k === 'left'; }, 1000, 'left', t3);
    check(!!swap && !!left && swap.score.join() === '0,0' && tv2.hub.screen === 'motos', 'Berto se va: sigue el juego con Ana contra Carla');
    const t4 = tv2.mark();
    carla.send({ t: 'leave' });
    const menuEv = await tv2.wait(function (m) { return m.t === 'ev' && m.k === 'menu'; }, 3000, 'menú', t4);
    await tv2.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'hub menú', t4);
    check(!!menuEv && /necesita al menos 2/.test(menuEv.text || '') && tv2.hub.screen === 'menu', 'Se va Carla y queda una: vuelta al menú («' + (menuEv && menuEv.text) + '»)');
    // Three in the room: the game says it is for two
    const dani = await H_.phone(WS, 'Dani', 'm-dani'); clients.push(dani);
    const eva = await H_.phone(WS, 'Eva', 'm-eva'); clients.push(eva);
    const t5 = tv2.mark();
    dani.send({ t: 'pick', game: 'motos' });
    const many = await tv2.wait(function (m) { return m.t === 'ev' && m.k === 'toomany'; }, 2000, 'toomany', t5);
    check(!!many && /para 2 jugadores y sois 3/.test(many.text), 'Con 3 en la sala no empieza: «' + (many && many.text) + '»');
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    clients.forEach(function (cl) { try { cl.ws.terminate(); } catch (e) { /* noop */ } });
    await srv.stop();
    H_.rmrf(HOME);
  }
}

(async function () {
  logic();
  unitGame();
  protocol();
  await integration();
  check.done();
})();
