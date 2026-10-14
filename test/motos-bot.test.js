'use strict';
/*
 * «Motos de neón»: the computer opponent (src/games/motos/bot.js), played in
 * the real hub with a virtual clock (test/helpers/bot-arena.js), seeded:
 *   - the grid it rebuilds from the TV messages (msnap + mt) is the game's;
 *   - against a simple scripted rider, «Fácil» loses but scores, «Normal» is
 *     a fair fight and «Difícil» and «Imposible» win;
 *   - every level beats the one below over several seeds;
 *   - it only sends what a phone sends (m.turn, one waiting at a time),
 *     never presses «Otra», and stops when the room goes back to the menu;
 *   - its CPU time per tick (the TV runs it).
 */
const H_ = require('./helpers');
const arena = require('./helpers/bot-arena');
const Bot = require('../src/games/motos/bot');
const check = H_.checker('Motos de neón: el rival bot');

const LABEL = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil', imposible: 'Imposible' };
const DIRS = ['up', 'right', 'down', 'left'];
function over(A) { const m = A.last('mmeta'); return !!m && m.phase === 'gameover'; }

/*
 * A simple scripted rider (what a decent casual player does): straight on
 * until the next cell is taken (or now and then, 1 step in 25), then the
 * way with more room (a flood fill). It thinks on the tick after each step.
 */
const Scripted = {
  create: function (ctx) {
    let meta = null, B = null, side = 0, dirty = false;
    const head = [-1, -1], dir = [1, 3];
    return {
      onTv: function (m) {
        if (m.t === 'mmeta') { meta = m; side = m.players.indexOf(ctx.slot) + 1; }
        if (m.t === 'msnap') {
          B = Bot.makeBoard(m.w, m.h);
          for (let s = 0; s < 2; s++) {
            const cells = Bot.expandPath(m.tr[s], m.w);
            cells.forEach(function (c) { B.grid[B.toB(c)] = s + 1; });
            head[s] = B.toB(cells[cells.length - 1]);
            dir[s] = m.dr[s];
          }
          dirty = true;
        }
        if (m.t === 'mt' && B) {
          for (let i = 0; i < m.h.length / 2; i++) {
            for (let s = 0; s < 2; s++) {
              const c = m.h[i * 2 + s];
              if (c < 0) continue;
              const p = B.toB(c), d = p - head[s];
              dir[s] = d === 1 ? 1 : (d === -1 ? 3 : (d > 0 ? 2 : 0));
              head[s] = p;
              B.grid[p] = s + 1;
            }
          }
          dirty = true;
        }
      },
      tick: function () {
        if (!dirty || !B || !side || !meta || (meta.phase !== 'playing' && meta.phase !== 'countdown')) return;
        dirty = false;
        const me = side - 1, cur = dir[me], h = head[me];
        if (!B.grid[h + B.OFF[cur]] && ctx.random() > 0.04) return;
        let best = -1, bestR = -1;
        [cur, (cur + 1) % 4, (cur + 3) % 4].forEach(function (d) {
          const c = h + B.OFF[d];
          if (B.grid[c]) return;
          B.grid[c] = 9;
          const r = B.flood(c, 5000);
          B.grid[c] = 0;
          if (r > bestR) { bestR = r; best = d; }
        });
        if (best >= 0 && best !== cur) ctx.send({ t: 'm.turn', dir: DIRS[best] });
      }
    };
  }
};

/** A match: the hub's bot (slot 2) at `hubLevel` against the phone (slot 1): a level or the script. */
function match(hubLevel, phone, seed) {
  const A = arena.create({ game: 'motos', seed: seed });
  A.addBot(hubLevel);
  A.drive(phone === 'script' ? Scripted : Bot, phone === 'script' ? 'normal' : phone);
  A.pick();
  A.run(900, function () { return over(A); });
  const m = A.last('mmeta');
  const out = { a: m.score[m.players.indexOf(2)], b: m.score[m.players.indexOf(1)], end: m.phase === 'gameover' };
  A.close();
  return out;
}
function series(hubLevel, phone, seeds) {
  let wins = 0, pa = 0, pb = 0, ended = 0;
  for (let s = 1; s <= seeds; s++) {
    const r = match(hubLevel, phone, s * 31);
    if (r.a > r.b) wins++;
    if (r.end) ended++;
    pa += r.a; pb += r.b;
  }
  return { wins: wins, pa: pa, pb: pb, ended: ended, n: seeds };
}

