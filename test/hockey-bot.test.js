'use strict';
/*
 * «Hockey de mesa»: the computer opponent (src/games/hockey/bot.js), played in
 * the real hub with a virtual clock (test/helpers/bot-arena.js), seeded:
 *   - its puck path agrees with the game's physics, and its shots leave the
 *     mallet where it aims (the game's own bounce);
 *   - it only plays with phone messages (h.m in 0..1, 3 decimals, at most
 *     ~60 per second), never presses «Otra», never touches what it receives
 *     and stops at the menu;
 *   - against a scripted player (the one test/browser-hockey.js uses: at the
 *     puck from behind, 25 times per second) «Imposible» wins and «Fácil»
 *     loses; «Fácil» still scores against a slower one;
 *   - every level beats the one below; harder levels shoot harder;
 *   - its CPU time per tick (the TV runs it): average well under 0.5 ms.
 */
const H_ = require('./helpers');
const arena = require('./helpers/bot-arena');
const Bot = require('../src/games/hockey/bot');
const Hockey = require('../src/games/hockey');
const Kit = require('../src/games/bot-kit');
const check = H_.checker('Hockey de mesa: el rival bot');

const F = Hockey.FIELD;
const P = Hockey.physics;
const LEVELS = ['facil', 'normal', 'dificil', 'imposible'];
const LABEL = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil', imposible: 'Imposible' };
const RR = F.puckR + F.malletR;
function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }

// ---------------------------------------------------------------- scripted players
// The bot of test/browser-hockey.js: a target that pushes the puck towards the other goal
function scriptTarget(side, s, stalled) {
  const px = s.p[0], py = s.p[1];
  const mx = s.m[side * 2], my = s.m[side * 2 + 1];
  const mine = side === 0 ? px < F.w / 2 + 10 : px > F.w / 2 - 10;
  const home = side === 0 ? 180 : F.w - 180;
  if (!mine || s.ph !== 'playing') return P.clampToHalf(side, home, F.h / 2 + (side === 0 ? -200 : 200));
  if (stalled) {
    const sx = px - mx, sy = py - my, sd = Math.hypot(sx, sy) || 1;
    return P.clampToHalf(side, px + sx / sd * 150, py + sy / sd * 150);
  }
  const gx = side === 0 ? F.w + 100 : -100;
  let dx = gx - px, dy = F.h / 2 - py;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  const behind = side === 0 ? mx < px - 10 : mx > px + 10;
  if (!behind) {
    const off = my < py ? -1 : 1;
    return P.clampToHalf(side, px - dx * 140, py + off * 130);
  }
  const a = P.clampToHalf(side, px - dx * 110, py - dy * 110);
  if (Math.hypot(mx - a.x, my - a.y) < 30) return P.clampToHalf(side, px + dx * 160, py + dy * 160);
  return a;
}
/** That player, thinking every `periodMs` (browser test: 40) and moving its finger at most `cap` u/s (0: no limit). */
function scripted(periodMs, cap) {
  return {
    create: function (ctx) {
      let s = null, side = 0, next = 0, stillSince = 0, hx = null, hy = 0;
      return {
        onTv: function (m) { if (m.t === 'hs') s = m; if (m.t === 'hmeta') side = m.players.indexOf(ctx.slot); },
        tick: function () {
          const now = ctx.now();
          if (!s || side < 0 || now < next) return;
          next = now + periodMs;
          if (s.ph !== 'playing' || Math.hypot(s.p[2], s.p[3]) > 120) stillSince = now;
          let b = scriptTarget(side, s, now - stillSince > 1200);
          if (cap) {
            if (hx === null) { hx = s.m[side * 2]; hy = s.m[side * 2 + 1]; }
            const dx = b.x - hx, dy = b.y - hy, d = Math.hypot(dx, dy), st = cap * periodMs / 1000;
            if (d > st) { hx += dx / d * st; hy += dy / d * st; } else { hx = b.x; hy = b.y; }
            b = { x: hx, y: hy };
          }
          const i = P.inputFromPos(side, b.x, b.y);
          ctx.send({ t: 'h.m', x: Math.round(i.x * 1000) / 1000, y: Math.round(i.y * 1000) / 1000 });
        }
      };
    }
  };
}
const DECENT = scripted(40, 0);       // as in test/browser-hockey.js
const CASUAL = scripted(100, 1200);   // slower to see and to move

