'use strict';
/*
 * «Tanques»: the arenas (symmetric, no spawn in sight of the other, all
 * reachable), the physics (bounce angles, no tunnelling through thin walls,
 * bullet lifetime and bounce limit, tanks vs walls), the game with a fake hub
 * API (inputs, fire limits, self-kill, the simultaneous-death draw, rounds
 * and the duel to 5, pause on disconnect and resume, a player leaving) and
 * the real server with fake phones and a fake TV (30 Hz state, inputs,
 * pause, reconnection, leaving).
 */
const H_ = require('./helpers');
const Game = require('../src/games/tanques');
const Sim = require('../src/games/tanques/sim');
const Layouts = require('../src/games/tanques/layouts');
const check = H_.checker('Tanques');

const DT = 1 / 60;
const C = Sim.C;
const NAMES = ['Ana', 'Berto', 'Carla', 'Dani', 'Eva', 'Fede'];
const near = function (a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); };

function fakeApi(players) {
  const api = {
    sent: [], tvSent: [], slotSent: [], logs: [],
    list: players.slice(), conn: {},
    slots: 6,
    tvs: new Set([1]),
    players: function () { return api.list.slice(); },
    isConnected: function (i) { return api.conn[i] !== false; },
    allConnected: function () { return api.list.every(function (i) { return api.conn[i] !== false; }); },
    name: function (i) { return NAMES[i]; },
    broadcast: function (m) { api.sent.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendTvs: function (m) { api.tvSent.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendSlot: function (i, m) { api.slotSent.push({ i: i, m: m }); },
    sendWs: function () {},
    log: function (s) { api.logs.push(s); }
  };
  return api;
}
function metas(api) { return api.sent.filter(function (m) { return m.t === 'kmeta'; }); }
function lastMeta(api) { const m = metas(api); return m[m.length - 1]; }
function step(g, n) { for (let i = 0; i < n; i++) { g.tick(DT); g.flush(); } }
function runFor(g, s) { step(g, Math.round(s / DT)); }
function runUntil(g, fn, maxS) {
  const n = Math.round((maxS || 10) / DT);
  for (let i = 0; i < n; i++) { g.tick(DT); g.flush(); if (fn()) return (i + 1) * DT; }
  return -1;
}
// A layout with nothing inside (spawns in two corners)
function emptyLayout() {
  return Layouts.build({ name: 'Vacío', top: ['........................', '.A......................', '........................', '........................', '........................', '........................'] }, 0);
}
function worldWith(walls) { return Sim.makeWorld({ walls: walls }, 1920, 960); }
function bullet(x, y, vx, vy, owner) { return { id: 900 + Math.floor(Math.random() * 1000), owner: owner == null ? 9 : owner, x: x, y: y, vx: vx, vy: vy, age: 0, bounces: 0, safe: false }; }

// ---------------------------------------------------------------- arenas
function arenas() {
  console.log('\n[Mapas]');
  const W = Layouts.W, H = Layouts.H;
  check(Layouts.LIST.length >= 4, Layouts.LIST.length + ' mapas hechos a mano: ' + Layouts.LIST.map(function (l) { return l.name; }).join(', '));
  Layouts.LIST.forEach(function (lay) {
    const w = Sim.makeWorld(lay, W, H);
    const key = function (r) { return [r.x0, r.y0, r.x1, r.y1].join(','); };
    const set = {};
    lay.walls.forEach(function (r) { set[key(r)] = true; });
    const sym = lay.walls.every(function (r) { return set[key({ x0: W - r.x1, y0: H - r.y1, x1: W - r.x0, y1: H - r.y0 })]; });
    const s = lay.spawns;
    const spawnSym = near(s[1].x, W - s[0].x) && near(s[1].y, H - s[0].y) && near(Math.abs(Sim.angleDiff(s[1].a, s[0].a)), Math.PI);
    check(sym && spawnSym, '«' + lay.name + '»: simétrico al girarlo 180° (paredes y salidas)');
    check(!Sim.lineOfSight(w, s[0].x, s[0].y, s[1].x, s[1].y, C.BULLET_R), '«' + lay.name + '»: desde una salida no se ve la otra (una bala recta no llega)');
    const clear = s.every(function (p) {
      return w.walls.every(function (b) {
        const qx = Math.max(b.x0, Math.min(p.x, b.x1)), qy = Math.max(b.y0, Math.min(p.y, b.y1));
        return Math.hypot(p.x - qx, p.y - qy) >= C.TANK_R + 8;
      });
    });
    check(clear && lay.walls.every(function (r) { return r.x0 >= 0 && r.y0 >= 0 && r.x1 <= W && r.y1 <= H && r.x1 > r.x0 && r.y1 > r.y0; }), '«' + lay.name + '»: salidas despejadas y paredes dentro de la arena (' + lay.walls.length + ' bloques)');
    // A tank can drive from one spawn to the other (centres on a 10-unit grid)
    const G = 10, nx = W / G, ny = H / G;
    function free(x, y) {
      if (x < C.TANK_R || y < C.TANK_R || x > W - C.TANK_R || y > H - C.TANK_R) return false;
      return lay.walls.every(function (b) { const qx = Math.max(b.x0, Math.min(x, b.x1)), qy = Math.max(b.y0, Math.min(y, b.y1)); return (x - qx) * (x - qx) + (y - qy) * (y - qy) >= C.TANK_R * C.TANK_R; });
    }
    const seen = new Uint8Array(nx * ny);
    const q = [[Math.round(s[0].x / G), Math.round(s[0].y / G)]];
    seen[q[0][1] * nx + q[0][0]] = 1;
    while (q.length) {
      const c = q.pop();
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        const X = c[0] + d[0], Y = c[1] + d[1];
        if (X < 0 || Y < 0 || X >= nx || Y >= ny || seen[Y * nx + X] || !free(X * G, Y * G)) return;
        seen[Y * nx + X] = 1;
        q.push([X, Y]);
      });
    }
    check(!!seen[Math.round(s[1].y / G) * nx + Math.round(s[1].x / G)], '«' + lay.name + '»: se puede ir en tanque de una salida a la otra');
  });
}

