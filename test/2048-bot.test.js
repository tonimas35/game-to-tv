'use strict';
/*
 * «2048»: the computer opponent (src/games/2048/bot.js), played in the real
 * hub with a virtual clock (test/helpers/bot-arena.js), seeded:
 *   - its board tables slide exactly like logic.js;
 *   - 1 person + 1 bot is the race: the bot plays its own board;
 *   - in a 3-minute race every level scores, the higher the level the more,
 *     at its own speed (never faster than its rate, one move per board
 *     update, every move legal);
 *   - every level beats the one below; «Fácil» loses against a simple
 *     scripted player and «Imposible» beats it;
 *   - it only sends n.move, never «Otra», plays the next race and stops on the menu;
 *   - its CPU time per tick (the search is spread over ticks).
 */
const H_ = require('./helpers');
const arena = require('./helpers/bot-arena');
const Bot = require('../src/games/2048/bot');
const L = require('../src/games/2048/logic');
const Kit = require('../src/games/bot-kit');
const check = H_.checker('2048: el rival bot');

const GAME = '2048';
const LEVELS = ['facil', 'normal', 'dificil', 'imposible'];
const LABEL = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil', imposible: 'Imposible' };
function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / (a.length || 1); }
function boardOf(m, slot) { for (let k = 0; k < m.boards.length; k++) if (m.boards[k].slot === slot) return m.boards[k]; return null; }
function ended() { return function (A) { const m = A.last('nmeta'); return !!m && m.phase === 'end'; }; }

// ---------------------------------------------------------------- tables vs logic.js
function tables() {
  console.log('\n[Sus tablas mueven como el juego]');
  const random = Kit.seeded(5);
  let bad = 0, total = 0;
  for (let k = 0; k < 5000; k++) {
    const vals = [];
    for (let i = 0; i < 16; i++) vals.push(random() < 0.35 ? 0 : 1 << (1 + Math.floor(random() * 11)));
    for (let d = 0; d < 4; d++) {
      const b = L.fromValues(vals);
      b.over = false;
      const r = L.move(b, L.DIRS[d], function () { return 0; });
      let lv = L.values(b);
      if (r.spawned) lv[b.cells.indexOf(r.spawned)] = 0;   // without the new tile
      const bb = Bot._board(vals);
      const m = Bot._move(bb.hi, bb.lo, Bot.DIRS.indexOf(L.DIRS[d]));
      total++;
      if (r.moved !== m.moved || (r.moved && (lv.join() !== Bot._values(m.hi, m.lo).join() || r.gained !== m.gain))) bad++;
    }
  }
  check(bad === 0, total + ' movimientos en tableros al azar: el mismo tablero y los mismos puntos que logic.js (' + bad + ' distintos)');
}

// ---------------------------------------------------------------- a race: the hub's bots, the human phone idle or driven
// Returns per slot: { score, max, moves (seq), over } and the bot moves seen ({ slot, at })
function race(opts) {
  const A = arena.create({ game: GAME, seed: opts.seed });
  (opts.bots || []).forEach(function (lv) { A.addBot(lv); });
  if (opts.drive) A.drive(opts.drive.mod, opts.drive.level);
  A.pick();
  const sends = [];
  let n = 0, early = 0;
  for (let s = 0; s < 200 * 60; s++) {
    A.step();
    while (n < A.sent.length) {
      const x = A.sent[n++];
      const m = A.last('nmeta');
      if (m && m.phase !== 'play') early++;
      sends.push({ slot: x.slot, at: A.now(), msg: x.msg });
    }
    if (ended()(A)) break;
  }
  const m = A.last('nmeta');
  const out = { meta: m, sends: sends, early: early, A: A, by: {} };
  m.boards.forEach(function (b) { out.by[b.slot] = { score: b.score, max: b.max, moves: b.seq, over: b.over }; });
  if (!opts.keep) A.close();
  return out;
}

function solo() {
  console.log('\n[1 persona + 1 bot: la carrera]');
  const A = arena.create({ game: GAME, seed: 4 });
  A.addBot('normal');
  A.pick();
  A.run(1);
  const m0 = A.last('nmeta');
  check(m0.mode === 'race' && m0.phase === 'intro' && m0.players.join() === '1,2' && !!boardOf(m0, 2),
    'Con 2 jugadores (1 persona y 1 bot) es la carrera, con un tablero para el bot (modo ' + m0.mode + ', jugadores ' + m0.players.join(',') + ')');
  check(A.sent.length === 0, 'Durante la cuenta atrás no mueve');
  A.run(10);
  const b = boardOf(A.last('nmeta'), 2), h = boardOf(A.last('nmeta'), 1);
  check(b.seq > 10 && b.score > 0 && h.seq === 0, 'Juega su tablero (' + b.seq + ' movimientos, ' + b.score + ' puntos) y no toca el de la persona');
  A.close();
}

