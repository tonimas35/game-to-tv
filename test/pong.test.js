'use strict';
/*
 * Pong unit tests with a fake hub API (no server): the classic layout for 2,
 * doubles for 3 and 4 (paddles, ownership, one-way collisions, no tunnelling
 * at any speed, team score).
 */
const H_ = require('./helpers');
const check = H_.checker('Pong: clásico y dobles');
const Pong = require('../src/games/pong');
const F = Pong.FIELD;
const DT = 1 / 60;

function fakeApi(players, connected) {
  const sent = [];
  const tvSent = [];
  return {
    sent: sent, tvSent: tvSent,
    slots: 6,
    tvs: new Set([1]),
    players: function () { return players.slice(); },
    isConnected: function (i) { return !connected || connected.indexOf(i) >= 0; },
    allConnected: function () { return true; },
    bothConnected: function () { return true; },
    name: function (i) { return 'J' + (i + 1); },
    broadcast: function (m) { sent.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendTvs: function (m) { tvSent.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendSlot: function () {}, sendWs: function () {}, log: function () {}
  };
}
function yForT(t, h) { return h / 2 + t * (F.h - h); }
// Puts paddle k at y (and keeps it there: the target matches)
function park(g, k, y) {
  const h = g._state.pads[k].h;
  g._state.targets[k] = (y - h / 2) / (F.h - h);
  g._state.paddles[k] = y;
}
function serve(g, x, y, vx, vy) {
  const b = g._state.ball;
  b.x = x; b.y = y; b.vx = vx; b.vy = vy || 0; b.speed = Math.hypot(vx, vy || 0);
  g._state.phase = 'playing';
}
function hitsOf(api, from) { return api.sent.slice(from).filter(function (m) { return m.k === 'hit'; }); }
function run(g, steps, until) { for (let i = 0; i < steps; i++) { g.tick(DT); if (until && until()) return i + 1; } return steps; }

console.log('\n[Disposición]');
const two = Pong.layoutPaddles([0, 1]);
check(two.length === 2 && two[0].x === 70 && two[1].x === 1850 && two[0].h === 180 && two[1].h === 180 && two[0].side === 0 && two[1].side === 1,
  '2 jugadores: el clásico (palas en x=70 y x=1850, 180 de alto)');
const three = Pong.layoutPaddles([0, 1, 2]);
check(three.length === 3 && three[1].role === 'solo' && three[1].h === F.soloH && three[1].x === 1850 && three[0].h === F.doublesH && three[2].x === F.forwardX && three[2].side === 0,
  '3 jugadores: J1 portería y J3 delantera a la izquierda; J2 solo a la derecha con una pala más larga (' + F.soloH + ')');
const four = Pong.layoutPaddles([0, 1, 2, 3]);
check(four.length === 4 && four[3].x === 1920 - F.forwardX && four[3].side === 1 && four.every(function (p) { return p.h === F.doublesH; }),
  '4 jugadores: dos palas por lado (portería y delantera), ' + F.doublesH + ' de alto');
const gaps = Pong.layoutPaddles([0, 2]);
check(gaps[0].slot === 0 && gaps[1].slot === 2, 'Con huecos (J1 y J3) cada uno tiene su pala sin compactar');

console.log('\n[Dobles: palas y propiedad]');
{
  const api = fakeApi([0, 1, 2, 3]);
  const g = Pong.create(api);
  g.start();
  const meta = api.sent.filter(function (m) { return m.t === 'pmeta'; }).pop();
  check(meta && meta.mode === 'dobles' && meta.paddles.length === 4 && meta.teams[0].join() === '1,3' && meta.teams[1].join() === '2,4',
    'pmeta: modo dobles, equipos [1,3] contra [2,4]');
  g.onMessage(2, { t: 'm', y: 0 });
  g.onMessage(3, { t: 'm', y: 1 });
  check(g._state.targets[2] === 0 && g._state.targets[3] === 1 && g._state.targets[0] === 0.5, 'Cada móvil mueve solo su pala (J3 -> delantera izquierda, J4 -> delantera derecha)');
  const p = api.tvSent.filter(function (m) { return m.t === 'p'; });
  check(p.length === 2 && p[0].i === 2 && p[1].i === 3, 'La tele recibe la pala al instante con su índice de pala');
  g.onMessage(5, { t: 'm', y: 0 });
  check(api.tvSent.filter(function (m) { return m.t === 'p'; }).length === 2, 'Un móvil sin pala (entró a mitad) no mueve nada');

  console.log('\n[Dobles: choques]');
  g._state.phase = 'playing';
  park(g, 0, 540); park(g, 2, 540); park(g, 1, 540); park(g, 3, 540);
  // 1. La delantera izquierda para una bola que va hacia su portería
  let mark = api.sent.length;
  serve(g, 800, 540, -1200, 0);
  run(g, 60, function () { return g._state.ball.vx > 0; });
  let h = hitsOf(api, mark);
  check(h.length === 1 && h[0].paddle === 2 && h[0].slot === 3 && h[0].side === 1 && Math.abs(g._state.ball.x - (F.forwardX + 12 + 14.5)) < 1,
    'La delantera izquierda devuelve la bola (choque en su cara, sin atravesarla)');
  // 2. Por detrás la bola atraviesa las palas propias
  mark = api.sent.length;
  serve(g, 300, 540, 1200, 0);
  run(g, 20);
  check(hitsOf(api, mark).length === 0 && g._state.ball.x > F.forwardX + 100, 'Por detrás, la bola atraviesa la pala de su propio equipo');
  // 3. Lo que no para la delantera lo para la de portería
  park(g, 2, 100);
  mark = api.sent.length;
  serve(g, 800, 540, -1200, 0);
  run(g, 90, function () { return g._state.ball.vx > 0; });
  h = hitsOf(api, mark);
  check(h.length === 1 && h[0].paddle === 0 && h[0].slot === 1, 'Si la delantera no llega, para la de portería');
  // 4. Sin efecto túnel a cualquier velocidad (100 px por paso)
  park(g, 2, 540);
  mark = api.sent.length;
  serve(g, 800, 540, -6000, 0);
  run(g, 10, function () { return g._state.ball.vx > 0; });
  h = hitsOf(api, mark);
  check(h.length === 1 && h[0].paddle === 2 && g._state.ball.x > F.forwardX, 'A 6000 px/s (100 px por paso) la delantera no se atraviesa');
  // 5. Lado derecho, rebote con ángulo en el borde de la pala
  mark = api.sent.length;
  park(g, 3, 540);
  serve(g, 1000, 540 + 60, 1200, 0);
  run(g, 60, function () { return g._state.ball.vx < 0; });
  h = hitsOf(api, mark);
  check(h.length === 1 && h[0].paddle === 3 && g._state.ball.vy > 0, 'La delantera derecha devuelve hacia la izquierda, con ángulo según dónde da');
  // 6. Puntos de equipo
  park(g, 0, 100); park(g, 2, 100);
  mark = api.sent.length;
  serve(g, 800, 900, -1200, 0);
  run(g, 120, function () { return g._state.score[1] > 0; });
  const sc = api.sent.slice(mark).filter(function (m) { return m.k === 'score'; })[0];
  check(g._state.score.join() === '0,1' && sc && sc.side === 2 && sc.slot === 2, 'Gol en la portería izquierda: punto para el equipo de la derecha');
}

console.log('\n[Tres jugadores]');
{
  const api = fakeApi([0, 1, 2]);
  const g = Pong.create(api);
  g.start();
  const meta = api.sent.filter(function (m) { return m.t === 'pmeta'; }).pop();
  check(meta.paddles.length === 3 && meta.paddles[1].role === 'solo' && meta.paddles[1].slot === 2 && meta.teams[1].join() === '2', 'J2 juega solo a la derecha');
  g._state.phase = 'playing';
  park(g, 1, 540);
  const mark = api.sent.length;
  serve(g, 1000, 540 + F.soloH / 2 + 5, 1200, 0); // fuera de una pala normal (75) pero dentro de la larga (115)
  run(g, 90, function () { return g._state.ball.vx < 0; });
  const h = hitsOf(api, mark);
  check(h.length === 1 && h[0].paddle === 1, 'La pala larga del que juega solo alcanza más');
  check(yForT(1, F.soloH) === F.h - F.soloH / 2, 'La pala larga recorre todo el alto');
}

console.log('\n[Dos jugadores: el clásico de siempre]');
{
  const api = fakeApi([0, 1]);
  const g = Pong.create(api);
  g.start();
  g.flush();
  const st = api.tvSent.filter(function (m) { return m.t === 's'; }).pop();
  const meta = api.sent.filter(function (m) { return m.t === 'pmeta'; }).pop();
  check(meta.mode === 'clasico' && st.p.length === 2 && g._state.pads[0].x === 70 && g._state.pads[1].x === 1850, 'Modo clásico: 2 palas, estado igual que antes');
  g._state.phase = 'playing';
  park(g, 1, 540);
  const mark = api.sent.length;
  serve(g, 1500, 540, 1500, 0);
  run(g, 60, function () { return g._state.ball.vx < 0; });
  const h = hitsOf(api, mark);
  check(h.length === 1 && h[0].slot === 2 && h[0].paddle === 1, 'El jugador 2 devuelve la bola como siempre');
  // Disconnected player pauses; a paddle-less phone does not
  const api2 = fakeApi([0, 1], [0, 1]);
  const g2 = Pong.create(api2);
  g2.start();
  check(g2._state.phase === 'countdown', 'Con los dos conectados empieza la cuenta atrás');
  g2.onPlayerDisconnected(4);
  check(g2._state.phase === 'countdown', 'Si se desconecta alguien sin pala, no se pausa');
  g2.onPlayerDisconnected(1);
  check(g2._state.phase === 'paused', 'Si se desconecta un jugador con pala, pausa');
}

check.done();