// ---------------------------------------------------------------- physics
function physics() {
  console.log('\n[Rebotes]');
  const wall = { x0: 1000, y0: 200, x1: 1020, y1: 800 };        // thin vertical wall, 20 thick
  const w1 = worldWith([wall]);
  const v = C.BULLET_SPEED;
  function fly(b, world, secs) {
    let bounces = [];
    for (let i = 0; i < Math.round(secs / DT); i++) {
      const r = Sim.moveBullet(world, b, DT, [], function (x, y) { bounces.push([x, y]); });
      if (r) return { r: r, bounces: bounces };
    }
    return { r: null, bounces: bounces };
  }
  let b = bullet(900, 400, v * Math.cos(Math.PI / 6), v * Math.sin(Math.PI / 6));
  let f = fly(b, w1, 0.4);
  const out = Math.atan2(b.vy, b.vx);
  check(f.bounces.length === 1 && near(f.bounces[0][0], 1000 - C.BULLET_R, 1e-6) && near(out, Math.PI - Math.PI / 6, 1e-9) && near(Math.hypot(b.vx, b.vy), v, 1e-9),
    'Pared vertical: entra a 30°, sale a 150° (ángulo de entrada = de salida), misma velocidad, rebota en x = ' + (f.bounces[0] && f.bounces[0][0].toFixed(2)));
  check(b.x < 1000 - C.BULLET_R && b.vx < 0 && b.vy > 0, 'Tras el rebote vuelve hacia la izquierda y sigue bajando');
  const floor = { x0: 300, y0: 600, x1: 1500, y1: 620 };
  b = bullet(400, 500, v * Math.cos(Math.PI / 4), v * Math.sin(Math.PI / 4));
  f = fly(b, worldWith([floor]), 0.3);
  check(f.bounces.length === 1 && near(f.bounces[0][1], 600 - C.BULLET_R, 1e-6) && b.vy < 0 && b.vx > 0 && near(Math.atan2(b.vy, b.vx), -Math.PI / 4, 1e-9), 'Pared horizontal: a 45° hacia abajo, sale a 45° hacia arriba');
  // Exactly into a corner: both components flip (it comes back the same way)
  const box = { x0: 1000, y0: 400, x1: 1100, y1: 500 };
  const g = C.BULLET_R;
  b = bullet(1000 - g - 100, 400 - g - 100, v / Math.SQRT2, v / Math.SQRT2);
  f = fly(b, worldWith([box]), 0.4);
  check(f.bounces.length === 1 && b.vx < 0 && b.vy < 0 && near(Math.atan2(b.vy, b.vx), -3 * Math.PI / 4, 1e-9), 'Justo en la esquina: vuelve por donde vino (se invierten las dos componentes)');
  // The arena edges bounce too
  b = bullet(1900, 100, v, 0);
  f = fly(b, worldWith([]), 0.1);
  check(f.bounces.length === 1 && b.vx < 0 && near(f.bounces[0][0], 1920 - C.BULLET_R, 1e-6), 'El borde de la arena también rebota');

  console.log('\n[Sin efecto túnel]');
  let ok = true;
  [600, 6000, 30000, 120000].forEach(function (speed) {
    const bb = bullet(900, 500, speed, 0);
    let first = true;
    for (let i = 0; i < 60; i++) {
      const r = Sim.moveBullet(w1, bb, DT, [], null);
      if (bb.x > 1000 - C.BULLET_R + 1e-6) ok = false;
      if (first && bb.bounces > 0) { first = false; if (bb.vx > 0 && bb.bounces === 1) ok = false; }
      if (r) break;
    }
    if (first) ok = false;
  });
  check(ok, 'A 600, 6000, 30000 y 120000 u/s (hasta 2000 u por paso) la bala nunca atraviesa una pared de 20');
  // Diagonal, fast, between two thin walls close together: always inside the corridor
  const corridor = worldWith([{ x0: 600, y0: 0, x1: 620, y1: 960 }, { x0: 700, y0: 0, x1: 720, y1: 960 }]);
  const bc = bullet(660, 480, 40000, 31000);
  let inside = true;
  for (let i = 0; i < 30; i++) {
    const r = Sim.moveBullet(corridor, bc, DT, [], null);
    if (r && r.gone) break;
    if (bc.x < 620 || bc.x > 700) inside = false;
  }
  check(inside, 'Rápida y en diagonal entre dos paredes finas a 80: rebota dentro, sin salirse');
  // Sweep against a tank: hit even if it would pass through it in one step
  const tk = { id: 1, x: 1400, y: 500, alive: true };
  const fast = bullet(1200, 500, 60000, 0);
  const hit = Sim.moveBullet(worldWith([]), fast, DT, [tk], null);
  check(hit && hit.tank === tk && near(fast.x, 1400 - C.TANK_R - C.BULLET_R, 1e-6), 'Una bala muy rápida no atraviesa un tanque: choca en su borde');

  console.log('\n[Vida y rebotes de las balas]');
  // Between two walls: 5 bounces, the 6th contact removes it
  b = bullet(500, 480, v, 0);
  f = fly(b, worldWith([{ x0: 380, y0: 0, x1: 400, y1: 960 }, { x0: 600, y0: 0, x1: 620, y1: 960 }]), 6);
  check(f.bounces.length === C.MAX_BOUNCES && f.r && f.r.gone && b.bounces === 5, 'Rebota ' + f.bounces.length + ' veces y al tocar la pared la sexta vez desaparece');

  console.log('\n[Tanques contra paredes]');
  const tw = worldWith([{ x0: 800, y0: 300, x1: 820, y1: 700 }]);
  const t = { x: 700, y: 500, a: 0 };
  let minGap = Infinity;
  for (let i = 0; i < 180; i++) {
    Sim.driveTank(tw, t, { mode: 'k', turn: 0, drive: 1 }, DT);
    minGap = Math.min(minGap, 800 - t.x);
  }
  check(near(t.x, 800 - C.TANK_R, 1e-6) && minGap >= C.TANK_R - 1e-6, 'Contra una pared fina se para en su borde (círculo contra caja), sin atravesarla');
  const t2 = { x: 790, y: 290, a: Math.PI / 4 };
  for (let i = 0; i < 120; i++) Sim.driveTank(tw, t2, { mode: 's', a: Math.PI / 4, m: 1 }, DT);
  const qx = Math.max(800, Math.min(t2.x, 820)), qy = Math.max(300, Math.min(t2.y, 700));
  check(Math.hypot(t2.x - qx, t2.y - qy) >= C.TANK_R - 1e-6, 'En la esquina de una pared resbala y no se mete dentro');
  const ea = { x: 500, y: 500 }, eb = { x: 510, y: 500 };
  Sim.separateTanks(worldWith([]), ea, eb);
  check(near(Math.hypot(eb.x - ea.x, eb.y - ea.y), C.TANK_R * 2, 1e-6), 'Dos tanques no se solapan');
}