function levels() {
  console.log('\n[Carreras de 3 minutos, cada nivel solo (3 semillas)]');
  const score = {}, ok = {};
  LEVELS.forEach(function (lv) {
    score[lv] = [];
    ok[lv] = { legal: true, rate: true, early: 0, fastest: Infinity, moves: [] };
    const P = Bot.LEVELS[lv];
    const minGap = 1000 / P.movesPerSec * (1 - P.jitter) - 1000 / 60;
    for (let seed = 1; seed <= 3; seed++) {
      const r = race({ seed: seed * 7, bots: [lv] });
      const mine = r.sends.filter(function (x) { return x.slot === 2; });
      score[lv].push(r.by[2].score);
      ok[lv].moves.push(mine.length);
      ok[lv].early += r.early;
      // Every move it sent moved its board: it waits for the board before the next one
      if (mine.length !== r.by[2].moves || mine.some(function (x) { return x.msg.t !== 'n.move' || Bot.DIRS.indexOf(x.msg.dir) < 0; })) ok[lv].legal = false;
      for (let k = 1; k < mine.length; k++) ok[lv].fastest = Math.min(ok[lv].fastest, mine[k].at - mine[k - 1].at);
      if (ok[lv].fastest < minGap) ok[lv].rate = false;
    }
  });
  LEVELS.forEach(function (lv) {
    const P = Bot.LEVELS[lv];
    const o = ok[lv];
    check(o.legal && o.rate && !o.early && mean(score[lv]) > 0,
      '«' + LABEL[lv] + '»: ' + score[lv].join(', ') + ' puntos; ' + o.moves.join(', ') + ' movimientos, todos válidos y de uno en uno; como mucho ' + P.movesPerSec + '/s (el más rápido a ' + o.fastest.toFixed(0) + ' ms)');
  });
  const m = {};
  LEVELS.forEach(function (lv) { m[lv] = mean(score[lv]); });
  check(m.facil < m.normal && m.normal < m.dificil && m.dificil < m.imposible,
    'Más puntos cuanto más difícil (media): ' + LEVELS.map(function (lv) { return LABEL[lv] + ' ' + Math.round(m[lv]); }).join(' · '));
  check(m.imposible > 10 * m.facil, '«Imposible» saca mucho más que «Fácil» en 3 minutos (' + (m.imposible / m.facil).toFixed(0) + ' veces más)');
  check(mean(ok.imposible.moves) > 5 * 170 && mean(ok.facil.moves) < 1.6 * 180, 'Velocidad de persona: «Fácil» ' + (mean(ok.facil.moves) / 180).toFixed(1) + ' mov/s hasta que se atasca, «Imposible» ' + (mean(ok.imposible.moves) / 177).toFixed(1) + ' mov/s');
}

// ---------------------------------------------------------------- races between levels
function duels() {
  console.log('\n[Carreras entre niveles (3 por pareja)]');
  [['normal', 'facil'], ['dificil', 'normal'], ['imposible', 'dificil'], ['imposible', 'facil']].forEach(function (p) {
    let wins = 0, pa = 0, pb = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const r = race({ seed: seed * 101, bots: [p[0]], drive: { mod: Bot, level: p[1] } });
      if (r.meta.ranking[0].slot === 2) wins++;
      pa += r.by[2].score; pb += r.by[1].score;
    }
    check(wins === 3, '«' + LABEL[p[0]] + '» gana a «' + LABEL[p[1]] + '» las 3 carreras (' + pa + ' a ' + pb + ' puntos en total)');
  });
}

