'use strict';
/*
 * «Tanques»: the computer opponent (src/games/tanques/bot.js), played in the
 * real hub with a virtual clock (test/helpers/bot-arena.js), seeded:
 *   - its analytic bullet traces agree with the game's physics (sim.js);
 *   - against a tank that does not move, every level kills it, faster the
 *     higher the level;
 *   - «Imposible» beats «Fácil», every level beats the one below, and
 *     «Fácil» still scores against someone who drives around;
 *   - it only plays with phone messages (k.in, k.fire), never presses «Otra»
 *     and plays the next duel after it;
 *   - its CPU time per tick (the TV runs it): average well under 2 ms.
 */
const H_ = require('./helpers');
const arena = require('./helpers/bot-arena');
const Bot = require('../src/games/tanques/bot');
const Sim = require('../src/games/tanques/sim');
const Layouts = require('../src/games/tanques/layouts');
const Kit = require('../src/games/bot-kit');
const check = H_.checker('Tanques: el rival bot');

const LEVELS = ['facil', 'normal', 'dificil', 'imposible'];
const LABEL = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil', imposible: 'Imposible' };
function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }

// ---------------------------------------------------------------- traces vs the physics
function traces() {
  console.log('\n[Sus trazas de balas son las del juego]');
  const C = Sim.C;
  const random = Kit.seeded(11);
  let agree = 0, total = 0, hits = 0, bounced = 0;
  Layouts.LIST.forEach(function (lay) {
    const w = Sim.makeWorld(lay, Layouts.W, Layouts.H);
    for (let k = 0; k < 150; k++) {
      // Two tanks somewhere free, a random angle
      const me = { x: 60 + random() * 1800, y: 60 + random() * 840 };
      const en = { x: 60 + random() * 1800, y: 60 + random() * 840 };
      const p1 = { x: me.x, y: me.y }, p2 = { x: en.x, y: en.y };
      Sim.pushOutOfWalls(w, p1, C.TANK_R); Sim.pushOutOfWalls(w, p2, C.TANK_R);
      if (Math.hypot(p1.x - p2.x, p1.y - p2.y) < 2 * C.TANK_R + 10) continue;
      const a = (random() * 2 - 1) * Math.PI;
      const r = Bot.trace(w, p1.x, p1.y, a, p2, p1, 5, 3);
      // The game's own stepping (as in fire() and stepWorld())
      const b = { x: p1.x, y: p1.y, vx: Math.cos(a) * C.BULLET_SPEED, vy: Math.sin(a) * C.BULLET_SPEED, bounces: 0, owner: 'me', safe: true };
      const tanks = [{ id: 'en', x: p2.x, y: p2.y, alive: true }, { id: 'me', x: p1.x, y: p1.y, alive: true }];
      let res = Sim.moveBullet(w, b, C.MUZZLE / C.BULLET_SPEED, tanks, null);
      let t = C.MUZZLE / C.BULLET_SPEED;
      while (!res && t < 3) {
        res = Sim.moveBullet(w, b, 1 / 60, tanks, null);
        t += 1 / 60;
        if (b.safe && Math.hypot(b.x - p1.x, b.y - p1.y) > C.TANK_R + C.BULLET_R + 0.5) b.safe = false;
      }
      const game = res && res.tank ? res.tank.id : 'none';
      const mine = !r ? 'none' : (r.self ? 'me' : 'en');
      total++;
      // The trace keeps a margin around its own tank: «me» there may be a near miss in the game
      if (game === mine || (mine === 'me' && game !== 'en')) agree++;
      if (mine === 'en') { hits++; if (r.bounces) bounced++; }
    }
  });
  check(agree / total >= 0.99, 'Trazas de ' + total + ' disparos al azar en los 4 mapas: coinciden con la física del juego en el ' + (100 * agree / total).toFixed(1) + ' % (' + hits + ' aciertos, ' + bounced + ' con rebotes)');
}