// ---------------------------------------------------------------- the game (fake hub)
function newGame(players, opts) {
  const api = fakeApi(players || [0, 1]);
  let t = 1000000;
  const o = Object.assign({ random: function () { return 0; }, now: function () { return t; } }, opts || {});
  const g = Game.create(api, o);
  g.start();
  g.flush();
  g.clock = { add: function (ms) { t += ms; } };
  return { g: g, api: api, S: g._state };
}
function toPlay(G) { runUntil(G.g, function () { return G.S.phase === 'play'; }, 5); }
function place(S, k, x, y, a) { S.tanks[k].x = x; S.tanks[k].y = y; S.tanks[k].a = a || 0; }

function gameInputs() {
  console.log('\n[Entradas]');
  const G = newGame([0, 1], { layouts: [emptyLayout()] });
  const S = G.S;
  const m0 = lastMeta(G.api);
  check(m0.phase === 'countdown' && m0.count === 3 && m0.tanks.join() === '1,2' && m0.scores.join() === '0,0' && m0.toWin === 5, 'Empieza con 3-2-1, Ana contra Berto, a 5');
  const start = [S.tanks[0].x, S.tanks[0].y];
  G.g.onMessage(0, { t: 'k.in', s: [0, 1] });
  G.g.onMessage(0, { t: 'k.fire' });
  runFor(G.g, 1);
  check(S.tanks[0].x === start[0] && S.tanks[0].y === start[1] && !S.bullets.length, 'Durante la cuenta atrás no se mueve ni dispara nadie');
  toPlay(G);
  place(S, 0, 400, 480, 0);
  G.g.onMessage(0, { t: 'k.in', s: [0, 1] });
  runFor(G.g, 1);
  check(near(S.tanks[0].x, 400 + C.TANK_SPEED, 1) && near(S.tanks[0].y, 480, 1e-6), 'Palanca hacia la derecha: avanza a ' + C.TANK_SPEED + ' u/s');
  place(S, 0, 400, 480, 0);
  G.g.onMessage(0, { t: 'k.in', s: [Math.PI / 2, 1] });
  step(G.g, 5);
  check(S.tanks[0].a > 0.25 && Math.hypot(S.tanks[0].x - 400, S.tanks[0].y - 480) < 5, 'Palanca hacia abajo con el tanque mirando a la derecha: primero gira (casi sin moverse)');
  runFor(G.g, 1);
  check(near(S.tanks[0].a, Math.PI / 2, 1e-6) && S.tanks[0].y > 600, 'Luego mira hacia abajo y baja (giro a ' + C.TURN_SPEED + ' rad/s)');
  G.g.onMessage(0, { t: 'k.in', s: [Math.PI / 2, 0] });
  const y0 = S.tanks[0].y;
  runFor(G.g, 0.5);
  check(S.tanks[0].y === y0, 'Al soltar la palanca se para');
  // Buttons
  place(S, 0, 900, 480, 0);
  G.g.onMessage(0, { t: 'k.in', k: [1, 0] });
  runFor(G.g, 0.5);
  check(near(S.tanks[0].a, C.TURN_SPEED * 0.5, 0.02) && near(S.tanks[0].x, 900, 1e-6), 'Botones: ▶ gira en el sitio');
  place(S, 0, 900, 480, 0);
  G.g.onMessage(0, { t: 'k.in', k: [0, 1] });
  runFor(G.g, 0.5);
  check(near(S.tanks[0].x, 900 + C.TANK_SPEED * 0.5, 1), 'Botones: ▲ avanza');
  place(S, 0, 900, 480, 0);
  G.g.onMessage(0, { t: 'k.in', k: [0, -1] });
  runFor(G.g, 0.5);
  check(near(S.tanks[0].x, 900 - C.TANK_BACK * 0.5, 1), 'Botones: ▼ retrocede (más despacio)');
  // A forgotten input: older than 1.5 s counts as released
  place(S, 0, 900, 480, 0);
  G.g.onMessage(0, { t: 'k.in', k: [0, 1] });
  runFor(G.g, 0.2);
  G.g.clock.add(Game.INPUT_TIMEOUT_MS + 100);
  const x1 = S.tanks[0].x;
  runFor(G.g, 0.3);
  check(near(S.tanks[0].x, x1, 1e-6) && S.tanks[0].input.drive === 0, 'Sin noticias del móvil en 1,5 s, el tanque se para (por eso el móvil repite su entrada cada 0,5 s)');
  // Rubbish and spectators
  const before = JSON.stringify(S.tanks[0].input);
  G.g.onMessage(0, { t: 'k.in', s: ['x', 'y'] });
  G.g.onMessage(0, { t: 'k.in', s: [NaN, 1] });
  G.g.onMessage(0, { t: 'k.in' });
  check(JSON.stringify(S.tanks[0].input) === before, 'Entradas sin sentido: se ignoran');
  G.g.onMessage(0, { t: 'k.in', s: [0, 7] });
  check(S.tanks[0].input.m === 1, 'La fuerza de la palanca se limita a 1');
  G.api.list = [0, 1, 2];
  const t2 = JSON.stringify(S.tanks);
  G.g.onMessage(2, { t: 'k.in', s: [0, 1] });
  G.g.onMessage(2, { t: 'k.fire' });
  G.g.onMessage(-1, { t: 'k.fire' });
  check(JSON.stringify(S.tanks) === t2 && !S.bullets.length, 'Quien mira (entró a mitad) y la tele no mueven nada');

  console.log('\n[Disparos]');
  G.g.onMessage(0, { t: 'k.in', s: [0, 0] });
  G.g.onMessage(1, { t: 'k.in', s: [0, 0] });
  place(S, 0, 300, 120, 0);
  place(S, 1, 300, 800, 0);
  for (let i = 0; i < 6; i++) G.g.onMessage(0, { t: 'k.fire' });
  check(S.bullets.length === 1 && near(S.bullets[0].x, 300 + C.MUZZLE, 1e-6), 'Muchos toques seguidos: una bala (espera entre disparos de ' + Game.FIRE_COOLDOWN_S + ' s); sale por el cañón');
  for (let i = 0; i < 6; i++) { runFor(G.g, Game.FIRE_COOLDOWN_S + 0.02); G.g.onMessage(0, { t: 'k.fire' }); }
  check(S.bullets.filter(function (b) { return b.owner === 0; }).length === Game.MAX_BULLETS, 'Como mucho ' + Game.MAX_BULLETS + ' balas vivas por tanque');
  const st = G.g._stateMsg();
  check(st.b.length === 6 * 4 && st.k.length === 8 && st.b[5] === 1, 'El estado para la tele lleva tanques y balas (id, x, y, vx, vy, dueño)');
  const f = G.api.tvSent.filter(function (m) { return m.t === 'k.s'; }).concat([G.g._stateMsg()]);
  check(f.some(function (m) { return m.e.some(function (e) { return e[0] === 'f'; }); }), 'La tele recibe los disparos como eventos (en el siguiente estado)');
}