// ---------------------------------------------------------------- the grid it sees
function model() {
  console.log('\n[Su cuadrícula es la del juego]');
  const A = arena.create({ game: 'motos', seed: 3 });
  A.addBot('imposible');
  A.drive(Bot, 'normal');
  A.pick();
  // A second TV that connects later gets the full state (msnap): the game's grid
  let snap = null;
  const ws = { readyState: 1, handlers: {} };
  ws.on = function (ev, fn) { ws.handlers[ev] = fn; };
  ws.send = function (s) { const m = JSON.parse(s); if (m.t === 'msnap') snap = m; };
  ws.close = function () { ws.readyState = 3; if (ws.handlers.close) ws.handlers.close(); };
  ws.terminate = ws.close; ws.ping = function () {};
  let same = 0, total = 0, steps = 0;
  for (let k = 0; k < 6; k++) {
    A.run(4 + k * 3, function () { return over(A); });
    if (over(A)) break;
    snap = null;
    if (!ws.handlers.message) { A.hub.onConnection(ws); ws.handlers.message(Buffer.from(JSON.stringify({ t: 'hello', role: 'tv' }))); }
    else ws.handlers.message(Buffer.from(JSON.stringify({ t: 'm.sync' })));
    if (!snap) continue;
    const g = new Uint8Array(snap.w * snap.h);
    snap.tr.forEach(function (pts, side) { Bot.expandPath(pts, snap.w).forEach(function (c) { g[c] = side + 1; }); });
    const d = A.bots[0]._inner._debug();
    total++;
    if (d.k === snap.k && d.grid && d.grid.every(function (v, i) { return v === g[i]; })) { same++; steps = d.k; }
  }
  check(total >= 4 && same === total, 'En ' + total + ' momentos de la partida, la cuadrícula que rehace con msnap + mt es la del juego (' + same + ' iguales; la última, tras ' + steps + ' pasos)');
  A.close();
}

// ---------------------------------------------------------------- against a scripted rider
function scripted() {
  console.log('\n[Contra un jugador con guion (sigue recto y gira hacia donde hay más sitio)]');
  const N = 6;
  const r = {};
  ['facil', 'normal', 'dificil', 'imposible'].forEach(function (lv) { r[lv] = series(lv, 'script', N); });
  const all = Object.keys(r).every(function (lv) { return r[lv].ended === N; });
  check(all, 'Todas las partidas (' + 4 * N + ') terminan, a 5 rondas');
  check(r.facil.wins <= N / 2 && r.facil.pa >= 6, '«Fácil» se deja ganar, pero puntúa: gana ' + r.facil.wins + ' de ' + N + ' (' + r.facil.pa + '-' + r.facil.pb + ' en rondas)');
  check(r.normal.pa >= 0.6 * r.normal.pb && r.normal.pb >= 0.6 * r.normal.pa, '«Normal», un duelo igualado: gana ' + r.normal.wins + ' de ' + N + ' (' + r.normal.pa + '-' + r.normal.pb + ')');
  check(r.dificil.wins >= N - 1, '«Difícil» gana ' + r.dificil.wins + ' de ' + N + ' (' + r.dificil.pa + '-' + r.dificil.pb + ')');
  check(r.imposible.wins === N && r.imposible.pb <= 2, '«Imposible» gana ' + r.imposible.wins + ' de ' + N + ' (' + r.imposible.pa + '-' + r.imposible.pb + ')');
}

// ---------------------------------------------------------------- bot against bot
function duels() {
  console.log('\n[Duelos entre niveles (a 5 rondas)]');
  [['imposible', 'facil'], ['normal', 'facil'], ['dificil', 'normal'], ['imposible', 'dificil']].forEach(function (p) {
    const N = 5;
    const r = series(p[0], p[1], N);
    check(r.wins >= N - 1 && r.pa > r.pb, '«' + LABEL[p[0]] + '» gana a «' + LABEL[p[1]] + '» ' + r.wins + ' de ' + N + ' partidas (' + r.pa + '-' + r.pb + ' en rondas)');
  });
}

