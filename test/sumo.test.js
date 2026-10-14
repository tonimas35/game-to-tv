'use strict';
/*
 * «Sumo»: the physics (friction, momentum, the dash mass boost, ring-out,
 * the ring shrinking), the game with a fake hub API (countdown, inputs,
 * dash cooldown, rounds, same-tick draw, first to 3, pause and resume, a
 * player leaving), and the real server with a fake TV and fake phones
 * (30 Hz state, joystick, dash, collisions, pause and reconnection, a whole
 * match, someone leaving).
 */
const H_ = require('./helpers');
const Sumo = require('../src/games/sumo');
const Ph = require('../src/games/sumo/physics');
const P = Ph.P;
const check = H_.checker('Sumo');
const DT = 1 / 60;

function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }
function speed(w) { return Math.sqrt(w.vx * w.vx + w.vy * w.vy); }
function steps(ws, secs, move) { let hits = 0; for (let t = 0; t < secs * 60; t++) { if (Ph.stepWorld(ws, DT, move !== false)) hits++; } return hits; }

// ---------------------------------------------------------------- physics
function physics() {
  console.log('\n[Física]');
  // Friction: a ball sliding with no input stops for good
  const w = Ph.makeWrestler(P.CX, P.CY, 0);
  w.vx = 500;
  let t = 0;
  while (speed(w) > 0 && t < 600) { Ph.stepWrestler(w, DT, true); t++; }
  check(speed(w) === 0 && t < 120, 'Sin joystick, el rozamiento la para del todo (a 500 px/s se para en ' + (t / 60).toFixed(2) + ' s)');
  const slid = w.x - P.CX;
  check(slid > 100 && slid < 220, 'Y se desliza un trecho razonable (' + Math.round(slid) + ' px)');
  for (let k = 0; k < 60; k++) Ph.stepWrestler(w, DT, true);
  check(w.x === P.CX + slid, 'Parada, no se mueve sola');
  // Acceleration and top speed
  const a = Ph.makeWrestler(0, 0, 0);
  Ph.setInput(a, 1, 0);
  Ph.stepWrestler(a, DT, true);
  check(a.vx > 0 && a.vx < 40, 'El joystick acelera poco a poco (' + a.vx.toFixed(1) + ' px/s tras un paso)');
  for (let k = 0; k < 240; k++) Ph.stepWrestler(a, DT, true);
  // Fixed point of one step: v = ((v + ACCEL·dt)·e^(-DRAG·dt)) - FRICTION·dt
  const ek = Math.exp(-P.DRAG * DT);
  const top = (P.ACCEL * ek - P.FRICTION) * DT / (1 - ek);
  check(near(a.vx, top, 2), 'Velocidad máxima ~' + Math.round(top) + ' px/s (' + Math.round(a.vx) + ')');
  check(near(a.face, 0), 'Mira hacia donde va');
  // Input: clamped, dead zone, garbage
  const b = Ph.makeWrestler(0, 0, 0);
  Ph.setInput(b, 3, 4);
  check(near(b.ix, 0.6) && near(b.iy, 0.8), 'Joystick limitado al círculo unidad (3,4 -> 0.6,0.8)');
  Ph.setInput(b, 0.05, -0.05);
  check(b.ix === 0 && b.iy === 0, 'Zona muerta en el centro');
  Ph.setInput(b, 'x', null);
  check(b.ix === 0 && b.iy === 0, 'Valores raros: quieto');

  // Momentum transfer: equal masses, head-on
  const p1 = Ph.makeWrestler(500, 500, 0), p2 = Ph.makeWrestler(500 + 2 * P.BALL_R - 1, 500, Math.PI);
  p1.vx = 600;
  const before = p1.vx * Ph.massOf(p1) + p2.vx * Ph.massOf(p2);
  const h = Ph.collide(p1, p2);
  const after = p1.vx * Ph.massOf(p1) + p2.vx * Ph.massOf(p2);
  check(!!h && h.speed === 600 && near(before, after, 1e-9), 'Choque: se conserva la cantidad de movimiento (' + before + ' = ' + after.toFixed(3) + ')');
  check(near(p2.vx, 600 * (1 + P.RESTITUTION) / 2) && near(p1.vx, 600 * (1 - P.RESTITUTION) / 2), 'Con la misma masa, el golpeado sale a ' + p2.vx + ' px/s y el que golpea casi se para (' + p1.vx + ')');
  check(p2.x - p1.x >= 2 * P.BALL_R - 1e-9, 'Y ya no se solapan');
  check(Ph.collide(Ph.makeWrestler(0, 0), Ph.makeWrestler(2 * P.BALL_R + 1, 0)) === null, 'Sin tocarse no hay choque');
  // Dash: more mass, so much more push
  const d1 = Ph.makeWrestler(500, 500, 0), d2 = Ph.makeWrestler(500 + 2 * P.BALL_R - 1, 500, Math.PI);
  d1.vx = 600;
  d1.dash = P.DASH_TIME;
  const dm = Ph.massOf(d1);
  Ph.collide(d1, d2);
  const expect = 600 * (1 + P.RESTITUTION) * dm / (dm + 1);
  check(dm === P.DASH_MASS && near(d2.vx, expect) && d2.vx > p2.vx * 1.3, 'Embistiendo pesa ' + dm + ' veces más: el otro sale a ' + Math.round(d2.vx) + ' px/s (sin embestir, ' + Math.round(p2.vx) + ')');
  check(near(d1.vx * dm + d2.vx, 600 * dm, 1e-9), '…y también se conserva la cantidad de movimiento');
  // Pushing works: contact and acceleration move the other one
  const s1 = Ph.makeWrestler(700, 600, 0), s2 = Ph.makeWrestler(700 + 2 * P.BALL_R, 600, Math.PI);
  Ph.setInput(s1, 1, 0);
  steps([s1, s2], 1.5);
  check(s2.x > 700 + 2 * P.BALL_R + 150 && s1.x < s2.x - 2 * P.BALL_R + 1, 'Empujar funciona: el de delante avanza ' + Math.round(s2.x - 700 - 2 * P.BALL_R) + ' px');
  const e1 = Ph.makeWrestler(700, 600, 0), e2 = Ph.makeWrestler(700 + 2 * P.BALL_R, 600, Math.PI);
  Ph.setInput(e1, 1, 0);
  Ph.setInput(e2, -1, 0);
  steps([e1, e2], 1.5);
  check(Math.abs((e1.x + e2.x) / 2 - (700 + P.BALL_R)) < 2, 'Dos que empujan igual se quedan en tablas');

  // A well-timed dash knocks the other one out (and a plain push does not)
  function duel(dash) {
    const edge = P.CX + P.R0;
    const atk = Ph.makeWrestler(edge - 330, P.CY, 0), def = Ph.makeWrestler(edge - 170, P.CY, Math.PI);
    Ph.setInput(atk, 1, 0);
    Ph.setInput(def, -1, 0);     // resisting with everything
    if (dash) Ph.tryDash(atk);
    for (let k = 0; k < 90; k++) {
      Ph.stepWorld([atk, def], DT, true);
      if (Ph.isOut(def, P.R0)) return true;
    }
    return false;
  }
  check(!duel(false) && duel(true), 'Contra uno que resiste a 170 px del borde: empujando no sale; con una embestida, ¡fuera!');
  const cdw = Ph.makeWrestler(0, 0, 0);
  Ph.setInput(cdw, 0, -1);
  check(Ph.tryDash(cdw) && near(cdw.vy, -P.DASH_SPEED) && cdw.cd === P.DASH_COOLDOWN && near(cdw.face, -Math.PI / 2), 'Embestida hacia donde apunta el joystick (arriba)');
  check(!Ph.tryDash(cdw), 'Durante la recarga no se puede repetir');
  for (let k = 0; k < 2 * 60 + 1; k++) Ph.stepWrestler(cdw, DT, true);
  check(cdw.cd === 0 && cdw.dash === 0 && Ph.tryDash(cdw), 'A los 2 s se puede otra vez');
  const idle = Ph.makeWrestler(0, 0, Math.PI);
  Ph.tryDash(idle);
  check(near(idle.vx, -P.DASH_SPEED), 'Sin joystick, embiste hacia donde mira');

  // Ring-out and the shrinking ring
  const o = Ph.makeWrestler(P.CX + P.R0 - 1, P.CY, 0);
  check(!Ph.isOut(o, P.R0), 'Con el centro dentro del círculo, sigue dentro');
  o.x = P.CX + P.R0 + 1;
  check(Ph.isOut(o, P.R0), 'Con el centro fuera del borde: ¡fuera!');
  o.x = P.CX; o.y = P.CY - P.R0 + 50;
  check(!Ph.isOut(o, P.R0) && Ph.isOut(o, 40), 'Y depende del radio: dentro a ' + P.R0 + ', fuera si encoge a 40');
  check(Ph.ringRadius(0) === P.R0 && Ph.ringRadius(P.SHRINK_START) === P.R0, 'El círculo no encoge los primeros ' + P.SHRINK_START + ' s');
  check(near(Ph.ringRadius(P.SHRINK_START + 5), P.R0 - 5 * P.SHRINK_RATE) && Ph.ringRadius(20) < Ph.ringRadius(15), 'Después encoge poco a poco (' + Ph.ringRadius(15) + ' a los 15 s, ' + Ph.ringRadius(20) + ' a los 20 s)');
  check(Ph.ringRadius(25) < 2.5 * P.BALL_R && Ph.ringRadius(32) === 0, 'A los 25 s apenas caben los dos (' + Ph.ringRadius(25) + ') y a los 32 s no queda círculo');
}