function bulletLife() {
  console.log('\n[Vida de una bala en la partida]');
  const G = newGame([0, 1], { layouts: [emptyLayout()] });
  const S = G.S;
  toPlay(G);
  place(S, 0, 1700, 100, Math.PI);
  place(S, 1, 1700, 800, 0);
  G.g.onMessage(0, { t: 'k.fire' });
  const b = S.bullets[0];
  place(S, 0, 1000, 500, 0);         // out of its way
  const life = runUntil(G.g, function () { return S.bullets.indexOf(b) < 0; }, 8);
  check(near(life, C.BULLET_LIFE, 2 * DT) && b.bounces === 2, 'En una arena vacía (2 rebotes) la bala dura ' + life.toFixed(2) + ' s y desaparece');
  check(S.tanks.every(function (t) { return t.alive; }) && S.phase === 'play', 'Nadie ha caído');
}

function selfKill() {
  console.log('\n[Tu propia bala]');
  const G = newGame([0, 1], { layouts: [emptyLayout()] });
  const S = G.S;
  toPlay(G);
  place(S, 0, 1800, 480, 0);           // facing the right edge, 120 away
  place(S, 1, 200, 150, 0);
  G.g.onMessage(0, { t: 'k.fire' });
  runUntil(G.g, function () { return !S.tanks[0].alive; }, 2);
  const hit = G.api.sent.filter(function (m) { return m.t === 'k.hit'; })[0];
  check(!S.tanks[0].alive && S.phase === 'over' && hit && hit.slot === 1 && hit.by === 1 && hit.self === true, 'Ana dispara a la pared de enfrente: la bala rebota y la destruye a ella');
  runFor(G.g, Game.DRAW_S + 0.05);
  const m = lastMeta(G.api);
  check(S.scores.join() === '0,1' && m.last && m.last.winner === 2 && m.last.self, 'Punto para Berto (y el aviso de que Ana se ha dado a sí misma)');
  runUntil(G.g, function () { return S.phase === 'countdown'; }, 3);
  check(S.round === 2 && S.tanks.every(function (t) { return t.alive; }) && !S.bullets.length && lastMeta(G.api).count === 3, 'Tras ' + Game.BEAT_S + ' s para verlo, otra ronda con 3-2-1');
  check(near(S.tanks[0].x, S.world.layout.spawns[1].x) && near(S.tanks[1].x, S.world.layout.spawns[0].x), 'En la ronda nueva los tanques cambian de esquina');
}