// ---------------------------------------------------------------- how it plays
function protocol() {
  console.log('\n[Juega como un móvil]');
  const A = arena.create({ game: 'motos', seed: 9 });
  A.addBot('dificil');
  A.drive(Scripted);
  A.pick();
  // The step it had seen when it sent each message (round, step), to check it never queues two turns
  const seenAt = [];
  let seen = '0:0';
  const n0 = A.sent.length;
  A.run(900, function () {
    while (seenAt.length < A.sent.length - n0) seenAt.push(seen);
    const t = A.last('mt');
    if (t) seen = t.r + ':' + (t.k + t.h.length / 2 - 1);
    return over(A);
  });
  const m = A.last('mmeta');
  const types = {};
  let legal = true;
  A.sent.forEach(function (x) {
    types[x.msg.t] = (types[x.msg.t] || 0) + 1;
    if (x.msg.t !== 'm.turn' || DIRS.indexOf(x.msg.dir) < 0 || Object.keys(x.msg).length !== 2) legal = false;
  });
  check(m.phase === 'gameover' && legal && types['m.turn'] > 20, 'Solo manda { t: \'m.turn\', dir } con up/right/down/left (' + JSON.stringify(types) + ' en una partida ' + m.score.join('-') + ')');
  // One turn waiting at most: it sends a turn, waits for the step that uses it, and thinks again
  let twice = 0;
  for (let i = 1; i < seenAt.length; i++) if (seenAt[i] === seenAt[i - 1]) twice++;
  check(seenAt.length > 20 && twice === 0, 'Nunca deja dos giros en la cola: un giro por paso como mucho (' + seenAt.length + ' giros, ' + twice + ' tras el mismo paso)');
  check(!types['m.again'], 'No pulsa «Otra»: eso lo decide la persona');
  const st = A.hub.botStats();
  check(st.fromBots > 0 && st.toBots > 0, 'El hub le entrega lo de la tele (' + st.toBots + ' mensajes) y lleva lo suyo al juego (' + st.fromBots + ')');
  // «Otra» from the person: it plays the new match
  const sent0 = A.sent.length;
  A.send({ t: 'm.again' });
  A.run(10);
  const m2 = A.last('mmeta');
  check(m2.match === 2 && m2.phase === 'playing' && A.sent.length > sent0, '«Otra» desde el móvil: partida nueva y el bot vuelve a girar');
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
  const A = arena.create({ game: 'motos', seed: 5 });
  A.addBot('imposible');
  A.drive(Bot, 'dificil');
  A.pick();
  A.run(10);              // warm up (JIT)
  A.resetTiming();
  // Its thinking alone, at positions of the duel (one decision = the work of
  // one tick): each timed 5 times, keeping the fastest (the machine may be
  // busy with other processes: that is not the bot's cost)
  const thinks = [];
  const L = Bot.LEVELS.imposible;
  for (let k = 0; k < 240; k++) {
    A.run(1);
    if (over(A)) A.send({ t: 'm.again' });
    const d = A.bots[0]._inner._debug();
    if (!d.grid || !d.alive[0] || !d.alive[1] || !d.side) continue;
    const B = Bot.makeBoard(64, 36);
    for (let c = 0; c < d.grid.length; c++) B.grid[B.toB(c)] = d.grid[c];
    const hd = d.head.map(function (c) { return B.toB(c); });
    let best = Infinity;
    for (let r = 0; r < 5; r++) {
      const t0 = process.hrtime();
      Bot.choose(B, d.side, hd, d.dir, true, L);
      const t = process.hrtime(t0);
      best = Math.min(best, t[0] * 1e3 + t[1] / 1e6);
    }
    thinks.push(best);
  }
  const T = A.timing();
  const rounds = A.events('ev').filter(function (e) { return e.k === 'round'; }).length;
  console.log('    (' + rounds + ' rondas: entre dos bots buenos duran casi un minuto; ' + T.calls + ' llamadas al bot)');
  check(T.avgTickMs < 0.1, '«Imposible» contra «Difícil», 240 s: ' + T.avgTickMs.toFixed(3) + ' ms por tick de media (límite de la prueba 0,1 ms; reloj de pared: peor tick ' + T.stepWorst.toFixed(2) + ' ms, ' + T.over1 + ' de ' + T.steps + ' por encima de 1 ms)');
  check(T.over1 / T.steps < 0.01, 'Menos del 1 % de los ticks pasa de 1 ms en el reloj de pared');
  thinks.sort(function (x, y) { return x - y; });
  const worst = thinks[thinks.length - 1], med = thinks[thinks.length >> 1];
  check(thinks.length > 100 && worst < 1, 'Una decisión (un tick por paso) en ' + thinks.length + ' posiciones del duelo: mediana ' + med.toFixed(3) + ' ms, la peor ' + worst.toFixed(3) + ' ms (límite 1 ms; hasta 10 repartos de Voronoi)');
  A.close();
}

model();
scripted();
duels();
protocol();
cpu();
check.done();
