'use strict';
/*
 * «Sumo»: the computer opponent (src/games/sumo/bot.js), played in the real
 * hub with a virtual clock (test/helpers/bot-arena.js), seeded:
 *   - against a wrestler that does not move, every level pushes it out,
 *     faster the higher the level;
 *   - against a simple scripted wrestler, «Fácil» loses but scores, «Normal»
 *     is a fair fight and «Difícil» and «Imposible» win; against one that
 *     dashes at it whenever it can, «Imposible» sidesteps and wins;
 *   - every level beats the one below over several seeds;
 *   - it only sends what a phone sends (s.j rounded to 0.01 inside the unit
 *     circle, at most once a frame; s.d only when its cooldown is over),
 *     never presses «Otra», and stops when the room goes back to the menu;
 *   - its CPU time per tick (the TV runs it).
 */
const H_ = require('./helpers');
const arena = require('./helpers/bot-arena');
const Bot = require('../src/games/sumo/bot');
const Ph = require('../src/games/sumo/physics');
const check = H_.checker('Sumo: el rival bot');

const LEVELS = ['facil', 'normal', 'dificil', 'imposible'];
const LABEL = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil', imposible: 'Imposible' };
const P = Ph.P;
function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
function ended(A) { const m = A.last('smeta'); return !!m && m.phase === 'end'; }

/*
 * Scripted wrestlers (the phone, slot 1):
 *  - pusher: a decent casual player: pushes straight at the rival, back to
 *    the centre when near the edge, and now and then dashes when close;
 *  - dasher: pushes at the rival and dashes at it every time it can.
 */
function scripted(kind) {
  return {
    create: function (ctx) {
      let meta = null, st = null, me = -1, cdUntil = 0, last = '';
      return {
        onTv: function (m) {
          if (m.t === 'smeta') { meta = m; me = m.slots.indexOf(ctx.slot); }
          if (m.t === 's') st = m;
        },
        onSlot: function (m) { if (m.t === 's.cd') cdUntil = ctx.now() + m.ms; },
        tick: function () {
          if (!meta || !st || me < 0 || meta.phase !== 'playing') { last = ''; return; }
          const w = st.w, k = me * 6, o = (1 - me) * 6;
          const x = w[k], y = w[k + 1], ex = w[o], ey = w[o + 1];
          const dC = Math.hypot(x - P.CX, y - P.CY);
          const edge = st.R - dC < 110;
          let ux = ex - x, uy = ey - y;
          if (edge && kind === 'pusher') { ux = P.CX - x; uy = P.CY - y; }
          const m = Math.hypot(ux, uy) || 1;
          const jx = Math.round(ux / m * 100) / 100, jy = Math.round(uy / m * 100) / 100;
          const key = jx + ',' + jy;
          if (key !== last) { ctx.send({ t: 's.j', x: jx, y: jy }); last = key; }
          const close = Math.hypot(ex - x, ey - y) < (kind === 'dasher' ? 420 : 260);
          const want = kind === 'dasher' ? true : (!edge && ctx.random() < 0.05);
          if (close && want && ctx.now() >= cdUntil) { ctx.send({ t: 's.d' }); cdUntil = ctx.now() + 2000; }
        }
      };
    }
  };
}
const STILL = { create: function () { return {}; } };

/** A match: the hub's bot (slot 2) at `hubLevel` against the phone (slot 1): a level or a script. */
function match(hubLevel, phone, seed) {
  const A = arena.create({ game: 'sumo', seed: seed });
  A.addBot(hubLevel);
  A.drive(typeof phone === 'string' ? Bot : phone, typeof phone === 'string' ? phone : 'normal');
  A.pick();
  A.run(400, function () { return ended(A); });
  const m = A.last('smeta');
  const out = { a: m.score[m.slots.indexOf(2)], b: m.score[m.slots.indexOf(1)], end: m.phase === 'end' };
  A.close();
  return out;
}
function series(hubLevel, phone, seeds) {
  let wins = 0, pa = 0, pb = 0, done = 0;
  for (let s = 1; s <= seeds; s++) {
    const r = match(hubLevel, phone, s * 37 + 1);
    if (r.a > r.b) wins++;
    if (r.end) done++;
    pa += r.a; pb += r.b;
  }
  return { wins: wins, pa: pa, pb: pb, done: done, n: seeds };
}