function draws() {
  console.log('\n[Empate: los dos a la vez]');
  function setup(gapS) {
    const G = newGame([0, 1], { layouts: [emptyLayout()] });
    const S = G.S;
    toPlay(G);
    place(S, 0, 400, 700, 0);
    place(S, 1, 1500, 700, Math.PI);
    const reach = 0.255;
    const d0 = reach * C.BULLET_SPEED, d1 = (reach + gapS) * C.BULLET_SPEED;
    S.bullets.push(bullet(400, 700 - C.TANK_R - C.BULLET_R - d0, 0, C.BULLET_SPEED, 1));
    S.bullets.push(bullet(1500, 700 - C.TANK_R - C.BULLET_R - d1, 0, C.BULLET_SPEED, 0));
    runFor(G.g, reach + gapS + 1.6);
    return G;
  }
  let G = setup(0.2);
  check(G.S.scores.join() === '0,0' && G.api.sent.filter(function (m) { return m.t === 'kmeta' && m.last; }).some(function (m) { return m.last.winner === 0; }), 'Caen con 0,2 s de diferencia: empate, nadie puntúa');
  check(G.S.round === 2 && G.S.phase === 'countdown', 'Y se juega otra ronda');
  G = setup(0);
  check(G.S.scores.join() === '0,0', 'Caen en el mismo instante: empate');
  G = setup(0.5);
  check(G.S.scores.join() === '0,1' && G.api.sent.filter(function (m) { return m.t === 'k.hit'; }).length === 1, 'Con 0,5 s de diferencia: punto para el que cayó después (la ronda ya estaba decidida y su bala se pierde)');
}