// ---------------------------------------------------------------- a still target
function stillTarget() {
  console.log('\n[Contra un tanque quieto]');
  const times = {};
  let allKill = true, noSelf = true;
  LEVELS.forEach(function (lv) {
    times[lv] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const A = arena.create({ game: 'tanques', seed: seed });
      A.addBot(lv);
      A.pick();
      const secs = A.run(25, function () { return A.events('k.hit').length > 0; });
      const hit = A.events('k.hit')[0];
      if (!hit || hit.slot !== 1) allKill = false;
      if (hit && hit.self) noSelf = false;
      times[lv].push(hit ? secs : 25);
      A.close();
    }
  });
  const m = {};
  LEVELS.forEach(function (lv) { m[lv] = mean(times[lv]); });
  check(allKill && noSelf, 'Todos los niveles lo destruyen en menos de 25 s (con la cuenta atrás de 3 s), en 8 duelos cada uno, sin darse a sí mismos');
  check(m.imposible < m.dificil && m.dificil < m.normal && m.normal < m.facil,
    'Más rápido cuanto más difícil (media): ' + LEVELS.map(function (lv) { return LABEL[lv] + ' ' + m[lv].toFixed(1) + ' s'; }).join(' · '));
  check(Math.max.apply(null, times.facil) < 18, '«Fácil» tarda, pero acierta: el peor ' + Math.max.apply(null, times.facil).toFixed(1) + ' s');
}

// ---------------------------------------------------------------- duels
function duel(hubLevel, phoneLevel, seed, maxS) {
  const A = arena.create({ game: 'tanques', seed: seed });
  A.addBot(hubLevel);                 // slot 2
  A.drive(Bot, phoneLevel);           // slot 1: the same bot, through the phone
  A.pick();
  A.run(maxS || 600, function () { const m = A.last('kmeta'); return m && m.phase === 'end'; });
  const m = A.last('kmeta');
  const out = { a: m.scores[m.tanks.indexOf(2)], b: m.scores[m.tanks.indexOf(1)], end: m.phase === 'end', winner: m.winner === 2 ? 'a' : (m.winner === 1 ? 'b' : '') };
  A.close();
  return out;
}
function duels() {
  console.log('\n[Duelos entre niveles (a 5)]');
  [['imposible', 'facil'], ['dificil', 'normal'], ['normal', 'facil'], ['imposible', 'dificil']].forEach(function (p) {
    let wins = 0, pa = 0, pb = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const r = duel(p[0], p[1], seed * 101);
      if (r.winner === 'a') wins++;
      pa += r.a; pb += r.b;
    }
    check(wins === 3, '«' + LABEL[p[0]] + '» gana a «' + LABEL[p[1]] + '» los 3 duelos (' + pa + '-' + pb + ' en puntos)');
  });
}

// «Fácil» against someone who drives around (and never shoots): it still scores
function easyScores() {
  console.log('\n[«Fácil» también puntúa]');
  const A = arena.create({ game: 'tanques', seed: 21 });
  A.addBot('facil');
  const wander = {
    create: function (ctx) {
      let until = 0, msg = { t: 'k.in', k: [0, 0] };
      return {
        tick: function () {
          if (ctx.now() < until) { ctx.send(msg); return; }
          until = ctx.now() + 800 + ctx.random() * 1200;
          msg = { t: 'k.in', s: [Math.round((ctx.random() * 2 - 1) * Math.PI * 100) / 100, ctx.random() < 0.3 ? 0 : 0.6] };
          ctx.send(msg);
        }
      };
    }
  };
  A.drive(wander);
  A.pick();
  A.run(90, function () { return (A.last('kmeta') || {}).phase === 'end'; });
  const m = A.last('kmeta');
  const pts = m.scores[m.tanks.indexOf(2)];
  check(pts >= 2, '«Fácil» contra alguien que conduce sin disparar: ' + pts + ' puntos en ' + m.round + ' rondas');
  A.close();
}