// ---------------------------------------------------------------- a still target
function stillTarget() {
  console.log('\n[Contra un luchador quieto]');
  const times = {};
  let all = true;
  LEVELS.forEach(function (lv) {
    times[lv] = [];
    for (let seed = 1; seed <= 6; seed++) {
      const A = arena.create({ game: 'sumo', seed: seed });
      A.addBot(lv);
      A.drive(STILL);
      A.pick();
      // From the «go» (the countdown is 3 s) to the ring-out
      let goAt = 0;
      A.run(40, function () { if (!goAt && A.events('ev').some(function (e) { return e.k === 'go'; })) goAt = A.now(); return A.events('ev').some(function (e) { return e.k === 'out'; }); });
      const out = A.events('ev').filter(function (e) { return e.k === 'out'; })[0];
      if (!out || out.w.length !== 1 || out.w[0] !== 1) all = false;
      times[lv].push(out && goAt ? (A.now() - goAt) / 1000 : 40);
      A.close();
    }
  });
  const m = {};
  LEVELS.forEach(function (lv) { m[lv] = mean(times[lv]); });
  check(all, 'Todos los niveles lo sacan del círculo, sin caerse ellos (6 rondas cada uno)');
  check(m.imposible <= m.dificil && m.dificil < m.normal && m.normal < m.facil,
    'Más rápido cuanto más difícil (media desde «¡Ya!»): ' + LEVELS.map(function (lv) { return LABEL[lv] + ' ' + m[lv].toFixed(1) + ' s'; }).join(' · '));
}

// ---------------------------------------------------------------- against scripts
function scripts() {
  console.log('\n[Contra luchadores con guion]');
  const N = 6;
  const r = {};
  LEVELS.forEach(function (lv) { r[lv] = series(lv, scripted('pusher'), N); });
  check(LEVELS.every(function (lv) { return r[lv].done === N; }), 'Todas las partidas (' + 4 * N + ') terminan, al mejor de 5');
  check(r.facil.wins <= N / 2 && r.facil.pa >= 4, 'Contra uno que empuja y embiste a veces, «Fácil» se deja ganar, pero puntúa: gana ' + r.facil.wins + ' de ' + N + ' (' + r.facil.pa + '-' + r.facil.pb + ' en rondas)');
  check(r.normal.pa >= 0.6 * r.normal.pb && r.normal.pb >= 0.4 * r.normal.pa, '«Normal», un duelo igualado: gana ' + r.normal.wins + ' de ' + N + ' (' + r.normal.pa + '-' + r.normal.pb + ')');
  check(r.dificil.wins === N, '«Difícil» gana ' + r.dificil.wins + ' de ' + N + ' (' + r.dificil.pa + '-' + r.dificil.pb + ')');
  check(r.imposible.wins === N && r.imposible.pb <= 1, '«Imposible» gana ' + r.imposible.wins + ' de ' + N + ' (' + r.imposible.pa + '-' + r.imposible.pb + ')');
  const d = series('imposible', scripted('dasher'), N);
  check(d.wins === N && d.pb <= 1, 'Contra uno que le embiste siempre que puede, «Imposible» esquiva y gana ' + d.wins + ' de ' + N + ' (' + d.pa + '-' + d.pb + ')');
}

// ---------------------------------------------------------------- bot against bot
function duels() {
  console.log('\n[Duelos entre niveles (al mejor de 5)]');
  [['imposible', 'facil'], ['normal', 'facil'], ['dificil', 'normal'], ['imposible', 'dificil']].forEach(function (p) {
    const N = 6;
    const r = series(p[0], p[1], N);
    check(r.wins >= N - 1 && r.pa > r.pb, '«' + LABEL[p[0]] + '» gana a «' + LABEL[p[1]] + '» ' + r.wins + ' de ' + N + ' partidas (' + r.pa + '-' + r.pb + ' en rondas)');
  });
}

