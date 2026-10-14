'use strict';
/*
 * «Reflejos»: the computer opponent (src/games/ejemplo-reflejos/bot.js),
 * played in the real hub with a virtual clock (test/helpers/bot-arena.js), seeded:
 *   - its reaction times after «¡YA!» are the ones of its level;
 *   - «Fácil» sometimes taps too soon (and is out for the round); the
 *     harder levels never do;
 *   - every level beats the one below over several matches, «Fácil» loses
 *     against a scripted player who reacts in 300 ms and «Imposible» beats it;
 *   - it only sends r.tap, never «Otra partida», and stops on the menu;
 *   - its CPU time per tick.
 */
const H_ = require('./helpers');
const arena = require('./helpers/bot-arena');
const Bot = require('../src/games/ejemplo-reflejos/bot');
const check = H_.checker('Reflejos: el rival bot');

const GAME = 'ejemplo-reflejos';
const LEVELS = ['facil', 'normal', 'dificil', 'imposible'];
const LABEL = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil', imposible: 'Imposible' };
function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / (a.length || 1); }
function sd(a) { const m = mean(a); return Math.sqrt(mean(a.map(function (x) { return (x - m) * (x - m); }))); }

// A scripted player: taps `ms` after the TV shows «¡YA!» (never too soon); counts r.early
function scripted(ms, seen) {
  return {
    create: function (ctx) {
      let key = '', at = 0;
      return {
        onTv: function (m) {
          if (m.t === 'r.early' && seen) seen.push(m.slot);
          if (m.t !== 'rmeta') return;
          const k = m.phase + '|' + m.round;
          if (k !== key) { key = k; at = m.phase === 'go' && ms > 0 ? ctx.now() + ms : 0; }
        },
        tick: function () { if (at && ctx.now() >= at) { at = 0; ctx.send({ t: 'r.tap' }); } }
      };
    }
  };
}

// Plays `rounds` rounds (new matches as needed, «Otra» from the human phone)
function playRounds(A, rounds) {
  const out = [];
  let lastKey = '';
  for (let s = 0; s < rounds * 20 && out.length < rounds; s++) {
    A.run(0.5);
    const m = A.last('rmeta');
    if (!m) continue;
    const k = m.phase + '|' + m.round + '|' + m.scores.join(',');
    if ((m.phase === 'point' || m.phase === 'end') && k !== lastKey) out.push(m.last ? { slot: m.last.slot, ms: m.last.ms } : null);
    lastKey = k;
    if (m.phase === 'end') A.send({ t: 'r.again' });
  }
  return out;
}

// ---------------------------------------------------------------- reaction times
function reactions() {
  console.log('\n[Tiempo de reacción tras «¡YA!» (contra alguien que no toca)]');
  const stats = {};
  LEVELS.forEach(function (lv) {
    const A = arena.create({ game: GAME, seed: 3 });
    const early = [];
    A.addBot(lv);
    A.drive(scripted(0, early));
    A.pick();
    const pts = playRounds(A, 40);
    const ms = pts.filter(function (p) { return p && p.slot === 2; }).map(function (p) { return p.ms; });
    stats[lv] = { ms: ms, early: early.filter(function (s) { return s === 2; }).length, rounds: pts.length };
    A.close();
  });
  const want = { facil: 450, normal: 320, dificil: 240, imposible: 170 };
  LEVELS.forEach(function (lv) {
    const s = stats[lv];
    const m = mean(s.ms);
    // What the game measures includes one or two ticks (16.7 ms) of message latency
    check(s.ms.length >= 25 && m > want[lv] - 15 && m < want[lv] + 45,
      '«' + LABEL[lv] + '»: ' + m.toFixed(0) + ' ms de media (± ' + sd(s.ms).toFixed(0) + ', objetivo ' + want[lv] + ' + latencia) en ' + s.ms.length + ' puntos');
  });
  check(sd(stats.facil.ms) > sd(stats.normal.ms) && sd(stats.normal.ms) > sd(stats.dificil.ms) && sd(stats.dificil.ms) > sd(stats.imposible.ms),
    'Más regular cuanto más difícil (desviación ' + LEVELS.map(function (lv) { return sd(stats[lv].ms).toFixed(0); }).join(' > ') + ' ms)');
  check(stats.facil.early >= 1 && stats.dificil.early === 0 && stats.imposible.early === 0,
    'Se adelanta a veces en «Fácil» (' + stats.facil.early + ' de ' + stats.facil.rounds + ' rondas), en «Normal» ' + stats.normal.early + ', nunca en «Difícil» ni «Imposible»');
}