/** A match: the hub's bot (slot 2) at `level` against `driver` on the human phone (slot 1). */
function match(level, driver, drvLevel, seed, maxS, onStep) {
  const A = arena.create({ game: 'hockey', seed: seed });
  A.addBot(level);
  A.drive(driver, drvLevel);
  A.pick();
  const n = Math.round((maxS || 400) * 60);
  for (let i = 0; i < n; i++) {
    A.step();
    if (onStep) onStep(A, i);
    if (A.last('hmeta').phase === 'end') break;
  }
  const m = A.last('hmeta');
  const side = m.players.indexOf(2);
  const out = { bot: m.score[side], other: m.score[1 - side], end: m.phase === 'end', secs: Math.round(A.now() - 1700000000000) / 1000 };
  A.close();
  return out;
}

// ---------------------------------------------------------------- its physics
function physics() {
  console.log('\n[Su trayectoria del disco es la del juego]');
  const random = Kit.seeded(17);
  const path = { x: new Float64Array(Bot.NMAX + 2), y: new Float64Array(Bot.NMAX + 2), vx: new Float64Array(Bot.NMAX + 2), vy: new Float64Array(Bot.NMAX + 2) };
  const errs = [], errsB = [];
  let goalsAgree = 0, goals = 0;
  for (let k = 0; k < 300; k++) {
    const w = P.newWorld();
    // Mallets parked in the far corners, out of the way
    w.mallets[0].x = w.mallets[0].tx = F.malletR; w.mallets[0].y = w.mallets[0].ty = F.malletR;
    w.mallets[1].x = w.mallets[1].tx = F.w - F.malletR; w.mallets[1].y = w.mallets[1].ty = F.malletR;
    const x = 200 + random() * (F.w - 400), y = 120 + random() * (F.h - 240);
    const a = random() * 2 * Math.PI, sp = 300 + random() * 2000;
    w.puck.x = x; w.puck.y = y; w.puck.vx = Math.cos(a) * sp; w.puck.vy = Math.sin(a) * sp;
    Bot.predict(path, x, y, w.puck.vx, w.puck.vy, 60, 9);
    let goal = -1, bounced = false, near = false;
    for (let j = 1; j < 70; j++) {
      const r = P.step(w, 1 / 60, true);
      if (r.wall) bounced = true;
      if (r.goal >= 0) { goal = r.goal; break; }
      // Near a parked mallet: no comparison from there on
      if (Math.hypot(w.puck.x - F.malletR, w.puck.y - F.malletR) < RR + 60 || Math.hypot(w.puck.x - F.w + F.malletR, w.puck.y - F.malletR) < RR + 60) near = true;
      if (near || j >= path.n || j > 60 || (path.goal >= 0 && j >= path.goalK)) continue;
      const e = Math.hypot(path.x[j] - w.puck.x, path.y[j] - w.puck.y);
      (bounced ? errsB : errs).push(e);
    }
    if (near) continue;
    if (goal >= 0 || path.goal >= 0) { goals++; if (goal === path.goal) goalsAgree++; }
  }
  errs.sort(function (p, q) { return p - q; }); errsB.sort(function (p, q) { return p - q; });
  check(errs[errs.length - 1] < 3, 'Sin rebotes, hasta 1 s vista: coincide con el juego (error máximo ' + errs[errs.length - 1].toFixed(2) + ' u: el rozamiento en pasos de 1/60 s)');
  const p95 = errsB[Math.floor(errsB.length * 0.95)];
  check(p95 < 15, 'Con rebotes (bandas y postes, que no calcula): el 95 % a menos de ' + p95.toFixed(1) + ' u (el disco mide ' + 2 * F.puckR + ')');
  check(goals > 20 && goalsAgree / goals >= 0.9, 'Prevé los goles: ' + goalsAgree + ' de ' + goals);

  // Its shots: the contact normal it computes sends the puck where it wants (the game's bounce)
  const res = {};
  let ok = 0, tried = 0, worst = 0;
  for (let k = 0; k < 400; k++) {
    const a = random() * 2 * Math.PI, sp = random() * 1500;
    const vx = Math.cos(a) * sp, vy = Math.sin(a) * sp;
    const aim = (random() * 2 - 1) * 0.9, V = 600 + random() * 2400;
    if (!Bot.shotNormal(res, vx, vy, Math.cos(aim), Math.sin(aim), V)) continue;
    tried++;
    const m = { side: 0, x: 400, y: 430, vx: res.nx * V, vy: res.ny * V };
    const p = { x: m.x + res.nx * (RR - 0.5), y: m.y + res.ny * (RR - 0.5), vx: vx, vy: vy };
    P.hitMallet(p, m);
    const err = Math.abs(Math.atan2(p.vy, p.vx) - aim);
    worst = Math.max(worst, err);
    if (err < 0.03) ok++;
  }
  check(tried > 250 && ok === tried, 'Sus tiros: con el rebote del juego el disco sale hacia donde apunta (' + ok + ' de ' + tried + ', error máximo ' + (worst * 180 / Math.PI).toFixed(2) + '°)');
}

