'use strict';
/*
 * «Hockey de mesa»: the physics (walls, posts, mallets, the speed cap, no
 * tunnelling at full speed, mallets kept in their half, goals), the game with
 * a fake hub API (serve after a goal, first to 7, inputs, 30 Hz states, pause
 * and reconnection, someone leaving) and the real server with a fake TV and
 * fake phones (exactly 2 players, inputs, pause, reconnection, leaving).
 */
const H_ = require('./helpers');
const Hockey = require('../src/games/hockey');
const check = H_.checker('Hockey de mesa');
const P = Hockey.physics;
const F = Hockey.FIELD;
const DT = 1 / 60;
const R = F.puckR + F.malletR;

function speed(p) { return Math.hypot(p.vx, p.vy); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
// A world with both mallets parked out of the way (unless moved)
function world() {
  const w = P.newWorld();
  park(w, 0, F.w / 2 - 80, F.h - 70);
  park(w, 1, F.w / 2 + 80, F.h - 70);
  return w;
}
function park(w, side, x, y) { const m = w.mallets[side]; m.x = m.tx = x; m.y = m.ty = y; m.vx = m.vy = 0; }
function puck(w, x, y, vx, vy) { const p = w.puck; p.x = x; p.y = y; p.vx = vx; p.vy = vy; }
function inMouth(y) { return y > F.goalY0 && y < F.goalY1; }

// ---------------------------------------------------------------- physics
function physics() {
  console.log('\n[Paredes y postes]');
  let w = world();
  puck(w, 600, 200, 0, -1200);
  let minY = Infinity, wall = false;
  for (let i = 0; i < 20; i++) { const r = P.step(w, DT, true); if (r.wall === 'wall') wall = true; minY = Math.min(minY, w.puck.y); }
  check(minY >= F.puckR - 1e-9 && w.puck.vy > 0 && wall, 'Pared de arriba: rebota sin salirse (y mínima ' + minY.toFixed(1) + ')');
  const ratio = w.puck.vy / 1200;
  check(ratio > 0.8 && ratio < P.WALL_E, 'Rebote con un poco de pérdida de energía (' + Math.round(ratio * 100) + ' % de la velocidad)');
  w = world();
  puck(w, 300, 150, -1500, 0);
  for (let i = 0; i < 20; i++) P.step(w, DT, true);
  check(w.puck.vx > 0 && w.puck.x >= F.puckR, 'Fondo izquierdo fuera de la portería: rebota');
  w = world();
  puck(w, F.w - 300, F.h - 150, 1500, 0);
  for (let i = 0; i < 20; i++) P.step(w, DT, true);
  check(w.puck.vx < 0 && w.puck.x <= F.w - F.puckR, 'Fondo derecho fuera de la portería: rebota');
  // Post: aimed at the top post of the left goal
  w = world();
  puck(w, 200, F.goalY0 + 6, -900, 0);
  let post = false, goal = -1;
  for (let i = 0; i < 40 && goal < 0; i++) { const r = P.step(w, DT, true); if (r.wall === 'post') post = true; goal = r.goal; }
  check(post && goal < 0 && w.puck.vx > 0, 'El poste devuelve el disco (no es gol)');
  // Low friction
  w = world();
  puck(w, 400, 430, 600, 0);
  for (let i = 0; i < 60; i++) P.step(w, DT, true);
  check(speed(w.puck) > 600 * 0.75 && speed(w.puck) < 600, 'Poco rozamiento: tras 1 s conserva el ' + Math.round(speed(w.puck) / 6) + ' % de la velocidad');

  console.log('\n[Mazo contra disco]');
  w = world();
  park(w, 0, 300, 430);
  puck(w, 600, 430, -800, 0);
  let hits = 0;
  for (let i = 0; i < 40 && !hits; i++) hits += P.step(w, DT, true).hits.length;
  check(hits === 1 && w.puck.vx > 600 && w.puck.vx < 800, 'Mazo quieto: el disco rebota (' + Math.round(w.puck.vx) + ' u/s, algo menos de 800)');
  function swing(perSecond) {
    const s = world();
    park(s, 0, 250, 430);
    puck(s, 450, 430, 0, 0);
    let top = 0;
    for (let i = 0; i < 40; i++) {
      s.mallets[0].tx = Math.min(F.w / 2, s.mallets[0].tx + perSecond * DT);
      P.step(s, DT, true);
      top = Math.max(top, speed(s.puck));
    }
    return top;
  }
  const slow = swing(300), mid = swing(1000), fast = swing(3000);
  check(slow > 400 && slow < 650, 'Golpe suave (mazo a 300 u/s): disco a ' + Math.round(slow) + ' u/s');
  check(mid > slow * 2.5 && fast > mid, 'Cuanto más rápido el mazo, más fuerte el tiro (' + Math.round(slow) + ' < ' + Math.round(mid) + ' < ' + Math.round(fast) + ')');
  check(fast <= P.PUCK_MAX + 1e-6 && fast > P.PUCK_MAX - 1, 'Golpe muy fuerte: velocidad limitada a ' + P.PUCK_MAX + ' (' + Math.round(fast) + ')');
  // The mallet itself is capped: a far target is reached in several steps
  w = world();
  park(w, 0, 100, 100);
  w.mallets[0].tx = 800; w.mallets[0].ty = 800;
  P.step(w, DT, false);
  const moved = Math.hypot(w.mallets[0].x - 100, w.mallets[0].y - 100);
  check(Math.abs(moved - P.MALLET_MAX * DT) < 1e-6 && Math.abs(Math.hypot(w.mallets[0].vx, w.mallets[0].vy) - P.MALLET_MAX) < 1e-6,
    'El mazo va rápido pero con límite (' + Math.round(moved) + ' u por paso, ' + P.MALLET_MAX + ' u/s): no se teletransporta');
  // A puck squeezed against the wall pushes the mallet back
  w = world();
  park(w, 0, 300, 140);
  puck(w, 300, F.puckR + 2, 0, 0);
  w.mallets[0].ty = 0;
  for (let i = 0; i < 20; i++) P.step(w, DT, true);
  check(dist(w.puck, w.mallets[0]) >= R - 0.5 && w.puck.y >= F.puckR - 1e-9, 'Disco aplastado contra la pared: el mazo no lo atraviesa');

  console.log('\n[Sin efecto túnel a la velocidad máxima]');
  // Head on: puck at max speed against a mallet coming at max speed
  w = world();
  park(w, 0, 300, 430);
  w.mallets[0].tx = F.w / 2;
  puck(w, 820, 430, -P.PUCK_MAX, 0);
  let overlap = false;
  for (let i = 0; i < 30; i++) { P.step(w, DT, true); if (dist(w.puck, w.mallets[0]) < R - 0.5) overlap = true; }
  check(!overlap && w.puck.vx > 0 && w.puck.x > w.mallets[0].x, 'Disco y mazo de frente a tope (' + Math.round((P.PUCK_MAX + P.MALLET_MAX) * DT) + ' u por paso): rebota, no lo atraviesa');
  // Fuzz: many shots at max speed with mallets moving at max speed
  let seed = 12345;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  let bad = 0, goals = 0, steps = 0, maxSub = 0, tooFast = 0, outHalf = 0;
  for (let k = 0; k < 300; k++) {
    w = world();
    park(w, 0, 60 + rnd() * 700, 60 + rnd() * 740);
    park(w, 1, F.w - 60 - rnd() * 700, 60 + rnd() * 740);
    const a = rnd() * Math.PI * 2;
    puck(w, F.w / 2 + (rnd() - 0.5) * 200, F.h / 2 + (rnd() - 0.5) * 600, Math.cos(a) * P.PUCK_MAX, Math.sin(a) * P.PUCK_MAX);
    for (let i = 0; i < 90; i++) {
      if (i % 7 === 0) { w.mallets[0].tx = rnd() * F.w; w.mallets[0].ty = rnd() * F.h; w.mallets[1].tx = rnd() * F.w; w.mallets[1].ty = rnd() * F.h; }
      const r = P.step(w, DT, true);
      steps++;
      maxSub = Math.max(maxSub, r.substeps);
      if (r.goal >= 0) { goals++; break; }
      const p = w.puck;
      if (p.y < F.puckR - 1e-6 || p.y > F.h - F.puckR + 1e-6) bad++;
      if (!inMouth(p.y) && (p.x < F.puckR - 1e-6 || p.x > F.w - F.puckR + 1e-6)) bad++;
      if (dist(p, w.mallets[0]) < R - 0.5 || dist(p, w.mallets[1]) < R - 0.5) bad++;
      if (speed(p) > P.PUCK_MAX + 1e-6) tooFast++;
      const m0 = w.mallets[0], m1 = w.mallets[1];
      if (m0.x + F.malletR > F.w / 2 + 1e-9 || m1.x - F.malletR < F.w / 2 - 1e-9) outHalf++;
    }
  }
  check(bad === 0, '300 tiros a tope con los mazos moviéndose: el disco nunca atraviesa un mazo, una pared ni un poste (' + steps + ' pasos, hasta ' + maxSub + ' subpasos, ' + goals + ' goles)');
  check(tooFast === 0 && outHalf === 0, 'Nunca pasa de la velocidad máxima y los mazos nunca cruzan el centro');

  console.log('\n[Cada mazo en su mitad]');
  w = world();
  w.mallets[0].tx = F.w; w.mallets[0].ty = -500;
  w.mallets[1].tx = 0; w.mallets[1].ty = F.h + 500;
  for (let i = 0; i < 120; i++) P.step(w, DT, false);
  const m0 = w.mallets[0], m1 = w.mallets[1];
  check(m0.x === F.w / 2 - F.malletR && m0.y === F.malletR, 'El mazo izquierdo llega a la línea del centro y se para (x=' + m0.x + ')');
  check(m1.x === F.w / 2 + F.malletR && m1.y === F.h - F.malletR, 'El mazo derecho igual por su lado (x=' + m1.x + ')');
  const t0 = P.targetFromInput(0, 1.5, -1), t1 = P.targetFromInput(1, -3, 2);
  check(t0.x === F.w / 2 - F.malletR && t0.y === F.malletR && t1.x === F.w / 2 + F.malletR && t1.y === F.h - F.malletR, 'Entradas fuera de 0..1 se recortan a su mitad');
  const back = P.inputFromPos(1, P.targetFromInput(1, 0.3, 0.7).x, P.targetFromInput(1, 0.3, 0.7).y);
  check(Math.abs(back.x - 0.3) < 1e-9 && Math.abs(back.y - 0.7) < 1e-9, 'Posición del móvil <-> mesa (lado derecho: x=0 es la línea del centro)');

  console.log('\n[Goles]');
  w = world();
  puck(w, 120, F.h / 2, -300, 0);
  let g = -1, partial = false;
  for (let i = 0; i < 120 && g < 0; i++) {
    const r = P.step(w, DT, true);
    g = r.goal;
    if (g < 0 && w.puck.x < 0 && w.puck.x + F.puckR >= 0) partial = true;
  }
  check(partial && g === 0, 'Medio disco dentro no es gol; entero dentro de la portería izquierda, sí');
  w = world();
  puck(w, F.w - 200, F.h / 2 + 40, 2000, 150);
  g = -1;
  for (let i = 0; i < 60 && g < 0; i++) g = P.step(w, DT, true).goal;
  check(g === 1, 'A toda velocidad y en diagonal también entra en la derecha');
  w = world();
  puck(w, F.w - 200, 100, 2400, 0);
  g = -1;
  for (let i = 0; i < 12 && g < 0; i++) g = P.step(w, DT, true).goal;
  check(g < 0 && w.puck.vx < 0, 'Fuera de la boca de gol, el fondo devuelve el disco');
}

// ---------------------------------------------------------------- game with a fake hub API
function fakeApi(players) {
  const sent = [], tv = [], toSlot = [];
  const conn = {};
  players.forEach(function (i) { conn[i] = true; });
  return {
    sent: sent, tv: tv, toSlot: toSlot, conn: conn,
    slots: 6,
    tvs: new Set([1]),
    players: function () { return players.slice(); },
    setPlayers: function (p) { players = p; },
    isConnected: function (i) { return !!conn[i]; },
    allConnected: function () { return players.every(function (i) { return conn[i]; }); },
    name: function (i) { return ['Ana', 'Berto', 'Carla', 'Dani'][i] || ('J' + (i + 1)); },
    broadcast: function (m) { sent.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendTvs: function (m) { tv.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendSlot: function (i, m) { toSlot.push(Object.assign({ _to: i }, typeof m === 'string' ? JSON.parse(m) : m)); },
    sendWs: function () {},
    log: function () {}
  };
}
function lastMeta(api) { for (let i = api.sent.length - 1; i >= 0; i--) if (api.sent[i].t === 'hmeta') return api.sent[i]; return null; }
function evs(api, from, k) { return api.sent.slice(from).filter(function (m) { return m.t === 'ev' && (!k || m.k === k); }); }
function run(g, n, until) { for (let i = 0; i < n; i++) { g.tick(DT); g.flush(); if (until && until()) return i + 1; } return n; }
// Puts the puck just in front of a goal, going in
function shootInto(g, into) {
  const S = g._state;
  S.phase = 'playing';
  const p = S.world.puck;
  p.x = into === 0 ? 80 : F.w - 80; p.y = F.h / 2; p.vx = into === 0 ? -900 : 900; p.vy = 0;
  park(S.world, 0, 100, 100); park(S.world, 1, F.w - 100, 100);
}

function unitGame() {
  console.log('\n[Partida: saque, goles y saque hacia quien encaja]');
  const api = fakeApi([0, 2]);
  const g = Hockey.create(api, { random: function () { return 0.75; } });
  g.start();
  g.flush();
  const S = g._state;
  let m = lastMeta(api);
  check(m && m.phase === 'countdown' && m.countdown === 3 && m.players.join() === '1,3' && m.score.join() === '0,0' && m.field.w === F.w,
    'Empieza con cuenta atrás 3-2-1; Ana a la izquierda y Carla (hueco 3) a la derecha');
  const you = api.toSlot.filter(function (x) { return x.t === 'h.you'; });
  check(you.length === 2 && you[0]._to === 0 && Math.abs(you[0].x - 0.24) < 0.01 && you[1]._to === 2 && Math.abs(you[1].x - 0.76) < 0.01, 'Cada móvil recibe dónde está su mazo (h.you)');
  run(g, 179);
  check(S.phase === 'countdown' && speed(S.world.puck) === 0, 'Durante la cuenta atrás el disco no se mueve');
  let mark = api.sent.length;
  run(g, 3);
  check(S.phase === 'playing' && evs(api, mark, 'go').length === 1 && S.world.puck.vx > 0 && Math.abs(speed(S.world.puck) - P.SERVE_SPEED) < 5,
    '¡YA! El primer saque sale despacio hacia un lado (aquí, hacia Carla)');
  // Goal in the left goal: point for the right player, serve towards the left (who conceded)
  shootInto(g, 0);
  mark = api.sent.length;
  run(g, 10, function () { return S.phase !== 'playing'; });
  m = lastMeta(api);
  const ge = evs(api, mark, 'goal')[0];
  check(S.phase === 'goal' && m.score.join() === '0,1' && ge && ge.side === 2 && ge.slot === 3 && ge.into === 1, 'Gol en la portería izquierda: punto para Carla');
  check(S.world.puck.x === F.w / 2 && speed(S.world.puck) === 0 && m.lastScorer === 2 && m.serve === 1, 'El disco vuelve al centro, quieto, y el saque será para Ana');
  run(g, Math.round(P.GOAL_PAUSE_S * 60) - 2);
  check(S.phase === 'goal', 'Pausa corta tras el gol (' + P.GOAL_PAUSE_S + ' s)');
  run(g, 4);
  check(S.phase === 'playing' && S.world.puck.vx < 0 && Math.abs(speed(S.world.puck) - P.SERVE_SPEED) < 5, 'Tras la pausa, el disco sale hacia Ana, que ha encajado');
  shootInto(g, 1);
  run(g, 10, function () { return S.phase !== 'playing'; });
  run(g, Math.round(P.GOAL_PAUSE_S * 60) + 2);
  check(lastMeta(api).score.join() === '1,1' && S.world.puck.vx > 0, 'Gol de Ana: 1-1 y el saque va hacia Carla');
  // A mallet resting on the centre spot during the pause is pushed out
  shootInto(g, 1);
  run(g, 10, function () { return S.phase !== 'playing'; });
  S.world.mallets[0].tx = F.w / 2; S.world.mallets[0].ty = F.h / 2;
  run(g, 20);
  check(dist(S.world.mallets[0], S.world.puck) >= R - 0.5 && S.phase === 'goal', 'En la pausa, el mazo no puede robar el disco del centro');

  console.log('\n[A 7]');
  S.score = [0, 0];
  for (let k = 0; k < 6; k++) {
    shootInto(g, 1);
    run(g, 10, function () { return S.phase !== 'playing'; });
  }
  check(S.phase === 'goal' && S.score.join() === '6,0', '6-0: la partida sigue');
  mark = api.sent.length;
  shootInto(g, 1);
  run(g, 10, function () { return S.phase !== 'playing'; });
  m = lastMeta(api);
  const win = evs(api, mark, 'win')[0];
  check(m.phase === 'end' && m.winner === 1 && m.score.join() === '7,0' && win && win.slot === 1 && win.side === 1, '7-0: gana Ana (fin de la partida)');
  run(g, 120);
  check(S.phase === 'end' && speed(S.world.puck) === 0, 'Tras el final el disco no se mueve');
  g.onMessage(2, { t: 'h.again' });
  run(g, 1);
  m = lastMeta(api);
  check(m.phase === 'countdown' && m.score.join() === '0,0' && m.match === 2, '«Otra»: partida nueva 0-0 con cuenta atrás');
  g.onMessage(-1, { t: 'h.again' });
  check(lastMeta(api).match === 2, '«Otra» solo vale al final');

  console.log('\n[Entradas y estado a 30 Hz]');
  run(g, 200);
  g.onMessage(0, { t: 'h.m', x: 0.5, y: 0.25 });
  const target = P.targetFromInput(0, 0.5, 0.25);
  check(S.world.mallets[0].tx === target.x && S.world.mallets[0].ty === target.y, 'El móvil de Ana mueve el objetivo de su mazo (posición absoluta)');
  g.onMessage(2, { t: 'h.m', x: 0.9, y: 0.9 });
  check(S.world.mallets[1].tx === P.targetFromInput(1, 0.9, 0.9).x, 'El de Carla, el suyo');
  const before = JSON.stringify(S.world.mallets.map(function (x) { return [x.tx, x.ty]; }));
  g.onMessage(1, { t: 'h.m', x: 0.1, y: 0.1 });
  g.onMessage(-1, { t: 'h.m', x: 0.1, y: 0.1 });
  g.onMessage(0, { t: 'h.m', x: 'hola', y: null });
  g.onMessage(0, { t: 'h.m', x: Infinity, y: 0.5 });
  check(JSON.stringify(S.world.mallets.map(function (x) { return [x.tx, x.ty]; })) === before, 'Se ignora a quien solo mira, a la tele y valores raros');
  g.onMessage(0, { t: 'h.m', x: 9, y: -9 });
  run(g, 60);
  check(S.world.mallets[0].x === F.w / 2 - F.malletR && S.world.mallets[0].y === F.malletR, 'Pedir más allá del centro deja el mazo en la línea');
  const n0 = api.tv.length;
  run(g, 60);
  const states = api.tv.slice(n0).filter(function (x) { return x.t === 'hs'; });
  const st = states[states.length - 1];
  check(states.length === 30, 'Estado para la tele a 30 Hz (' + states.length + ' en 60 pasos)');
  check(st.p.length === 4 && st.m.length === 4 && st.m[0] === S.world.mallets[0].x && typeof st.r === 'number' && JSON.stringify(st).length < 160,
    'Estado compacto: disco [x, y, vx, vy], mazos [x0, y0, x1, y1] (' + JSON.stringify(st).length + ' bytes)');
  check(api.sent.filter(function (x) { return x.t === 'hs'; }).length === 0, 'Los móviles no reciben el estado del disco');

  console.log('\n[Pausa, reconexión y salidas]');
  S.phase = 'playing';
  const p = S.world.puck;
  p.x = 600; p.y = 300; p.vx = 500; p.vy = 200;
  park(S.world, 0, 100, 700); park(S.world, 1, F.w - 100, 700);
  api.conn[2] = false;
  g.onPlayerDisconnected(2);
  m = lastMeta(api);
  check(m.phase === 'paused' && m.waiting.join() === 'Carla', 'Se cae el móvil de Carla: pausa («esperando a Carla»)');
  run(g, 120);
  check(p.x === 600 && p.y === 300 && S.phase === 'paused', 'En pausa el disco no se mueve');
  api.conn[2] = true;
  api.toSlot.length = 0;
  g.onPlayerJoined(2, true);
  const youBack = api.toSlot.filter(function (x) { return x.t === 'h.you' && x._to === 2; })[0];
  check(!!youBack && api.toSlot.some(function (x) { return x.t === 'hmeta' && x._to === 2; }), 'Al volver, su móvil recibe el estado y dónde está su mazo');
  run(g, 1);
  check(S.phase === 'countdown', 'Vuelve Carla: cuenta atrás');
  run(g, 181);
  check(S.phase === 'playing' && p.vx > 400 && p.vy > 100, '…y el disco sigue como iba');
  api.conn[5] = true;
  g.onPlayerDisconnected(5);
  check(S.phase === 'playing', 'Si se cae alguien que solo mira, no hay pausa');
  check(g.onPlayerLeft(5) === true && g.onPlayerLeft(2) === false, 'Si se va quien mira, se sigue; si se va un jugador, al menú');
}

// ---------------------------------------------------------------- the real server
async function integration() {
  console.log('\n[Servidor: 2 jugadores, mazos, pausa, reconexión y salida]');
  const PORT = 4127;
  const WS = 'ws://127.0.0.1:' + PORT + '/ws';
  const HOME = H_.tmpHome('g2t-hockey-');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '1500', HOCKEY_DEBUG_SPEED: '3' });
  const clients = [];
  try {
    const tv = H_.makeClient(WS, 'tele'); clients.push(tv);
    await tv.ready;
    const hs = [];
    tv.ws.on('message', function (d) { const m = JSON.parse(d.toString()); if (m.t === 'hs') { m._at = Date.now(); hs.push(m); } });
    tv.send({ t: 'hello', role: 'tv' });
    await H_.waitUntil(function () { return tv.hub; }, 2000, 'hub');
    const ana = await H_.phone(WS, 'Ana', 'h-ana'); clients.push(ana);
    ana.send({ t: 'pick', game: 'hockey' });
    const need = await ana.wait(function (m) { return m.t === 'ev' && m.k === 'need2'; }, 1500, 'need2');
    check(!!need && /falta 1 jugador/.test(need.text), 'Con 1 móvil no empieza: «' + (need && need.text) + '»');
    const berto = await H_.phone(WS, 'Berto', 'h-berto'); clients.push(berto);
    const carla = await H_.phone(WS, 'Carla', 'h-carla'); clients.push(carla);
    ana.send({ t: 'pick', game: 'hockey' });
    const many = await ana.wait(function (m) { return m.t === 'ev' && m.k === 'toomany'; }, 1500, 'toomany');
    check(!!many && /sois 3/.test(many.text), 'Con 3 tampoco: es para 2 («' + (many && many.text) + '»)');
    carla.send({ t: 'leave' });
    await H_.waitUntil(function () { return tv.hub && tv.hub.players.filter(Boolean).length === 2; }, 2000, '2 jugadores');
    const t0 = tv.mark();
    berto.send({ t: 'pick', game: 'hockey' });
    const m0 = await tv.wait(function (m) { return m.t === 'hmeta'; }, 2000, 'hmeta', t0);
    check(!!m0 && m0.phase === 'countdown' && m0.players.join() === '1,2' && m0.toWin === 7, 'Berto elige «Hockey de mesa»: cuenta atrás, Ana a la izquierda y Berto a la derecha, a 7');
    const you = await ana.wait(function (m) { return m.t === 'h.you'; }, 1000, 'h.you');
    check(!!you && you.x > 0 && you.x < 0.5, 'Ana recibe dónde está su mazo');
    const go = await tv.wait(function (m) { return m.t === 'hmeta' && m.phase === 'playing'; }, 3000, 'en juego', t0);
    check(!!go, '¡A jugar!');
    // State rate
    const n0 = hs.length;
    await H_.sleep(1000);
    const rate = hs.length - n0;
    check(rate >= 24 && rate <= 36, 'La tele recibe ~30 estados por segundo (' + rate + ')');
    // Inputs move the mallets
    ana.send({ t: 'h.m', x: 0.9, y: 0.2 });
    berto.send({ t: 'h.m', x: 0.1, y: 0.8 });
    const moved = await H_.waitUntil(function () {
      const s = hs[hs.length - 1];
      return s && Math.abs(s.m[0] - P.targetFromInput(0, 0.9, 0.2).x) < 0.5 && Math.abs(s.m[3] - P.targetFromInput(1, 0.1, 0.8).y) < 0.5 ? s : null;
    }, 1500, 'mazos');
    check(!!moved, 'Los dos móviles mueven sus mazos (la tele los ve en su sitio)');
    ana.send({ t: 'h.m', x: 5, y: 0.5 });
    const line = await H_.waitUntil(function () { const s = hs[hs.length - 1]; return s && s.m[0] === F.w / 2 - F.malletR ? s : null; }, 1500, 'línea');
    check(!!line, 'Ana no puede pasar de la línea del centro');
    // Pause and reconnection
    const t1 = tv.mark();
    await berto.close();
    const paused = await tv.wait(function (m) { return m.t === 'hmeta' && m.phase === 'paused' && m.waiting.indexOf('Berto') >= 0; }, 2000, 'pausa', t1);
    check(!!paused, 'Berto se cae: pausa');
    const frozen = hs[hs.length - 1];
    await H_.sleep(300);
    const still = hs[hs.length - 1];
    check(frozen && still && frozen.p[0] === still.p[0] && frozen.p[1] === still.p[1] && still.ph === 'paused', 'En pausa el disco está quieto');
    const berto2 = await H_.phone(WS, 'Berto', 'h-berto'); clients.push(berto2);
    const back = await berto2.wait(function (m) { return m.t === 'h.you'; }, 1500, 'h.you al volver');
    check(!!berto2.find('joined').reconnect && !!back && Math.abs(back.x - 0.1) < 0.01 && Math.abs(back.y - 0.8) < 0.01, 'Berto vuelve y su móvil sabe dónde dejó el mazo');
    const again = await tv.wait(function (m) { return m.t === 'hmeta' && m.phase === 'countdown'; }, 2000, 'cuenta atrás', t1);
    const play2 = await tv.wait(function (m) { return m.t === 'hmeta' && m.phase === 'playing'; }, 3000, 'sigue', t1);
    check(!!again && !!play2, 'Cuenta atrás y se sigue jugando');
    // Leaving: back to the menu
    const t2 = tv.mark();
    berto2.send({ t: 'leave' });
    const menu = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'menu'; }, 2000, 'menú', t2);
    check(!!menu && /Berto se ha ido/.test(menu.text) && tv.hub.screen === 'menu', 'Berto se va: vuelta al menú («' + (menu && menu.text) + '»)');
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    clients.forEach(function (c) { try { c.ws.terminate(); } catch (e) { /* noop */ } });
    await srv.stop();
    H_.rmrf(HOME);
  }
}

(async function () {
  physics();
  unitGame();
  await integration();
  check.done();
})();