// ---------------------------------------------------------------- matches
function match(A) {
  A.pick();
  A.run(200, function () { const m = A.last('rmeta'); return m && m.phase === 'end'; });
  const m = A.last('rmeta');
  return { end: m.phase === 'end', winner: m.winner, scores: m.scores.slice(0, 2) };
}
function duels() {
  console.log('\n[Partidas entre niveles (al mejor de 5), 10 por pareja]');
  [['normal', 'facil'], ['dificil', 'normal'], ['imposible', 'dificil'], ['imposible', 'facil']].forEach(function (p) {
    let wins = 0, ended = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const A = arena.create({ game: GAME, seed: seed * 37 });
      A.addBot(p[0]);              // slot 2
      A.drive(Bot, p[1]);          // slot 1: the same bot, through the phone
      const r = match(A);
      if (r.end) ended++;
      if (r.winner === 2) wins++;
      A.close();
    }
    const need = p[1] === 'facil' && p[0] === 'imposible' ? 10 : 8;
    check(ended === 10 && wins >= need, '«' + LABEL[p[0]] + '» gana a «' + LABEL[p[1]] + '» ' + wins + ' de 10 partidas');
  });
}
function againstScripted() {
  console.log('\n[Contra alguien que reacciona en 300 ms]');
  const res = {};
  ['facil', 'imposible'].forEach(function (lv) {
    let botWins = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const A = arena.create({ game: GAME, seed: seed * 53 });
      A.addBot(lv);
      A.drive(scripted(300));
      if (match(A).winner === 2) botWins++;
      A.close();
    }
    res[lv] = botWins;
  });
  check(res.facil <= 2, '«Fácil» es ganable: la persona le gana ' + (10 - res.facil) + ' de 10 partidas');
  check(res.imposible >= 9, '«Imposible» le gana ' + res.imposible + ' de 10');
}

// ---------------------------------------------------------------- how it plays
function protocol() {
  console.log('\n[Juega como un móvil]');
  const A = arena.create({ game: GAME, seed: 9 });
  A.addBot('facil');
  A.drive(scripted(480));
  const r = match(A);
  check(r.end, 'La partida termina (' + r.scores.join('-') + ')');
  const types = {};
  A.sent.forEach(function (x) { types[x.msg.t] = (types[x.msg.t] || 0) + 1; });
  check(Object.keys(types).join() === 'r.tap', 'Solo manda r.tap, como el móvil (' + JSON.stringify(types) + ')');
  A.run(5);
  check(!A.sent.some(function (x) { return x.msg.t === 'r.again'; }) && A.last('rmeta').phase === 'end', 'No pulsa «Otra partida»: eso lo decide la persona');
  A.send({ t: 'r.again' });
  A.run(20);
  const m = A.last('rmeta');
  check(m.round >= 2 && m.scores.reduce(function (a, b) { return a + b; }, 0) >= 1, '«Otra» desde el móvil: el bot juega la partida nueva (ronda ' + m.round + ', ' + m.scores.slice(0, 2).join('-') + ')');
  // Back to the menu: it stops and sends nothing more
  A.send({ t: 'menu' });
  const n = A.sent.length;
  A.run(10);
  check(A.last('hub').screen === 'menu' && A.hub.botStats().running === 0 && A.sent.length === n, 'Vuelta al menú: el bot se para y no manda nada más');
  check(!A.logs.some(function (l) { return /Error/.test(l); }), 'Sin errores en el registro');
  A.close();
}

// ---------------------------------------------------------------- CPU
function cpu() {
  console.log('\n[Coste por tick]');
  const A = arena.create({ game: GAME, seed: 5 });
  A.addBot('imposible');
  A.drive(Bot, 'facil');
  A.pick();
  A.run(5);
  A.resetTiming();
  for (let k = 0; k < 120; k++) {
    A.run(1);
    if (A.last('rmeta').phase === 'end') A.send({ t: 'r.again' });
  }
  const T = A.timing();
  check(T.avgTickMs < 0.05 && T.stepWorst < 2, '120 s: ' + T.avgTickMs.toFixed(4) + ' ms por tick de media (peor paso ' + T.stepWorst.toFixed(2) + ' ms)');
  A.close();
}

reactions();
duels();
againstScripted();
protocol();
cpu();
check.done();