// ---------------------------------------------------------------- how it plays
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
  return o;
}
function protocol() {
  console.log('\n[Juega como un móvil]');
  const A = arena.create({ game: 'hockey', seed: 5 });
  A.addBot('imposible');
  // The human phone: the same bot at «Difícil», seeing frozen messages (strict mode: touching one throws)
  let threw = null;
  A.drive({
    create: function (ctx) {
      const inner = Bot.create(ctx);
      return {
        onTv: function (m) { try { inner.onTv(deepFreeze(m)); } catch (e) { threw = threw || e; } },
        onSlot: function (m) { try { inner.onSlot(deepFreeze(m)); } catch (e) { threw = threw || e; } },
        tick: function (dt) { try { inner.tick(dt); } catch (e) { threw = threw || e; } },
        stop: inner.stop
      };
    }
  }, 'dificil');
  A.pick();
  A.run(60);
  check(!threw, 'No modifica los mensajes que recibe (congelados: ' + (threw ? threw.message : 'ningún error') + ')');
  const types = {};
  let legal = true;
  A.sent.forEach(function (x) {
    const m = x.msg;
    types[m.t] = (types[m.t] || 0) + 1;
    if (m.t !== 'h.m' || Object.keys(m).length !== 3) { legal = false; return; }
    [m.x, m.y].forEach(function (v) { if (!(v >= 0 && v <= 1) || Math.abs(v * 1000 - Math.round(v * 1000)) > 1e-6) legal = false; });
  });
  const st = A.hub.botStats();
  const rate = st.fromBots / 60;
  check(legal && types['h.m'] > 100, 'Solo manda h.m con x, y entre 0 y 1 y 3 decimales, como el móvil (' + JSON.stringify(types) + ')');
  check(rate <= 61, 'Como mucho ~60 mensajes por segundo (' + rate.toFixed(1) + '/s; el móvil: uno cada 15 ms como mucho)');
  check(!types['h.again'], 'No pulsa «Otra»: eso lo decide la persona');
  check(!A.logs.some(function (l) { return /Error/.test(l); }), 'Sin errores en el registro');
  // Back to the menu: it stops and sends nothing more
  A.send({ t: 'menu' });
  const n0 = A.hub.botStats().fromBots + A.hub.botStats().queued;
  A.run(3);
  const d = A.bots[0]._inner.debug();
  check(d.stopped && A.hub.botStats().running === 0 && A.hub.botStats().fromBots + A.hub.botStats().queued === n0, 'Al volver al menú se para y ya no manda nada');
  A.close();
}

// ---------------------------------------------------------------- against scripted players
function vsScripted() {
  console.log('\n[Contra el jugador con guion de la prueba del navegador (25 veces por segundo)]');
  const imp = [], easy = [];
  for (let seed = 1; seed <= 4; seed++) imp.push(match('imposible', DECENT, null, seed, 500));
  for (let seed = 1; seed <= 3; seed++) easy.push(match('facil', DECENT, null, seed, 500));
  check(imp.every(function (r) { return r.end && r.bot === 7; }), '«Imposible» le gana las 4 partidas a 7 (' + imp.map(function (r) { return r.bot + '-' + r.other; }).join(', ') + '; ' + Math.round(mean(imp.map(function (r) { return r.secs; }))) + ' s de media)');
  check(mean(imp.map(function (r) { return r.other; })) <= 1, '…y casi no le marca: ' + mean(imp.map(function (r) { return r.other; })).toFixed(1) + ' goles por partida');
  check(easy.every(function (r) { return r.end && r.other === 7; }), '«Fácil» pierde con él las 3 (' + easy.map(function (r) { return r.bot + '-' + r.other; }).join(', ') + '): se le puede ganar');
  console.log('\n[«Fácil» también marca]');
  const cas = [];
  for (let seed = 1; seed <= 3; seed++) cas.push(match('facil', CASUAL, null, seed, 400));
  const goals = cas.reduce(function (s, r) { return s + r.bot; }, 0);
  check(goals >= 3 && cas.filter(function (r) { return r.bot >= 1; }).length >= 2, '«Fácil» contra uno más lento (10 veces por segundo, dedo a 1200 u/s) marca: ' + cas.map(function (r) { return r.bot + '-' + r.other; }).join(', ') + ' (' + goals + ' goles en 3 partidas)');
}