// ---------------------------------------------------------------- the game with a fake hub API
function fakeApi(players, names) {
  const sent = [], tv = [], toSlot = [];
  const conn = {};
  players.forEach(function (i) { conn[i] = true; });
  return {
    slots: 6, sent: sent, tv: tv, toSlot: toSlot, conn: conn,
    tvs: new Set([1]),
    players: function () { return players.slice(); },
    setPlayers: function (p) { players = p; },
    isConnected: function (i) { return !!conn[i]; },
    allConnected: function () { return players.every(function (i) { return conn[i]; }); },
    name: function (i) { return names[i] || ('J' + (i + 1)); },
    broadcast: function (m) { sent.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendTvs: function (m) { tv.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendSlot: function (i, m) { toSlot.push(Object.assign({ _to: i }, typeof m === 'string' ? JSON.parse(m) : m)); },
    sendWs: function () {},
    log: function () {}
  };
}
function lastMeta(api) { for (let i = api.sent.length - 1; i >= 0; i--) if (api.sent[i].t === 'smeta') return api.sent[i]; return null; }
function evs(api, k, from) { return api.sent.slice(from || 0).filter(function (m) { return m.t === 'ev' && m.k === k; }); }
function run(g, secs, until) { for (let t = 0; t < secs * 60; t++) { g.tick(DT); g.flush(); if (until && until()) return true; } return false; }
function toPlaying(g) { return run(g, 5, function () { return g._state.phase === 'playing'; }); }
function throwOut(g, k) { const w = g._state.w[k]; w.x = P.CX + (k === 0 ? -1 : 1) * (P.R0 + 30); w.vx = 0; w.vy = 0; }

function unitGame() {
  console.log('\n[Juego: cuenta atrás, entradas y embestida]');
  const api = fakeApi([0, 1], { 0: 'Ana', 1: 'Berto' });
  const g = Sumo.create(api);
  g.start();
  g.flush();
  const S = g._state;
  let m = lastMeta(api);
  check(m && m.phase === 'countdown' && m.countdown === 3 && m.slots.join() === '1,2' && m.round === 1 && m.score.join() === '0,0', 'Empieza con la cuenta atrás 3-2-1, ronda 1, 0-0');
  check(S.w[0].x < P.CX && S.w[1].x > P.CX && S.w[0].y === S.w[1].y && near(S.w[0].face, 0) && near(S.w[1].face, Math.PI), 'Cada uno en un lado del círculo, mirándose');
  // During the countdown nobody moves (but the eyes follow the joystick)
  g.onMessage(0, { t: 's.j', x: 0, y: 1 });
  const x0 = S.w[0].x, y0 = S.w[0].y;
  run(g, 1);
  check(S.w[0].x === x0 && S.w[0].y === y0 && near(S.w[0].face, Math.PI / 2), 'En la cuenta atrás no se mueve nadie, pero mira hacia el joystick');
  const cdSeen = api.sent.filter(function (x) { return x.t === 'smeta' && x.phase === 'countdown'; }).map(function (x) { return x.countdown; });
  check(cdSeen.indexOf(3) >= 0 && cdSeen.indexOf(2) >= 0, 'La tele recibe el 3 y el 2 (' + cdSeen.filter(function (v, i, a) { return a.indexOf(v) === i; }).join(',') + ')');
  g.onMessage(0, { t: 's.d' });
  const refused = api.toSlot.filter(function (x) { return x.t === 's.cd'; }).pop();
  check(refused && refused.ok === false && refused._to === 0 && S.w[0].cd === 0, 'Embestida antes de «¡YA!»: rechazada (s.cd ok=false)');
  let mark = api.sent.length;
  check(toPlaying(g) && evs(api, 'go', mark).length === 1, '«¡YA!»: a jugar');
  // Inputs
  g.onMessage(0, { t: 's.j', x: 5, y: 0 });
  check(S.w[0].ix === 1 && S.w[0].iy === 0, 'Joystick fuera de rango: se limita a 1');
  g.onMessage(1, { t: 's.j', x: 'a', y: {} });
  check(S.w[1].ix === 0 && S.w[1].iy === 0, 'Joystick con basura: quieto');
  g.onMessage(-1, { t: 's.j', x: -1, y: 0 });
  g.onMessage(4, { t: 's.j', x: -1, y: 0 });
  check(S.w[0].ix === 1 && S.w[1].ix === 0, 'La tele y quien no juega no mueven a nadie');
  g.onMessage(0, { t: 's.j', x: 0, y: 0 });
  // Dash: accepted once, then cooldown
  mark = api.sent.length;
  g.onMessage(1, { t: 's.d' });
  let cd = api.toSlot.filter(function (x) { return x.t === 's.cd'; }).pop();
  check(cd.ok === true && cd._to === 1 && cd.ms === 2000 && S.w[1].dash > 0 && evs(api, 'dash', mark).length === 1 && evs(api, 'dash', mark)[0].w === 2, '«¡Embestida!» de Berto: aceptada, aviso a todos y 2000 ms de recarga para su móvil');
  g.onMessage(1, { t: 's.d' });
  cd = api.toSlot.filter(function (x) { return x.t === 's.cd'; }).pop();
  check(cd.ok === false && cd.ms > 1900, 'Otra enseguida: rechazada, quedan ' + cd.ms + ' ms');
  g.flush();
  check(lastMeta(api).cd[1] > 1900 && lastMeta(api).cd[0] === 0, 'El estado lleva la recarga de cada uno (para quien se reconecta)');
  // 30 Hz state for the TV
  const nTv = api.tv.length;
  run(g, 1);
  const states = api.tv.slice(nTv).filter(function (x) { return x.t === 's'; });
  check(states.length >= 29 && states.length <= 31 && states[0].w.length === 12, 'Estado compacto a 30 Hz para la tele (' + states.length + ' en 1 s, 6 números por luchador)');
  // A real collision in the game: Berto dashed towards Ana
  check(evs(api, 'hit', mark).length >= 1, 'Berto embiste y choca con Ana: evento «hit» (p=' + (evs(api, 'hit', mark)[0] || {}).p + ', fuerte=' + (evs(api, 'hit', mark)[0] || {}).big + ')');

  console.log('\n[Rondas: fuera, empate en el mismo instante, a 3]');
  mark = api.sent.length;
  throwOut(g, 1);
  run(g, DT);
  m = lastMeta(api);
  check(S.phase === 'roundover' && S.score.join() === '1,0' && S.result.w === 1 && evs(api, 'out', mark).length === 1 && evs(api, 'out', mark)[0].w.join() === '2', 'Berto sale del círculo: ronda para Ana (1-0)');
  g.flush();
  check(lastMeta(api).phase === 'roundover' && lastMeta(api).result.w === 1, 'La tele y los móviles saben quién ha ganado la ronda');
  g.onMessage(0, { t: 's.j', x: 1, y: 0 });
  check(S.w[0].ix === 0, 'Entre rondas el joystick no cuenta');
  S.w[0].vx = 800;
  S.w[1].vx = 800;
  run(g, 0.5);
  check(speed(S.w[0]) < 60 && speed(S.w[1]) > 100, 'La ganadora frena en seco y el que ha caído sigue deslizándose');
  run(g, 4, function () { return S.phase === 'countdown'; });
  check(S.phase === 'countdown' && S.round === 2 && S.w[0].x < P.CX && S.w[1].x > P.CX && !S.w[1].out && S.w[1].cd === 0, 'Ronda 2: otra cuenta atrás, cada uno a su sitio y la recarga a cero');
  toPlaying(g);
  // Same tick: draw
  mark = api.sent.length;
  throwOut(g, 0);
  throwOut(g, 1);
  run(g, DT);
  check(S.phase === 'roundover' && S.result.w === 0 && S.score.join() === '1,0' && S.draws === 1 && evs(api, 'out', mark)[0].w.join() === '1,2', 'Los dos fuera en el mismo paso: empate, nadie suma');
  run(g, 4, function () { return S.phase === 'countdown'; });
  check(S.round === 3, 'Y se repite (ronda 3)');
  // Only one out: the other one is still inside
  toPlaying(g);
  S.w[0].x = P.CX + P.R0 - 10;
  S.w[0].y = P.CY;
  S.w[1].x = P.CX + P.R0 + 70;
  S.w[1].y = P.CY;
  run(g, DT);
  check(S.result && S.result.w === 1 && S.score.join() === '2,0', 'Ana justo en el borde y Berto fuera: ronda para Ana (2-0)');
  run(g, 4, function () { return S.phase === 'countdown'; });
  toPlaying(g);
  throwOut(g, 0);
  run(g, DT);
  check(S.score.join() === '2,1', 'Ana se sale: ronda para Berto (2-1)');
  run(g, 4, function () { return S.phase === 'countdown'; });
  // The ring shrinks with the time of play (not during the countdown)
  check(S.roundT === 0, 'El reloj de la ronda empieza a cero');
  toPlaying(g);
  run(g, 16);
  const lastS = api.tv.filter(function (x) { return x.t === 's'; }).pop();
  check(S.phase === 'playing' && near(lastS.R, Ph.ringRadius(S.roundT), 1) && lastS.R < P.R0 - 100, 'A los 16 s de ronda el círculo ha encogido (radio ' + lastS.R + ')');
  run(g, 20, function () { return S.phase !== 'playing'; });
  check(S.phase === 'roundover' && S.roundT < 32, 'Sin moverse, el círculo encoge hasta que alguien cae (a los ' + S.roundT.toFixed(1) + ' s)');
  run(g, 4, function () { return S.phase === 'countdown'; });
  const sc = S.score.slice();
  toPlaying(g);
  mark = api.sent.length;
  const leader = sc[0] >= sc[1] ? 0 : 1;
  for (let k = 0; S.phase !== 'end' && k < 6; k++) {
    throwOut(g, 1 - leader);
    run(g, DT);
    run(g, 4, function () { return S.phase === 'countdown' || S.phase === 'end'; });
    if (S.phase === 'countdown') toPlaying(g);
  }
  g.flush();
  m = lastMeta(api);
  check(S.phase === 'end' && m.phase === 'end' && m.winner === leader + 1 && m.score[leader] === 3 && evs(api, 'win', mark).length === 1, 'Quien llega a 3 gana el combate (' + m.score.join('-') + ', gana ' + (leader ? 'Berto' : 'Ana') + ')');
  run(g, 3);
  check(S.phase === 'end', 'El final se queda quieto hasta que piden otra');
  g.onMessage(-1, { t: 's.again' });
  g.flush();
  m = lastMeta(api);
  check(m.match === 2 && m.phase === 'countdown' && m.score.join() === '0,0' && m.round === 1 && m.draws === 0, '«Otra» (también desde la tele): combate nuevo, 0-0');
  g.onMessage(0, { t: 's.again' });
  check(lastMeta(api).match === 2 && g._state.match === 2, '«Otra» a mitad de combate no hace nada');
}

function unitPause() {
  console.log('\n[Pausa, reconexión y alguien que se va]');
  const api = fakeApi([0, 1], { 0: 'Ana', 1: 'Berto' });
  const g = Sumo.create(api);
  g.start();
  const S = g._state;
  toPlaying(g);
  g.onMessage(0, { t: 's.j', x: 1, y: 0 });
  run(g, 0.5);
  const t0 = S.roundT, x0 = S.w[0].x;
  // Berto's phone drops
  api.conn[1] = false;
  g.onPlayerDisconnected(1);
  g.flush();
  let m = lastMeta(api);
  check(S.phase === 'paused' && m.phase === 'paused' && m.waiting.join() === 'Berto', 'Se cae el móvil de Berto: pausa, esperando a Berto');
  run(g, 2);
  check(S.w[0].x === x0 && S.roundT === t0, 'En pausa todo se congela (posiciones y reloj del círculo)');
  api.conn[1] = true;
  g.onPlayerJoined(1, true);
  const toBerto = api.toSlot.filter(function (x) { return x._to === 1 && x.t === 'smeta'; }).pop();
  check(!!toBerto && toBerto.phase === 'paused', 'Al reconectar, su móvil recibe el estado');
  run(g, DT);
  g.flush();
  m = lastMeta(api);
  check(m.phase === 'countdown' && m.resumed === true && S.w[0].x === x0, 'Vuelve: cuenta atrás «Seguimos…» sin recolocar a nadie');
  toPlaying(g);
  check(S.roundT === t0 && S.round === 1, 'Y la ronda sigue donde estaba');
  // Pause during roundover: resumes the roundover
  throwOut(g, 1);
  run(g, DT);
  run(g, 1);
  const left = S.timer;
  api.conn[0] = false;
  g.onPlayerDisconnected(0);
  run(g, 1);
  check(S.phase === 'paused' && S.w[0].ix === 0, 'Pausa también entre rondas (y el joystick de quien se va se suelta)');
  api.conn[0] = true;
  run(g, DT);
  check(S.phase === 'roundover' && near(S.timer, left, 0.05) && S.score.join() === '1,0', 'Al volver, sigue el «fin de ronda» donde estaba');
  // A spectator arrives and leaves: nothing changes
  api.setPlayers([0, 1, 2]);
  api.conn[2] = true;
  g.onPlayerJoined(2, false);
  g.onMessage(2, { t: 's.j', x: 1, y: 1 });
  g.onMessage(2, { t: 's.d' });
  check(S.order.join() === '0,1' && api.toSlot.filter(function (x) { return x._to === 2 && x.t === 's.cd'; }).length === 0, 'Quien llega a mitad mira (sus mandos no hacen nada)');
  api.conn[2] = false;
  g.onPlayerDisconnected(2);
  run(g, DT);
  check(S.phase !== 'paused', 'Si se cae el móvil de quien mira, no hay pausa');
  api.conn[2] = true;
  // A wrestler leaves for good while someone watches: the spectator takes the place
  api.setPlayers([0, 2]);
  delete api.conn[1];
  check(g.onPlayerLeft(1) !== false, 'Berto se va del todo (con Carla mirando): la partida sigue');
  g.flush();
  m = lastMeta(api);
  check(m.slots.join() === '1,3' && m.score.join() === '0,0' && m.phase === 'countdown' && m.match === 2, 'Combate nuevo: Ana contra Carla');
  // (With a single player left the hub goes back to the menu: see the server test)
}

// ---------------------------------------------------------------- the real server
async function integration() {
  console.log('\n[Servidor: estado a 30 Hz, mandos, pausa y reconexión, un combate entero]');
  const PORT = 3961;
  const WS = 'ws://127.0.0.1:' + PORT + '/ws';
  const HOME = H_.tmpHome('g2t-sumo-');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '1500', SUMO_DEBUG_SPEED: '4' });
  const clients = [];
  function meta(c) { return c.find('smeta'); }
  try {
    const tv = H_.makeClient(WS, 'tele'); clients.push(tv);
    await tv.ready;
    tv.send({ t: 'hello', role: 'tv' });
    await H_.waitUntil(function () { return tv.hub; }, 2000, 'hub');
    const ana = await H_.phone(WS, 'Ana', 's-ana'); clients.push(ana);
    ana.send({ t: 'pick', game: 'sumo' });
    const need = await ana.wait(function (m) { return m.t === 'ev' && m.k === 'need2'; }, 1500, 'need2');
    check(!!need && /para 2 jugadores/.test(need.text), 'Con 1 solo móvil no se puede: «' + (need && need.text) + '»');
    const berto = await H_.phone(WS, 'Berto', 's-berto'); clients.push(berto);
    await H_.waitUntil(function () { return tv.hub.ready; }, 2000, 'ready');
    const t0 = tv.mark();
    berto.send({ t: 'pick', game: 'sumo' });
    const cd = await tv.wait(function (m) { return m.t === 'smeta' && m.phase === 'countdown'; }, 2000, 'cuenta atrás', t0);
    check(!!cd && cd.slots.join() === '1,2' && tv.hub.screen === 'sumo', 'Berto elige «Sumo»: cuenta atrás para Ana contra Berto');
    check(!!(await ana.wait(function (m) { return m.t === 'smeta'; }, 1000, 'smeta móvil')), 'Los móviles reciben el estado');
    await tv.wait(function (m) { return m.t === 'smeta' && m.phase === 'playing'; }, 3000, 'a jugar', t0);
    // State at ~30 Hz (only to the TV)
    let n = 0;
    const onMsg = function (d) { if (JSON.parse(d.toString()).t === 's') n++; };
    tv.ws.on('message', onMsg);
    await H_.sleep(1000);
    tv.ws.removeListener('message', onMsg);
    check(n >= 24 && n <= 36, 'La tele recibe ~30 estados por segundo (' + n + ')');
    check(!ana.msgs.some(function (m) { return m.t === 's'; }), 'Los móviles no reciben el estado de 30 Hz (solo mandan)');
    // Joystick: Ana goes right, into Berto
    const xa = tv.state.w[0];
    ana.send({ t: 's.j', x: 1, y: 0 });
    const moved = await H_.waitUntil(function () { return tv.state && tv.state.w[0] > xa + 50; }, 1500, 'Ana se mueve');
    check(!!moved, 'Joystick de Ana: su luchadora avanza (' + Math.round(xa) + ' → ' + Math.round(tv.state.w[0]) + ')');
    const hit = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'hit'; }, 2000, 'choque', t0);
    check(!!hit && hit.p > 0 && hit.x > 0 && hit.ts > 0, 'Chocan: la tele recibe el golpe (p=' + (hit && hit.p) + ') para el polvo y el temblor');
    const tb = berto.mark();
    berto.send({ t: 's.d' });
    const scd = await berto.wait(function (m) { return m.t === 's.cd'; }, 1000, 's.cd', tb);
    check(!!scd && scd.ok === true && scd.ms === 2000, 'Embestida de Berto: su móvil recibe la recarga (2000 ms)');
    check(!!(await berto.wait(function (m) { return m.t === 'ev' && m.k === 'hit'; }, 1000, 'hit móvil', 0)), 'Los móviles reciben los golpes (para vibrar)');
    // Pause and reconnection
    ana.send({ t: 's.j', x: 0, y: 0 });
    const tp = tv.mark();
    await berto.close();
    const paused = await tv.wait(function (m) { return m.t === 'smeta' && m.phase === 'paused'; }, 2000, 'pausa', tp);
    check(!!paused && paused.waiting.join() === 'Berto', 'Se cae el móvil de Berto: pausa esperando a Berto');
    const frozen = tv.state.w.slice(0, 2).join();
    await H_.sleep(300);
    check(tv.state.w.slice(0, 2).join() === frozen, 'En pausa nadie se mueve');
    const berto2 = await H_.phone(WS, 'Berto', 's-berto'); clients.push(berto2);
    check(!!berto2.find('joined').reconnect, 'Berto vuelve con el mismo móvil');
    const resumed = await tv.wait(function (m) { return m.t === 'smeta' && m.phase === 'countdown' && m.resumed; }, 2000, 'sigue', tp);
    check(!!resumed, 'Cuenta atrás «Seguimos…»');
    check(!!(await berto2.wait(function (m) { return m.t === 'smeta'; }, 1000, 'smeta al volver')), 'Su móvil recibe el estado al volver');
    await tv.wait(function (m) { return m.t === 'smeta' && m.phase === 'playing'; }, 3000, 'juego', tp);
    // A whole match: Ana pushes and dashes at every chance, Berto stands still
    const tm = tv.mark();
    ana.send({ t: 's.j', x: 1, y: 0 });
    const dashTimer = setInterval(function () { ana.send({ t: 's.d' }); ana.send({ t: 's.j', x: 1, y: 0 }); }, 200);
    const end = await tv.wait(function (m) { return m.t === 'smeta' && m.phase === 'end'; }, 40000, 'fin del combate', tm);
    clearInterval(dashTimer);
    const rounds = tv.since(tm, 'smeta').filter(function (m) { return m.phase === 'roundover'; }).map(function (m) { return m.round; }).filter(function (r, i, a) { return a.indexOf(r) === i; });
    check(!!end && end.winner === 1 && end.score[0] === 3, 'Combate entero: gana Ana ' + (end && end.score.join('-')) + ' (' + rounds.length + ' rondas)');
    check(!!(await berto2.wait(function (m) { return m.t === 'smeta' && m.phase === 'end'; }, 1000, 'fin móvil')), 'Los móviles reciben el final');
    check(tv.since(tm).some(function (m) { return m.t === 'ev' && m.k === 'win' && m.w === 1; }), 'Aviso «win» (confeti en la tele)');
    // Another match from a phone
    const ta = tv.mark();
    berto2.send({ t: 's.again' });
    const again = await tv.wait(function (m) { return m.t === 'smeta' && m.match === end.match + 1; }, 2000, 'otra', ta);
    check(!!again && again.score.join() === '0,0', '«Otra» desde el móvil de Berto');
    // A third phone watches; then Berto leaves for good: Carla takes the place
    const carla = await H_.phone(WS, 'Carla', 's-carla'); clients.push(carla);
    const cm = await carla.wait(function (m) { return m.t === 'smeta'; }, 1500, 'smeta Carla');
    check(!!cm && cm.slots.join() === '1,2', 'Carla llega a mitad: recibe el estado y mira');
    const tl = tv.mark();
    berto2.send({ t: 'leave' });
    const left = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'left'; }, 2000, 'left', tl);
    const nm = await tv.wait(function (m) { return m.t === 'smeta' && m.slots.join() === '1,3'; }, 2000, 'nuevo combate', tl);
    check(!!left && !!nm && nm.score.join() === '0,0' && tv.hub.screen === 'sumo', 'Berto se va: sigue el juego, ahora Ana contra Carla');
    // Carla leaves too: only Ana remains, back to the menu
    const tq = tv.mark();
    carla.send({ t: 'leave' });
    const menuEv = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'menu'; }, 2000, 'menú', tq);
    check(!!menuEv && /Carla se ha ido/.test(menuEv.text) && tv.hub.screen === 'menu', 'Se va Carla y queda una sola: vuelta al menú («' + (menuEv && menuEv.text) + '»)');
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
  physics();
  unitGame();
  unitPause();
  await integration();
  check.done();
})();