// A simple player: 2.5 moves a second, down and left in turns; right, then up, only when stuck
const simple = {
  create: function (ctx) {
    const order = ['down', 'left', 'right', 'up'];
    let seq = -1, sentSeq = -2, k = 0, turn = 0, at = 0, play = false, slot = ctx.slot;
    return {
      onTv: function (m) {
        if (m.t !== 'nmeta') return;
        play = m.phase === 'play';
        const b = boardOf(m, slot);
        if (b) seq = b.seq;
      },
      tick: function () {
        if (!play || ctx.now() < at) return;
        at = ctx.now() + 400;
        if (seq === sentSeq) k = Math.min(3, k + 1);   // the last move did nothing
        else { turn = 1 - turn; k = turn; }
        sentSeq = seq;
        ctx.send({ t: 'n.move', dir: order[k] });
      }
    };
  }
};
function againstSimple() {
  console.log('\n[Contra un jugador sencillo (abajo e izquierda, 2,5 movimientos/s)]');
  const res = {};
  ['facil', 'imposible'].forEach(function (lv) {
    res[lv] = { wins: 0, pts: [], hum: [] };
    for (let seed = 1; seed <= 3; seed++) {
      const r = race({ seed: seed * 13, bots: [lv], drive: { mod: simple } });
      if (r.meta.ranking[0].slot === 2) res[lv].wins++;
      res[lv].pts.push(r.by[2].score); res[lv].hum.push(r.by[1].score);
    }
  });
  check(res.facil.wins === 0, '«Fácil» es ganable: pierde las 3 (' + res.facil.pts.join(', ') + ' contra ' + res.facil.hum.join(', ') + ')');
  check(res.imposible.wins === 3, '«Imposible» gana las 3 (' + res.imposible.pts.join(', ') + ' contra ' + res.imposible.hum.join(', ') + ')');
}

// ---------------------------------------------------------------- how it plays
function protocol() {
  console.log('\n[Juega como un móvil]');
  const r = race({ seed: 3, bots: ['dificil'], keep: true });
  const A = r.A;
  const types = {};
  r.sends.forEach(function (x) { types[x.msg.t] = (types[x.msg.t] || 0) + 1; });
  check(Object.keys(types).join() === 'n.move', 'Solo manda n.move, como el móvil (' + JSON.stringify(types) + ')');
  const n = A.sent.length;
  A.run(10);
  check(A.last('nmeta').phase === 'end' && A.sent.length === n, 'Al final no pulsa «Otra» (n.new): eso lo decide la persona');
  A.send({ t: 'n.new' });
  A.run(10);
  const m = A.last('nmeta');
  const b = boardOf(m, 2);
  check(m.match === 2 && m.phase === 'play' && b.seq > 10, '«Otra» desde el móvil: carrera nueva y el bot vuelve a jugar (' + b.seq + ' movimientos)');
  A.send({ t: 'menu' });
  const n2 = A.sent.length;
  A.run(5);
  check(A.last('hub').screen === 'menu' && A.hub.botStats().running === 0 && A.sent.length === n2, 'Vuelta al menú: el bot se para y no manda nada más');
  check(!A.logs.some(function (l) { return /Error/.test(l); }), 'Sin errores en el registro');
  A.close();
}

// ---------------------------------------------------------------- CPU
function cpu() {
  console.log('\n[Coste por tick (la tele lo ejecuta)]');
  const A = arena.create({ game: GAME, seed: 9 });
  A.addBot('imposible');
  A.drive(Bot, 'normal');
  A.pick();
  A.run(15);              // warm up (JIT, the first tables)
  A.resetTiming();
  let worstEvals = 0;
  for (let s = 0; s < 170 * 60; s++) {
    const e0 = Bot._evals();
    A.step();
    worstEvals = Math.max(worstEvals, Bot._evals() - e0);
    if (A.last('nmeta').phase === 'end') break;
  }
  const T = A.timing();
  const b = boardOf(A.last('nmeta'), 2);
  check(T.avgTickMs < 0.1, '«Imposible», una carrera entera (' + b.seq + ' movimientos, ' + b.score + ' puntos): ' + T.avgTickMs.toFixed(3) + ' ms por tick de media (peor tick ' + T.stepWorst.toFixed(1) + ' ms, ' + T.over1 + ' de ' + T.steps + ' por encima de 1 ms)');
  check(T.over1 / T.steps < 0.005, 'Menos del 0,5 % de los ticks pasa de 1 ms (la búsqueda se reparte entre ticks)');
  check(worstEvals <= Bot.LEVELS.imposible.budget + 1000, 'Como mucho ' + worstEvals + ' evaluaciones de tablero en un tick (presupuesto ' + Bot.LEVELS.imposible.budget + ' más una tarea)');
  A.close();
}

tables();
solo();
levels();
duels();
againstSimple();
protocol();
cpu();
check.done();