// ---------------------------------------------------------------- duels and power
function duels() {
  console.log('\n[Duelos entre niveles (a 7, o quien va ganando a los 15 min)]');
  [['imposible', 'facil'], ['dificil', 'normal'], ['normal', 'facil'], ['imposible', 'dificil']].forEach(function (p) {
    let wins = 0, pa = 0, pb = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const r = match(p[0], Bot, p[1], seed * 101, 900);
      if (r.bot > r.other) wins++;
      pa += r.bot; pb += r.other;
    }
    check(wins === 3, '«' + LABEL[p[0]] + '» gana a «' + LABEL[p[1]] + '» los 3 duelos (' + pa + '-' + pb + ' en goles)');
  });
}
function power() {
  console.log('\n[Más fuerte cuanto más difícil]');
  const speeds = {};
  LEVELS.forEach(function (lv) {
    speeds[lv] = [];
    // After each of its swings: its hit, and the puck speed 3 ticks later
    let last = null, swingAt = -1, hitAt = -1, nEv = 0;
    match(lv, DECENT, null, 9, 90, function (A, i) {
      const d = A.bots[0]._inner.debug();
      if (d.lastShot && d.lastShot !== last) { last = d.lastShot; swingAt = i; hitAt = -1; }
      const evs = A.events('ev');
      for (; nEv < evs.length; nEv++) if (evs[nEv].k === 'hit' && evs[nEv].slot === 2 && swingAt >= 0 && i - swingAt < 20) { hitAt = i; swingAt = -1; }
      if (hitAt >= 0 && i - hitAt === 3) {
        const s = A.last('hs');
        speeds[lv].push(Math.hypot(s.p[2], s.p[3]));
        hitAt = -1;
      }
    });
  });
  const m = {};
  LEVELS.forEach(function (lv) { m[lv] = mean(speeds[lv]); });
  check(m.facil < m.normal && m.normal < m.dificil && m.dificil <= m.imposible + 50 && m.facil < 0.75 * m.imposible,
    'Velocidad media del disco tras sus tiros: ' + LEVELS.map(function (lv) { return LABEL[lv] + ' ' + Math.round(m[lv]) + ' u/s (' + speeds[lv].length + ')'; }).join(' · '));
}

// ---------------------------------------------------------------- CPU
function cpu() {
  console.log('\n[Coste por tick (la tele lo ejecuta)]');
  const A = arena.create({ game: 'hockey', seed: 5 });
  A.addBot('imposible');
  A.drive(Bot, 'dificil');
  A.pick();
  A.run(15);              // warm up (JIT)
  A.resetTiming();
  let matches = 0;
  for (let k = 0; k < 150; k++) {
    A.run(1);
    if (A.last('hmeta').phase === 'end') { A.send({ t: 'h.again' }); matches++; }
  }
  const T = A.timing();
  console.log('    (' + matches + ' partidas terminadas; ' + T.calls + ' llamadas al bot; la llamada más lenta ' + T.worst.toFixed(2) + ' ms)');
  check(T.avgTickMs < 0.5, '«Imposible» contra «Difícil», 150 s: ' + T.avgTickMs.toFixed(4) + ' ms por tick de media (límite 0,5 ms; peor tick ' + T.stepWorst.toFixed(2) + ' ms, ' + T.over1 + ' de ' + T.steps + ' por encima de 1 ms)');
  check(T.over1 / T.steps < 0.01, 'Menos del 1 % de los ticks pasa de 1 ms (los que pasan suelen ser pausas del recolector de basura o de la máquina)');
  A.close();
}

physics();
protocol();
vsScripted();
duels();
power();
cpu();
check.done();