function matchTo5() {
  console.log('\n[Rondas y duelo a 5]');
  const G = newGame([0, 1]);
  const S = G.S;
  const layoutsSeen = [];
  let counts = [];
  let prevCount = -1;
  for (let r = 0; r < 5; r++) {
    counts = [];
    prevCount = -1;
    runUntil(G.g, function () {
      const m = lastMeta(G.api);
      if (m.phase === 'countdown' && m.count !== prevCount) { counts.push(m.count); prevCount = m.count; }
      return S.phase === 'play';
    }, 5);
    layoutsSeen.push(S.layout);
    // Berto gets a bullet from Ana
    const tb = S.tanks[1];
    S.bullets.push(bullet(tb.x - 100, tb.y, C.BULLET_SPEED, 0, 0));
    runUntil(G.g, function () { return S.phase === 'countdown' || S.phase === 'end'; }, 4);
  }
  check(counts.join() === '3,2,1', 'Cada ronda empieza con 3-2-1');
  check(new Set(layoutsSeen).size === 4 && layoutsSeen[4] === layoutsSeen[0], 'El mapa cambia en cada ronda (' + layoutsSeen.map(function (i) { return Layouts.LIST[i].name; }).join(', ') + ')');
  const end = lastMeta(G.api);
  check(S.phase === 'end' && end.winner === 1 && end.scores.join() === '5,0', 'Ana llega a 5: fin del duelo, gana Ana (5-0)');
  runFor(G.g, 2);
  check(S.phase === 'end', 'La pantalla del ganador se queda hasta que alguien pide otra');
  G.g.onMessage(1, { t: 'k.again' });
  G.g.flush();
  const again = lastMeta(G.api);
  check(again.match === 2 && again.phase === 'countdown' && again.round === 1 && again.scores.join() === '0,0', '«Otra» desde el móvil: duelo nuevo a 0-0 con 3-2-1');
  G.g.onMessage(0, { t: 'k.again' });
  G.g.flush();
  check(lastMeta(G.api).match === 2, '«Otra» a mitad de duelo no hace nada');
  // From the TV too
  S.scores = [4, 0];
  toPlay(G);
  S.bullets.push(bullet(S.tanks[1].x - 100, S.tanks[1].y, C.BULLET_SPEED, 0, 0));
  runUntil(G.g, function () { return S.phase === 'end'; }, 4);
  G.g.onMessage(-1, { t: 'k.again' });
  G.g.flush();
  check(lastMeta(G.api).match === 3, '«Otra» desde la tele (mando)');
}