// ---------------------------------------------------------------- how it plays
function protocol() {
  console.log('\n[Juega como un móvil]');
  const A = arena.create({ game: 'tanques', seed: 5 });
  A.addBot('imposible');
  A.pick();
  A.run(200, function () { const m = A.last('kmeta'); return m && m.phase === 'end'; });
  const m = A.last('kmeta');
  check(m.phase === 'end' && m.winner === 2, '«Imposible» gana el duelo a un tanque quieto (' + m.scores.join('-') + ')');
  const types = {};
  let phoneLike = true;
  A.sent.forEach(function (x) {
    types[x.msg.t] = (types[x.msg.t] || 0) + 1;
    const msg = x.msg;
    if (msg.t === 'k.in') {
      if (msg.s) {
        if (Math.abs(msg.s[0] * 100 - Math.round(msg.s[0] * 100)) > 1e-6 || !(msg.s[1] === 0 || (msg.s[1] >= 0.3 && msg.s[1] <= 1))) phoneLike = false;
      } else if (!msg.k || msg.k.some(function (v) { return [-1, 0, 1].indexOf(v) < 0; })) phoneLike = false;
    } else if (msg.t !== 'k.fire') phoneLike = false;
  });
  check(phoneLike && types['k.in'] > 0 && types['k.fire'] > 0, 'Solo manda lo que puede mandar un móvil: k.in (palanca a 0,01 rad y fuerza 0 o 0,3-1, o botones) y k.fire (' + JSON.stringify(types) + ')');
  check(!types['k.again'], 'No pulsa «Otra»: eso lo decide la persona');
  const st = A.hub.botStats();
  check(st.fromBots > 0 && st.parses > 0 && st.toBots >= st.parses, 'El hub le entrega lo de la tele (' + st.toBots + ' mensajes, ' + st.parses + ' JSON.parse) y lleva lo suyo al juego (' + st.fromBots + ')');
  // «Otra» from the person: the bot plays the new duel
  A.send({ t: 'k.again' });
  A.run(4);
  const s0 = A.last('k.s');
  A.run(3);
  const s1 = A.last('k.s');
  const m2 = A.last('kmeta');
  check(m2.match === 2 && m2.phase === 'play' && Math.hypot(s1.k[4] - s0.k[4], s1.k[5] - s0.k[5]) > 30, '«Otra» desde el móvil: duelo nuevo y el bot vuelve a moverse');
  check(!A.logs.some(function (l) { return /Error/.test(l); }), 'Sin errores en el registro');
  A.close();
}

// ---------------------------------------------------------------- CPU
function cpu() {
  console.log('\n[Coste por tick (la tele lo ejecuta)]');
  const A = arena.create({ game: 'tanques', seed: 5 });
  A.addBot('imposible');
  A.drive(Bot, 'dificil');
  A.pick();
  A.run(15);              // warm up (JIT, the first map)
  A.resetTiming();
  // 150 s of duels (a new one as soon as one ends: the time is mostly play)
  let duels = 0;
  for (let k = 0; k < 150; k++) {
    A.run(1);
    if (A.last('kmeta').phase === 'end') { A.send({ t: 'k.again' }); duels++; }
  }
  const T = A.timing();
  console.log('    (' + duels + ' duelos terminados; ' + T.calls + ' llamadas al bot)');
  check(T.avgTickMs < 0.5, '«Imposible» contra «Difícil», 150 s: ' + T.avgTickMs.toFixed(3) + ' ms por tick de media (límite de la prueba 0,5 ms; peor tick ' + T.stepWorst.toFixed(1) + ' ms, ' + T.over1 + ' de ' + T.steps + ' por encima de 1 ms)');
  check(T.over1 / T.steps < 0.01, 'Menos del 1 % de los ticks pasa de 1 ms (búsqueda repartida en varios ticks)');
  A.close();
}

traces();
stillTarget();
duels();
easyScores();
protocol();
cpu();
check.done();