// ---------------------------------------------------------------- how it plays
function protocol() {
  console.log('\n[Juega como un móvil]');
  const A = arena.create({ game: 'sumo', seed: 5 });
  A.addBot('dificil');
  A.drive(scripted('pusher'));
  A.pick();
  // The virtual time of each message it sent (for the rate)
  const at = [];
  const n0 = A.sent.length;
  A.run(400, function () { while (at.length < A.sent.length - n0) at.push(A.now()); return ended(A); });
  const m = A.last('smeta');
  const types = {};
  let legal = true, fast = 0;
  let lastJ = -1e9;
  A.sent.forEach(function (x, i) {
    const msg = x.msg;
    types[msg.t] = (types[msg.t] || 0) + 1;
    if (msg.t === 's.j') {
      const r2 = msg.x * msg.x + msg.y * msg.y;
      if (Object.keys(msg).length !== 3 || Math.abs(msg.x * 100 - Math.round(msg.x * 100)) > 1e-6 || Math.abs(msg.y * 100 - Math.round(msg.y * 100)) > 1e-6 || r2 > 1 + 1e-9) legal = false;
      if (at[i] - lastJ < 1000 / 60 - 1) fast++;
      lastJ = at[i];
    } else if (msg.t !== 's.d' || Object.keys(msg).length !== 1) legal = false;
  });
  check(m.phase === 'end' && legal && types['s.j'] > 20 && types['s.d'] > 0, 'Solo manda lo de un móvil: s.j (x, y a 0,01, dentro del círculo) y s.d (' + JSON.stringify(types) + ' en una partida ' + m.score.join('-') + ')');
  check(fast === 0, 'El joystick, como mucho una vez por fotograma (1/60 s)');
  const dashes = A.events('ev').filter(function (e) { return e.k === 'dash' && e.w === m.slots.indexOf(2) + 1; }).length;
  check(dashes === types['s.d'], 'Embiste solo con la recarga lista: ' + types['s.d'] + ' «¡Embestida!» y las ' + dashes + ' valen');
  check(!types['s.again'], 'No pulsa «Otra»: eso lo decide la persona');
  const st = A.hub.botStats();
  check(st.fromBots > 0 && st.parses > 0 && st.toBots >= st.parses, 'El hub le entrega lo de la tele (' + st.toBots + ' mensajes) y lleva lo suyo al juego (' + st.fromBots + ')');
  // «Otra» from the person: it plays the new match
  A.send({ t: 's.again' });
  const sent0 = A.sent.length;
  A.run(6);
  const m2 = A.last('smeta');
  check(m2.match === 2 && m2.phase !== 'end' && A.sent.length > sent0, '«Otra» desde el móvil: partida nueva y el bot vuelve a moverse');
  // Back to the menu: the bot stops
  A.send({ t: 'menu' });
  const sent1 = A.sent.length;
  A.run(3);
  check(A.last('hub').screen === 'menu' && A.hub.botStats().running === 0 && A.sent.length === sent1, 'Vuelta al menú: el bot se para y no manda nada más');
  check(!A.logs.some(function (l) { return /Error/.test(l); }), 'Sin errores en el registro');
  A.close();
}

// ---------------------------------------------------------------- CPU
function cpu() {
  console.log('\n[Coste por tick (la tele lo ejecuta)]');
  const A = arena.create({ game: 'sumo', seed: 5 });
  A.addBot('imposible');
  A.drive(Bot, 'dificil');
  A.pick();
  A.run(8);               // warm up (JIT)
  A.resetTiming();
  // A decision (one search) alone, at positions of the duel: each timed 5
  // times, keeping the fastest (the machine may be busy with other processes)
  const L = Bot.LEVELS.imposible;
  const thinks = [];
  let matches = 0;
  for (let k = 0; k < 150; k++) {
    A.run(1);
    if (ended(A)) { A.send({ t: 's.again' }); matches++; }
    const st = A.last('s'), m = A.last('smeta');
    if (!st || !m || m.phase !== 'playing') continue;
    const b = function (i) { const w = st.w, j = i * 6; return { x: w[j], y: w[j + 1], vx: w[j + 2], vy: w[j + 3], face: w[j + 4], dash: 0, cd: 0, ix: 0, iy: 0 }; };
    let best = Infinity;
    for (let r = 0; r < 5; r++) {
      const t0 = process.hrtime();
      Bot.search(b(1), b(0), 12, L, true, null);
      const t = process.hrtime(t0);
      best = Math.min(best, t[0] * 1e3 + t[1] / 1e6);
    }
    thinks.push(best);
  }
  const T = A.timing();
  console.log('    (' + matches + ' partidas terminadas; ' + T.calls + ' llamadas al bot)');
  check(T.avgTickMs < 0.1, '«Imposible» contra «Difícil», 150 s: ' + T.avgTickMs.toFixed(3) + ' ms por tick de media (límite de la prueba 0,1 ms; reloj de pared: peor tick ' + T.stepWorst.toFixed(2) + ' ms, ' + T.over1 + ' de ' + T.steps + ' por encima de 1 ms)');
  check(T.over1 / T.steps < 0.01, 'Menos del 1 % de los ticks pasa de 1 ms en el reloj de pared');
  thinks.sort(function (x, y) { return x - y; });
  const worst = thinks[thinks.length - 1], med = thinks[thinks.length >> 1];
  check(thinks.length > 50 && worst < 1, 'Una búsqueda de «Imposible» (16 direcciones, con y sin embestida, 2 suposiciones, 0,6 s por delante) en ' + thinks.length + ' posiciones: mediana ' + med.toFixed(3) + ' ms, la peor ' + worst.toFixed(3) + ' ms (límite 1 ms; una cada 3 ticks)');
  A.close();
}

stillTarget();
scripts();
duels();
protocol();
cpu();
check.done();