function pauseAndResume() {
  console.log('\n[Pausa si se cae un móvil]');
  const G = newGame([0, 1], { layouts: [emptyLayout()] });
  const S = G.S;
  toPlay(G);
  place(S, 0, 300, 120, 0);
  place(S, 1, 300, 800, 0);
  G.g.onMessage(0, { t: 'k.in', s: [0, 1] });
  G.g.onMessage(0, { t: 'k.fire' });
  runFor(G.g, 0.2);
  G.api.conn[1] = false;
  G.g.onPlayerDisconnected(1);
  step(G.g, 1);
  const m = lastMeta(G.api);
  check(m.paused && m.waiting.join() === 'Berto' && m.phase === 'play', 'Berto se desconecta: pausa («Esperando a Berto»)');
  const frozen = JSON.stringify({ t: S.tanks.map(function (t) { return [t.x, t.y, t.a]; }), b: S.bullets.map(function (b) { return [b.x, b.y]; }) });
  G.g.onMessage(0, { t: 'k.fire' });
  runFor(G.g, 3);
  const after = JSON.stringify({ t: S.tanks.map(function (t) { return [t.x, t.y, t.a]; }), b: S.bullets.map(function (b) { return [b.x, b.y]; }) });
  check(after === frozen && S.bullets.length === 1, 'En pausa todo se congela: tanques, balas y disparos');
  G.api.conn[1] = true;
  step(G.g, 1);
  const r = lastMeta(G.api);
  check(!r.paused && r.phase === 'countdown' && r.resumed && r.count === 3 && r.round === 1, 'Vuelve Berto: 3-2-1 («Seguimos») en la misma ronda');
  check(S.tanks[0].input.m === 0, 'Las entradas de antes de la pausa se olvidan');
  runUntil(G.g, function () { return S.phase === 'play'; }, 4);
  check(S.bullets.length === 1 && S.round === 1, 'Y sigue la ronda donde estaba (la bala sigue ahí)');
  // A pause during the beat after a hit: no countdown, the beat goes on
  S.bullets = [bullet(S.tanks[1].x - 100, S.tanks[1].y, C.BULLET_SPEED, 0, 0)];
  runUntil(G.g, function () { return S.phase === 'over'; }, 1);
  G.api.conn[0] = false;
  step(G.g, 30);
  G.api.conn[0] = true;
  step(G.g, 1);
  check(S.phase === 'over' && !S.paused, 'Si la pausa llega tras un impacto, al volver sigue el momento de verlo (sin cuenta atrás)');
  runUntil(G.g, function () { return S.phase === 'countdown'; }, 3);
  check(S.scores.join() === '1,0' && S.round === 2, 'Y cuenta el punto');
  // No pause at the end screen
  S.phase = 'end';
  G.api.conn[1] = false;
  step(G.g, 2);
  check(!S.paused && S.phase === 'end', 'En la pantalla final no hay pausa');
  G.api.conn[1] = true;
  // Reconnection: the phone gets the state
  G.api.slotSent = [];
  G.g.onPlayerJoined(1, true);
  check(G.api.slotSent.length === 1 && G.api.slotSent[0].i === 1 && G.api.slotSent[0].m.t === 'kmeta', 'Al reconectar, el móvil recibe el estado (kmeta)');
}

function leaving() {
  console.log('\n[Alguien se va]');
  let G = newGame([0, 1]);
  G.api.list = [0, 1, 2];
  check(G.g.onPlayerLeft(2) === true && G.S.match === 1, 'Se va alguien que solo miraba: el duelo sigue igual');
  G.api.list = [1, 2];
  check(G.g.onPlayerLeft(0) === true && G.S.match === 2 && (G.g.flush(), true) && lastMeta(G.api).tanks.join() === '2,3', 'Se va Ana con Carla mirando: duelo nuevo de Berto contra Carla');
  G = newGame([0, 1]);
  G.api.list = [1];
  check(G.g.onPlayerLeft(0) === false, 'Se va Ana y no queda nadie más: false (el hub vuelve al menú)');
  G.g.stop();
  const t = JSON.stringify(G.S.tanks);
  G.g.tick(DT);
  G.g.onMessage(1, { t: 'k.in', s: [0, 1] });
  check(JSON.stringify(G.S.tanks) === t, 'Parado (vuelta al menú) ya no hace nada');
}

// ---------------------------------------------------------------- the real server
async function integration() {
  console.log('\n[Servidor: tele y dos móviles falsos]');
  const PORT = parseInt(process.env.TEST_PORT, 10) || 3971;
  const WS = 'ws://127.0.0.1:' + PORT + '/ws';
  const HOME = H_.tmpHome('g2t-tanques-');
  const env = { GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '1500', TANQUES_DEBUG_SPEED: '4' };
  const srv = await H_.startServer(env);
  const clients = [];
  try {
    const tv = H_.makeClient(WS, 'tele'); clients.push(tv);
    await tv.ready;
    tv.send({ t: 'hello', role: 'tv' });
    await H_.waitUntil(function () { return tv.hub; }, 2000, 'hub');
    const ana = await H_.phone(WS, 'Ana', 'k-ana'); clients.push(ana);
    const berto = await H_.phone(WS, 'Berto', 'k-berto'); clients.push(berto);
    const carla = await H_.phone(WS, 'Carla', 'k-carla'); clients.push(carla);
    carla.send({ t: 'pick', game: 'tanques' });
    const many = await carla.wait(function (m) { return m.t === 'ev' && m.k === 'toomany'; }, 1500, 'toomany');
    check(!!many && /para 2 jugadores y sois 3/.test(many.text), 'Con 3 en la sala no se puede: «' + (many && many.text) + '»');
    carla.send({ t: 'leave' });
    await H_.waitUntil(function () { return tv.hub.players.filter(Boolean).length === 2; }, 2000, 'sale Carla');
    const t0 = tv.mark();
    ana.send({ t: 'pick', game: 'tanques' });
    const m0 = await tv.wait(function (m) { return m.t === 'kmeta'; }, 2000, 'kmeta', t0);
    check(!!m0 && m0.phase === 'countdown' && m0.tanks.join() === '1,2' && m0.toWin === 5, 'Ana elige «Tanques»: 3-2-1, Ana contra Berto');
    const pm = await berto.wait(function (m) { return m.t === 'kmeta'; }, 2000, 'kmeta móvil');
    check(!!pm, 'Los móviles reciben el estado público');
    await tv.wait(function (m) { return m.t === 'kmeta' && m.phase === 'play'; }, 3000, 'en juego', t0);
    // ~30 states per second, only to the TV
    const s0 = tv.since(t0, 'k.s').length;
    await H_.sleep(2000);
    const perSec = Math.round((tv.since(t0, 'k.s').length - s0) / 2);
    check(perSec >= 20 && perSec <= 34, 'La tele recibe el estado a ~30 Hz (' + perSec + ' por segundo)');
    check(!ana.msgs.some(function (m) { return m.t === 'k.s'; }), 'Los móviles no reciben el estado de 30 Hz (solo entradas hacia el servidor)');
    function myTank(slot) { const s = tv.find('k.s'); const k = tv.find('kmeta').tanks.indexOf(slot); return { x: s.k[k * 4], y: s.k[k * 4 + 1], a: s.k[k * 4 + 2] }; }
    const p0 = myTank(1);
    ana.send({ t: 'k.in', k: [1, 0] });
    await H_.sleep(400);
    ana.send({ t: 'k.in', k: [0, 0] });
    await H_.sleep(100);
    const p1 = myTank(1);
    check(Math.abs(Sim.angleDiff(p1.a, p0.a)) > 0.5 && near(p1.x, p0.x, 0.2), 'El móvil de Ana gira su tanque (botones) y la tele lo ve');
    ana.send({ t: 'k.fire' });
    const shot = await tv.wait(function (m) { return m.t === 'k.s' && m.b.length >= 6 && m.b[5] === 1; }, 1500, 'bala', tv.mark());
    check(!!shot, 'Ana dispara: la bala aparece en el estado de la tele');
    // Berto's phone drops: pause
    const t1 = tv.mark();
    await berto.close();
    const paused = await tv.wait(function (m) { return m.t === 'kmeta' && m.paused; }, 2000, 'pausa', t1);
    check(!!paused && paused.waiting.join() === 'Berto', 'Se cae el móvil de Berto: pausa, esperando a Berto');
    await H_.sleep(150);
    const fa = tv.find('k.s');
    await H_.sleep(400);
    const fb = tv.find('k.s');
    check(JSON.stringify(fa.k) === JSON.stringify(fb.k) && JSON.stringify(fa.b) === JSON.stringify(fb.b), 'En pausa no se mueve nada');
    // He comes back with the same cid
    const t2 = tv.mark();
    const berto2 = await H_.phone(WS, 'Berto', 'k-berto'); clients.push(berto2);
    const back = await berto2.wait(function (m) { return m.t === 'kmeta'; }, 2000, 'kmeta al volver');
    check(!!berto2.find('joined').reconnect && !!back && back.tanks.join() === '1,2', 'Berto vuelve (mismo hueco) y su móvil recibe el estado');
    const resumed = await tv.wait(function (m) { return m.t === 'kmeta' && !m.paused && m.phase === 'countdown' && m.resumed; }, 2000, 'reanuda', t2);
    check(!!resumed, 'Se reanuda con 3-2-1 («Seguimos»)');
    check(!!(await tv.wait(function (m) { return m.t === 'kmeta' && m.phase === 'play'; }, 3000, 'sigue', t2)), 'Y sigue el juego');
    // Berto leaves for good: only Ana is left, back to the menu
    const t3 = tv.mark();
    berto2.send({ t: 'leave' });
    const menu = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'menu'; }, 2000, 'menú', t3);
    check(!!menu && /Berto se ha ido/.test(menu.text) && tv.hub.screen === 'menu', 'Berto sale: vuelta al menú («' + (menu && menu.text) + '»)');
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
  arenas();
  physics();
  gameInputs();
  bulletLife();
  selfKill();
  draws();
  matchTo5();
  pauseAndResume();
  leaving();
  await integration();
  check.done();
})();
